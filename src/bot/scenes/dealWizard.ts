import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';
import { updateGroupProposalMessage } from '../utils/groupMessage';
import { mainKeyboard } from '../utils/keyboards';

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
          `📝 **تایید نهایی معامله (کل مقدار با قیمت اصلی):**\n\n` +
          `🔹 **نوع تراکنش:** ${proposal.type === 'BUY' ? '🟢 خرید ارز' : '🔴 فروش ارز'}\n` +
          `🔹 **ارز:** <code>${proposal.currency}</code>\n` +
          `🔹 **مقدار معامله:** <code>${proposal.amount.toLocaleString('fa-IR')}</code>\n` +
          `🔹 **قیمت واحد:** <code>${proposal.price.toLocaleString('fa-IR')}</code> تومان\n` +
          `🔹 **مبلغ کل معامله:** <code>${total.toLocaleString('fa-IR')}</code> تومان\n` +
          `👤 **ثبت‌کننده آگهی:** ${proposal.creator.username ? '@' + proposal.creator.username : proposal.creator.firstName}\n\n` +
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
          `📋 **درخواست معامله برای پیشنهاد #${proposal.id}**\n\n` +
          `🔹 **نوع تراکنش:** ${proposal.type === 'BUY' ? '🟢 خرید ارز' : '🔴 فروش ارز'}\n` +
          `🔹 **ارز:** <code>${proposal.currency}</code>\n` +
          `🔹 **مقدار موجود:** <code>${proposal.amount.toLocaleString('fa-IR')}</code>\n` +
          `🔹 **قیمت پایه واحد:** <code>${proposal.price.toLocaleString('fa-IR')}</code> تومان\n\n` +
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
          const freshProposal = await tx.proposal.findUnique({
            where: { id: proposalId },
            include: { creator: true }
          });
          
          if (!freshProposal || freshProposal.status !== 'PENDING') {
            throw new Error('PROPOSAL_NOT_PENDING');
          }
          
          if (amount > freshProposal.amount) {
            throw new Error('INSUFFICIENT_AMOUNT');
          }
          
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
          
          // Determine status based on remaining amount
          const remainingAmount = freshProposal.amount - amount;
          let updatedProposal;
          if (remainingAmount <= 0.0001) {
            updatedProposal = await tx.proposal.update({
              where: { id: freshProposal.id },
              data: { amount: 0, status: 'LOCKED' },
              include: { creator: true }
            });
          } else {
            updatedProposal = await tx.proposal.update({
              where: { id: freshProposal.id },
              data: { amount: remainingAmount }, // status remains PENDING
              include: { creator: true }
            });
          }
          
          return { deal, proposal: updatedProposal, acceptor };
        });
        
        const { proposal: updatedProposal, acceptor, deal } = result;
        const totalValue = amount * proposal.price;
        
        // Notify Creator
        const creatorMsg = 
          `🔔 **درخواست معامله مستقیم ثبت شد!**\n\n` +
          `🔹 **جزئیات:** مقدار <code>${amount.toLocaleString('fa-IR')}</code> ${proposal.currency} با قیمت واحد ${proposal.price.toLocaleString('fa-IR')} تومان (کل: ${totalValue.toLocaleString('fa-IR')} تومان)\n\n` +
          `🔒 این معامله در انتظار تایید نهایی مدیریت (Escrow) است. پس از تایید مدیریت، اطلاعات هماهنگی برای شما ارسال خواهد شد.`;
          
        await ctx.telegram.sendMessage(proposal.creator.telegramId, creatorMsg, { parse_mode: 'HTML' })
          .catch(err => console.error('Failed to notify creator:', err));
          
        // Notify Acceptor
        const acceptorMsg = 
          `✅ **درخواست معامله با موفقیت ثبت شد.**\n\n` +
          `🔹 **جزئیات:** مقدار <code>${amount.toLocaleString('fa-IR')}</code> ${proposal.currency} با قیمت واحد ${proposal.price.toLocaleString('fa-IR')} تومان (کل: ${totalValue.toLocaleString('fa-IR')} تومان)\n\n` +
          `🔒 معامله در انتظار تایید نهایی مدیریت است. پس از بررسی و تایید توسط مدیریت، به شما اطلاع‌رسانی خواهد شد.`;
          
        await ctx.reply(acceptorMsg, { parse_mode: 'HTML', ...mainKeyboard });
        
        // Notify Admin with Accept/Reject Buttons
        const creatorContact = proposal.creator.username 
          ? `@${proposal.creator.username}` 
          : `[${proposal.creator.firstName}](tg://user?id=${proposal.creator.telegramId})`;
        const acceptorContact = acceptor.username 
          ? `@${acceptor.username}` 
          : `[${acceptor.firstName}](tg://user?id=${acceptor.telegramId})`;
          
        const adminMsg = 
          `🔔 **درخواست معامله مستقیم جدید (نیاز به تایید ادمین)**\n\n` +
          `📈 **جزئیات معامله:**\n` +
          `🔹 **نوع:** ${proposal.type === 'BUY' ? 'خرید' : 'فروش'}\n` +
          `🔹 **ارز:** ${proposal.currency}\n` +
          `🔹 **مقدار معامله:** ${amount.toLocaleString('fa-IR')}\n` +
          `🔹 **قیمت واحد:** ${proposal.price.toLocaleString('fa-IR')} تومان\n` +
          `🔹 **مبلغ کل:** ${totalValue.toLocaleString('fa-IR')} تومان\n\n` +
          `👤 **سازنده پیشنهاد (Creator):**\n` +
          `   - نام: ${proposal.creator.firstName} ${proposal.creator.lastName || ''}\n` +
          `   - یوزرنیم: ${creatorContact}\n` +
          `   - آیدی تلگرام: \`${proposal.creator.telegramId}\`\n\n` +
          `👤 **پذیرنده مستقیم (Acceptor):**\n` +
          `   - نام: ${acceptor.firstName} ${acceptor.lastName || ''}\n` +
          `   - یوزرنیم: ${acceptorContact}\n` +
          `   - آیدی تلگرام: \`${acceptor.telegramId}\``;
          
        await ctx.telegram.sendMessage(config.ADMIN_CHAT_ID, adminMsg, {
          parse_mode: 'Markdown',
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
          where: { proposalId: proposalId },
          orderBy: { createdAt: 'asc' }
        });
        
        let promptText = `✍️ **ثبت پیشنهاد قیمت جدید برای تراکنش #${proposal.id}**\n\n` +
          `🔹 **نوع تراکنش:** ${proposal.type === 'BUY' ? '🟢 خرید ارز' : '🔴 فروش ارز'}\n` +
          `🔹 **ارز:** <code>${proposal.currency}</code>\n` +
          `🔹 **مقدار انتخابی شما:** <code>${amount.toLocaleString('fa-IR')}</code>\n` +
          `🔹 **قیمت اولیه ثبت‌کننده:** <code>${proposal.price.toLocaleString('fa-IR')}</code> تومان\n`;
          
        if (firstOffer) {
          promptText += `⚠️ اولین پیشنهاد قیمت ثبت‌شده: <code>${firstOffer.price.toLocaleString('fa-IR')}</code> تومان\n`;
          if (proposal.type === 'BUY') {
            promptText += `📌 بر اساس قوانین، پیشنهاد شما **نباید بیشتر از** اولین پیشنهاد (<code>${firstOffer.price.toLocaleString('fa-IR')}</code> تومان) باشد (جهت جلب رضایت خریدار).\n`;
          } else {
            promptText += `📌 بر اساس قوانین، پیشنهاد شما **نباید کمتر از** اولین پیشنهاد (<code>${firstOffer.price.toLocaleString('fa-IR')}</code> تومان) باشد (جهت جلب رضایت فروشنده).\n`;
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
        
        // Enforce that proposed price does not exceed the ad's price
        if (price > proposal.price) {
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
        const proposerName = counterOffer.proposer.username 
          ? `@${counterOffer.proposer.username}` 
          : `<a href="tg://user?id=${counterOffer.proposer.telegramId}">${counterOffer.proposer.firstName}</a>`;
          
        const creatorMsg = 
          `🔔 <b>پیشنهاد قیمت و مقدار جدید برای آگهی #${proposal.id} شما ثبت شده است:</b>\n\n` +
          `🔹 **ارز:** <code>${proposal.currency}</code>\n` +
          `🔹 **مقدار درخواستی:** <code>${amount.toLocaleString('fa-IR')}</code> (از کل ${proposal.amount.toLocaleString('fa-IR')} موجود)\n` +
          `🔹 **قیمت اولیه شما:** <code>${proposal.price.toLocaleString('fa-IR')}</code> تومان\n` +
          `💵 **قیمت پیشنهادی جدید:** <code>${price.toLocaleString('fa-IR')}</code> تومان\n` +
          `👤 **توسط:** ${proposerName}\n\n` +
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
