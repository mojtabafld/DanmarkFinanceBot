import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';
import { updateGroupProposalMessage } from '../utils/groupMessage';
import { AMOUNT_EPSILON } from '../utils/amounts';
import { mainKeyboard } from '../utils/keyboards';
import { escapeHtml, mentionUser } from '../utils/html';

export const ACCEPT_DEAL_SCENE_ID = 'ACCEPT_DEAL_SCENE';

interface DealWizardState {
  proposalId?: number;
  mode?: 'DIRECT' | 'CUSTOM';
  amount?: number;
  price?: number;
}

export interface MyDealWizardContext extends Scenes.WizardContext {
  wizard: Scenes.WizardContext['wizard'] & {
    state: DealWizardState;
  };
}

export const acceptDealWizard = new Scenes.WizardScene<MyDealWizardContext>(
  ACCEPT_DEAL_SCENE_ID,
  
  // Step 1: Prompt for quantity (Full vs. Custom) or show final confirmation for DIRECT
  async (ctx) => {
    const state = ctx.scene.state as DealWizardState;
    ctx.wizard.state.proposalId = state.proposalId;
    ctx.wizard.state.mode = state.mode;
    
    const proposalId = state.proposalId;
    if (!proposalId) {
      await ctx.reply('❌ اطلاعات پیشنهاد نامعتبر است.', mainKeyboard);
      return ctx.scene.leave();
    }
    
    try {
      const from = ctx.from;
      if (!from) return ctx.scene.leave();
      
      const dbUser = await prisma.user.findUnique({
        where: { telegramId: from.id.toString() }
      });
      
      if (!dbUser || dbUser.verificationStatus !== 'APPROVED') {
        await ctx.reply('⚠️ جهت شرکت در معاملات ابتدا باید احراز هویت شده باشید.', mainKeyboard);
        return ctx.scene.leave();
      }
      
      const proposal = await prisma.proposal.findUnique({
        where: { id: proposalId },
        include: { creator: true }
      });
      
      if (!proposal) {
        await ctx.reply('❌ پیشنهاد یافت نشد.', mainKeyboard);
        return ctx.scene.leave();
      }
      
      if (proposal.status !== 'PENDING') {
        await ctx.reply('⚠️ این پیشنهاد دیگر فعال نیست.', mainKeyboard);
        return ctx.scene.leave();
      }
      
      if (proposal.creator.telegramId === from.id.toString()) {
        await ctx.reply('⚠️ شما نمی‌توانید برای پیشنهاد خودتان اقدام کنید!', mainKeyboard);
        return ctx.scene.leave();
      }
      
      if (state.mode === 'DIRECT') {
        const total = proposal.amount * proposal.price;
        const detailText =
          `📝 <b>تایید نهایی معامله (کل مقدار با قیمت اصلی):</b>\n\n` +
          `🔹 <b>نوع تراکنش:</b> ${proposal.type === 'BUY' ? '🟢 خرید ارز' : '🔴 فروش ارز'}\n` +
          `🔹 <b>ارز:</b> <code>${escapeHtml(proposal.currency)}</code>\n` +
          `🔹 <b>مقدار معامله:</b> <code>${proposal.amount.toLocaleString('fa-IR')}</code>\n` +
          `🔹 <b>قیمت واحد:</b> <code>${proposal.price.toLocaleString('fa-IR')}</code> تومان\n` +
          `🔹 <b>مبلغ کل معامله:</b> <code>${total.toLocaleString('fa-IR')}</code> تومان\n` +
          `👤 <b>ثبت‌کننده آگهی:</b> ${escapeHtml(proposal.creator.username ? '@' + proposal.creator.username : proposal.creator.firstName)}\n\n` +
          `❓ آیا این معامله را تایید و ارسال می‌کنید؟\n\n` +
          `⚠️ با تایید معامله، معامله ثبت شده و پس از تایید اولیه ادمین، فلو پرداخت آغاز خواهد شد.`;

        await ctx.reply(detailText, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ تایید و ارسال معامله', 'CONFIRM_DIRECT_DEAL'),
              Markup.button.callback('❌ انصراف', 'CANCEL_DEAL')
            ]
          ])
        });
        
        ctx.wizard.state.amount = proposal.amount;
        ctx.wizard.state.price = proposal.price;
        return ctx.wizard.next();
      } else {
        const promptText = 
          `📋 <b>درخواست معامله برای پیشنهاد #${proposal.id}</b>\n\n` +
          `🔹 <b>نوع تراکنش:</b> ${proposal.type === 'BUY' ? '🟢 خرید ارز' : '🔴 فروش ارز'}\n` +
          `🔹 <b>ارز:</b> <code>${escapeHtml(proposal.currency)}</code>\n` +
          `🔹 <b>مقدار موجود:</b> <code>${proposal.amount.toLocaleString('fa-IR')}</code>\n` +
          `🔹 <b>قیمت پایه واحد:</b> <code>${proposal.price.toLocaleString('fa-IR')}</code> تومان\n\n` +
          `❓ آیا مایلید کل مقدار موجود (<code>${proposal.amount.toLocaleString('fa-IR')}</code>) را معامله کنید یا مقدار مشخصی از آن را؟`;
          
        await ctx.reply(promptText, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`✅ کل مقدار موجود (${proposal.amount.toLocaleString('fa-IR')})`, 'QTY_FULL')],
            [Markup.button.callback('🔢 درخواست مقدار مشخص', 'QTY_PARTIAL')],
            [Markup.button.callback('❌ انصراف', 'CANCEL_DEAL')]
          ])
        });
        
        return ctx.wizard.next();
      }
      
    } catch (err) {
      console.error('Error in deal wizard step 1:', err);
      await ctx.reply('❌ خطایی رخ داد.', mainKeyboard);
      return ctx.scene.leave();
    }
  },
  
  // Step 2: Handle quantity selection / custom prompt or direct deal confirmation
  async (ctx) => {
    const proposalId = ctx.wizard.state.proposalId;
    const mode = ctx.wizard.state.mode;
    if (!proposalId) {
      await ctx.reply('❌ اطلاعات پیشنهاد نامعتبر است.', mainKeyboard);
      return ctx.scene.leave();
    }
    
    const proposal = await prisma.proposal.findUnique({
      where: { id: proposalId }
    });
    if (!proposal || proposal.status !== 'PENDING') {
      await ctx.reply('⚠️ پیشنهاد دیگر فعال نیست.', mainKeyboard);
      return ctx.scene.leave();
    }
    
    // Check if it's a callback query
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      await ctx.answerCbQuery();
      
      if (data === 'CANCEL_DEAL') {
        await ctx.reply('❌ عملیات لغو شد.', mainKeyboard);
        return ctx.scene.leave();
      }

      if (data === 'CONFIRM_DIRECT_DEAL') {
        if (mode === 'DIRECT') {
          ctx.wizard.state.amount = proposal.amount;
          // Jump directly to Step 3 (index 2 in wizard steps)
          ctx.wizard.selectStep(2);
          return (ctx.wizard as any).steps[2](ctx);
        }
      }
      
      if (data === 'QTY_FULL') {
        ctx.wizard.state.amount = proposal.amount;
        // Jump directly to Step 3 (index 2 in wizard steps)
        ctx.wizard.selectStep(2);
        return (ctx.wizard as any).steps[2](ctx);
      }
      
      if (data === 'QTY_PARTIAL') {
        await ctx.reply(
          `لطفاً مقدار ارز درخواستی خود را به صورت عدد انگلیسی وارد کنید (حداکثر تا ${proposal.amount.toLocaleString('fa-IR')}):`,
          Markup.keyboard([['❌ انصراف']]).resize().oneTime()
        );
        return; // Wait for user's text input in this step
      }
    }
    
    // Check if it's text input for custom quantity
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === '❌ انصراف' || text === '/cancel') {
        await ctx.reply('❌ عملیات لغو شد.', mainKeyboard);
        return ctx.scene.leave();
      }

      if (mode === 'DIRECT') {
        await ctx.reply('لطفاً یکی از گزینه‌های بالا را انتخاب کنید.');
        return;
      }
      
      const amount = parseFloat(text.replace(/,/g, ''));
      if (isNaN(amount) || amount <= 0) {
        await ctx.reply('⚠️ لطفاً یک عدد بزرگتر از صفر وارد کنید:');
        return;
      }
      
      if (amount > proposal.amount) {
        await ctx.reply(`⚠️ مقدار وارد شده نمی‌تواند بیشتر از مقدار موجود در پیشنهاد (${proposal.amount.toLocaleString('fa-IR')}) باشد. لطفاً مجدداً وارد کنید:`);
        return;
      }
      
      ctx.wizard.state.amount = amount;
      // Jump directly to Step 3
      ctx.wizard.selectStep(2);
      return (ctx.wizard as any).steps[2](ctx);
    }
    
    await ctx.reply('لطفاً یکی از گزینه‌های بالا را انتخاب کنید یا مقدار معتبری بنویسید.');
  },
  
  // Step 3: Handle pricing choice
  async (ctx) => {
    const proposalId = ctx.wizard.state.proposalId;
    const mode = ctx.wizard.state.mode;
    const amount = ctx.wizard.state.amount;
    
    if (!proposalId || !amount || !mode) {
      await ctx.reply('❌ اطلاعات مورد نیاز یافت نشد.', mainKeyboard);
      return ctx.scene.leave();
    }
    
    try {
      const proposal = await prisma.proposal.findUnique({
        where: { id: proposalId },
        include: { creator: true }
      });
      if (!proposal || proposal.status !== 'PENDING') {
        await ctx.reply('⚠️ پیشنهاد دیگر فعال نیست.', mainKeyboard);
        return ctx.scene.leave();
      }
      
      // If mode is DIRECT, execute the deal directly with amount and original price!
      if (mode === 'DIRECT') {
        const from = ctx.from;
        if (!from) return ctx.scene.leave();
        
        ctx.wizard.state.price = proposal.price;
        
        // Execute deal direct in a transaction
        const result = await prisma.$transaction(async (tx) => {
          // Decrement inside the WHERE clause so the sufficiency check and the
          // subtraction are a single atomic statement. Reading the row, subtracting
          // in JS and writing back let two concurrent acceptances both pass the
          // check under the default read-committed isolation, overselling the ad.
          const claimed = await tx.proposal.updateMany({
            where: { id: proposalId, status: 'PENDING', amount: { gte: amount } },
            data: { amount: { decrement: amount } }
          });

          if (claimed.count !== 1) {
            const current = await tx.proposal.findUnique({ where: { id: proposalId } });
            if (!current || current.status !== 'PENDING') {
              throw new Error('PROPOSAL_NOT_PENDING');
            }
            throw new Error('INSUFFICIENT_AMOUNT');
          }

          const freshProposal = await tx.proposal.findUniqueOrThrow({
            where: { id: proposalId },
            include: { creator: true }
          });

          const acceptor = await tx.user.upsert({
            where: { telegramId: from.id.toString() },
            update: {
              username: from.username || null,
              firstName: from.first_name,
              lastName: from.last_name || null,
            },
            create: {
              telegramId: from.id.toString(),
              username: from.username || null,
              firstName: from.first_name,
              lastName: from.last_name || null,
            }
          });
          
          // Create Pending Admin Deal (Locked temporarily)
          const deal = await tx.deal.create({
            data: {
              proposalId: freshProposal.id,
              acceptorId: acceptor.id,
              status: 'PENDING_ADMIN',
              amount: amount
            }
          });
          
          // The amount was already decremented atomically above; all that is left is
          // to lock the ad once nothing meaningful remains on it.
          let updatedProposal = freshProposal;
          if (freshProposal.amount <= AMOUNT_EPSILON) {
            updatedProposal = await tx.proposal.update({
              where: { id: freshProposal.id },
              data: { amount: 0, status: 'LOCKED' },
              include: { creator: true }
            });
          }

          return { deal, proposal: updatedProposal, acceptor };
        });
        
        const { proposal: updatedProposal, acceptor, deal } = result;
        const totalValue = amount * proposal.price;
        
        // Notify Creator
        const creatorMsg = 
          `🔔 <b>درخواست معامله مستقیم ثبت شد!</b>\n\n` +
          `🔹 <b>جزئیات:</b> مقدار <code>${amount.toLocaleString('fa-IR')}</code> ${escapeHtml(proposal.currency)} با قیمت واحد ${proposal.price.toLocaleString('fa-IR')} تومان (کل: ${totalValue.toLocaleString('fa-IR')} تومان)\n\n` +
          `🔒 این معامله در انتظار تایید نهایی مدیریت (Escrow) است. پس از تایید مدیریت، اطلاعات هماهنگی برای شما ارسال خواهد شد.`;
          
        await ctx.telegram.sendMessage(proposal.creator.telegramId, creatorMsg, { parse_mode: 'HTML' })
          .catch(err => console.error('Failed to notify creator:', err));
          
        // Notify Acceptor
        const acceptorMsg = 
          `✅ <b>درخواست معامله با موفقیت ثبت شد.</b>\n\n` +
          `🔹 <b>جزئیات:</b> مقدار <code>${amount.toLocaleString('fa-IR')}</code> ${escapeHtml(proposal.currency)} با قیمت واحد ${proposal.price.toLocaleString('fa-IR')} تومان (کل: ${totalValue.toLocaleString('fa-IR')} تومان)\n\n` +
          `🔒 معامله در انتظار تایید نهایی مدیریت است. پس از بررسی و تایید توسط مدیریت، به شما اطلاع‌رسانی خواهد شد.`;
          
        await ctx.reply(acceptorMsg, { parse_mode: 'HTML', ...mainKeyboard });
        
        // Notify Admin with Accept/Reject Buttons
        const creatorContact = mentionUser(proposal.creator);
        const acceptorContact = mentionUser(acceptor);
          
        const adminMsg = 
          `🔔 <b>درخواست معامله مستقیم جدید (نیاز به تایید ادمین)</b>\n\n` +
          `📈 <b>جزئیات معامله:</b>\n` +
          `🔹 <b>نوع:</b> ${proposal.type === 'BUY' ? 'خرید' : 'فروش'}\n` +
          `🔹 <b>ارز:</b> ${escapeHtml(proposal.currency)}\n` +
          `🔹 <b>مقدار معامله:</b> ${amount.toLocaleString('fa-IR')}\n` +
          `🔹 <b>قیمت واحد:</b> ${proposal.price.toLocaleString('fa-IR')} تومان\n` +
          `🔹 <b>مبلغ کل:</b> ${totalValue.toLocaleString('fa-IR')} تومان\n\n` +
          `👤 <b>سازنده پیشنهاد (Creator):</b>\n` +
          `   - نام: ${escapeHtml(proposal.creator.firstName)} ${escapeHtml(proposal.creator.lastName || '')}\n` +
          `   - یوزرنیم: ${creatorContact}\n` +
          `   - آیدی تلگرام: <code>${proposal.creator.telegramId}</code>\n\n` +
          `👤 <b>پذیرنده مستقیم (Acceptor):</b>\n` +
          `   - نام: ${escapeHtml(acceptor.firstName)} ${escapeHtml(acceptor.lastName || '')}\n` +
          `   - یوزرنیم: ${acceptorContact}\n` +
          `   - آیدی تلگرام: <code>${acceptor.telegramId}</code>`;
          
        await ctx.telegram.sendMessage(config.ADMIN_CHAT_ID, adminMsg, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ تایید نهایی معامله', `ADMIN_DEAL_APPROVE_${deal.id}`),
              Markup.button.callback('❌ رد معامله', `ADMIN_DEAL_REJECT_${deal.id}`)
            ]
          ])
        }).catch(err => console.error('Failed to notify admin:', err));
          
        // Update group message
        await updateGroupProposalMessage(ctx.telegram, proposal.id);
        return ctx.scene.leave();
      }
      
      // If mode is CUSTOM, prompt for custom price per unit
      if (mode === 'CUSTOM') {
        const firstOffer = await prisma.counterOffer.findFirst({
          where: {
            proposalId: proposalId,
            createdAt: {
              gt: proposal.editedAt ?? new Date(0)
            }
          },
          orderBy: { createdAt: 'asc' }
        });
        
        let promptText = `✍️ <b>ثبت پیشنهاد قیمت جدید برای تراکنش #${proposal.id}</b>\n\n` +
          `🔹 <b>نوع تراکنش:</b> ${proposal.type === 'BUY' ? '🟢 خرید ارز' : '🔴 فروش ارز'}\n` +
          `🔹 <b>ارز:</b> <code>${escapeHtml(proposal.currency)}</code>\n` +
          `🔹 <b>مقدار انتخابی شما:</b> <code>${amount.toLocaleString('fa-IR')}</code>\n` +
          `🔹 <b>قیمت اولیه ثبت‌کننده:</b> <code>${proposal.price.toLocaleString('fa-IR')}</code> تومان\n`;
          
        if (firstOffer) {
          promptText += `⚠️ اولین پیشنهاد قیمت ثبت‌شده: <code>${firstOffer.price.toLocaleString('fa-IR')}</code> تومان\n`;
          if (proposal.type === 'BUY') {
            promptText += `📌 بر اساس قوانین، پیشنهاد شما <b>نباید بیشتر از</b> اولین پیشنهاد (<code>${firstOffer.price.toLocaleString('fa-IR')}</code> تومان) باشد (جهت جلب رضایت خریدار).\n`;
          } else {
            promptText += `📌 بر اساس قوانین، پیشنهاد شما <b>نباید کمتر از</b> اولین پیشنهاد (<code>${firstOffer.price.toLocaleString('fa-IR')}</code> تومان) باشد (جهت جلب رضایت فروشنده).\n`;
          }
        } else {
          promptText += `📌 این اولین پیشنهاد قیمت جدید برای این آگهی است و مبنای قیمت‌گذاری بعدی خواهد شد.\n`;
        }
        
        promptText += `\nلطفاً قیمت پیشنهادی خود را به تومان (عدد انگلیسی) وارد کنید:`;
        
        await ctx.reply(promptText, {
          parse_mode: 'HTML',
          ...Markup.keyboard([['❌ انصراف']]).resize().oneTime()
        });
        
        return ctx.wizard.next();
      }
      
    } catch (error: any) {
      console.error('Error in step 3 deal wizard:', error);
      if (error.message === 'PROPOSAL_NOT_PENDING') {
        await ctx.reply('⚠️ متاسفانه پیشنهاد دیگر فعال نیست.', mainKeyboard);
      } else if (error.message === 'INSUFFICIENT_AMOUNT') {
        await ctx.reply('⚠️ مقدار درخواستی شما بیشتر از مقدار باقیمانده پیشنهاد است.', mainKeyboard);
      } else {
        await ctx.reply('❌ خطایی رخ داد.', mainKeyboard);
      }
      return ctx.scene.leave();
    }
  },
  
  // Step 4: Handle custom price input (Only for mode === CUSTOM)
  async (ctx) => {
    const proposalId = ctx.wizard.state.proposalId;
    const amount = ctx.wizard.state.amount;
    
    if (!proposalId || !amount) {
      await ctx.reply('❌ اطلاعات پیشنهاد نامعتبر است.', mainKeyboard);
      return ctx.scene.leave();
    }
    
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === '❌ انصراف' || text === '/cancel') {
        await ctx.reply('❌ عملیات ثبت پیشنهاد قیمت لغو شد.', mainKeyboard);
        return ctx.scene.leave();
      }
      
      const price = parseFloat(text.replace(/,/g, ''));
      if (isNaN(price) || price <= 0) {
        await ctx.reply('⚠️ لطفا یک عدد بزرگتر از صفر وارد کنید:');
        return;
      }
      
      try {
        const proposal = await prisma.proposal.findUnique({
          where: { id: proposalId },
          include: { creator: true }
        });
        
        if (!proposal || proposal.status !== 'PENDING') {
          await ctx.reply('⚠️ متاسفانه این پیشنهاد دیگر فعال نیست.', mainKeyboard);
          return ctx.scene.leave();
        }
        
        if (amount > proposal.amount) {
          await ctx.reply(`⚠️ مقدار درخواستی شما (${amount}) بیشتر از مقدار باقیمانده (${proposal.amount}) است.`, mainKeyboard);
          return ctx.scene.leave();
        }
        
        // Enforce that proposed price does not exceed the ad's price (Only for SELL ads, as BUY ads can have higher offers)
        if (proposal.type === 'SELL' && price > proposal.price) {
          await ctx.reply(`⚠️ قیمت پیشنهادی شما (${price.toLocaleString('fa-IR')} تومان) نباید بیشتر از قیمت ثبت شده در آگهی اصلی (${proposal.price.toLocaleString('fa-IR')} تومان) باشد. لطفا مجددا وارد کنید:`);
          return;
        }

        // Find the first offer registered AFTER the last edit date/time
        const firstOffer = await prisma.counterOffer.findFirst({
          where: {
            proposalId: proposalId,
            createdAt: {
              gt: proposal.editedAt ?? new Date(0)
            }
          },
          orderBy: { createdAt: 'asc' }
        });
        
        // Enforce pricing constraints based on the first offer after edit
        if (firstOffer) {
          if (proposal.type === 'BUY' && price > firstOffer.price) {
            await ctx.reply(`⚠️ قیمت پیشنهادی شما برای فروش ارز نباید بیشتر از اولین پیشنهاد پس از ویرایش (${firstOffer.price.toLocaleString('fa-IR')} تومان) باشد. لطفا مجددا وارد کنید:`);
            return;
          }
          if (proposal.type === 'SELL' && price < firstOffer.price) {
            await ctx.reply(`⚠️ قیمت پیشنهادی شما برای خرید ارز نباید کمتر از اولین پیشنهاد پس از ویرایش (${firstOffer.price.toLocaleString('fa-IR')} تومان) باشد. لطفا مجددا وارد کنید:`);
            return;
          }
        }
        
        const from = ctx.from;
        if (!from) return ctx.scene.leave();
        
        const dbUser = await prisma.user.findUnique({
          where: { telegramId: from.id.toString() }
        });
        
        if (!dbUser) return ctx.scene.leave();
        
        // Save the counter offer in database
        const counterOffer = await prisma.counterOffer.create({
          data: {
            proposalId: proposalId,
            proposerId: dbUser.id,
            price: price,
            amount: amount,
            status: 'PENDING'
          },
          include: { proposer: true }
        });
        
        await ctx.reply('✅ پیشنهاد قیمت شما با موفقیت ثبت شد و به اطلاع سازنده رسید.', mainKeyboard);
        
        // Notify the creator privately
        const proposerName = mentionUser(counterOffer.proposer);
          
        const creatorMsg = 
          `🔔 <b>پیشنهاد قیمت و مقدار جدید برای آگهی #${proposal.id} شما ثبت شده است:</b>\n\n` +
          `🔹 <b>ارز:</b> <code>${escapeHtml(proposal.currency)}</code>\n` +
          `🔹 <b>مقدار درخواستی:</b> <code>${amount.toLocaleString('fa-IR')}</code> (از کل ${proposal.amount.toLocaleString('fa-IR')} موجود)\n` +
          `🔹 <b>قیمت اولیه شما:</b> <code>${proposal.price.toLocaleString('fa-IR')}</code> تومان\n` +
          `💵 <b>قیمت پیشنهادی جدید:</b> <code>${price.toLocaleString('fa-IR')}</code> تومان\n` +
          `👤 <b>توسط:</b> ${proposerName}\n\n` +
          `❓ آیا این پیشنهاد را می‌پذیرید؟`;
          
        await ctx.telegram.sendMessage(proposal.creator.telegramId, creatorMsg, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ پذیرش پیشنهاد قیمت', `OFFER_ACCEPT_${counterOffer.id}`),
              Markup.button.callback('❌ رد پیشنهاد قیمت', `OFFER_REJECT_${counterOffer.id}`)
            ]
          ])
        }).catch(err => console.error('Failed to send counter offer notification to creator:', err));
        
        // Update the group card to show the list of offers
        await updateGroupProposalMessage(ctx.telegram, proposalId);
        
      } catch (error) {
        console.error('Error saving counter offer:', error);
        await ctx.reply('❌ خطا در ذخیره پیشنهاد قیمت.', mainKeyboard);
      }
      
      return ctx.scene.leave();
    }
    
    await ctx.reply('لطفاً قیمت پیشنهادی را به صورت عدد ارسال کنید یا انصراف دهید.');
  }
);
