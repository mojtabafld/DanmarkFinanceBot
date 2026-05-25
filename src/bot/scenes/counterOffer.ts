import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';
import { updateGroupProposalMessage } from '../utils/groupMessage';

export const COUNTER_OFFER_SCENE_ID = 'COUNTER_OFFER_SCENE';

interface CounterOfferState {
  proposalId?: number;
}

export interface MyCounterOfferContext extends Scenes.WizardContext {
  wizard: Scenes.WizardContext['wizard'] & {
    state: CounterOfferState;
  };
}

export const counterOfferWizard = new Scenes.WizardScene<MyCounterOfferContext>(
  COUNTER_OFFER_SCENE_ID,
  
  // Step 1: Prompt user for price and show rules
  async (ctx) => {
    const state = ctx.scene.state as CounterOfferState;
    ctx.wizard.state.proposalId = state.proposalId;
    const proposalId = state.proposalId;
    
    if (!proposalId) {
      await ctx.reply('❌ اطلاعات پیشنهاد نامعتبر است.');
      return ctx.scene.leave();
    }
    
    try {
      const from = ctx.from;
      if (!from) return ctx.scene.leave();
      
      const dbUser = await prisma.user.findUnique({
        where: { telegramId: from.id.toString() }
      });
      
      if (!dbUser || dbUser.verificationStatus !== 'APPROVED') {
        await ctx.reply('⚠️ جهت شرکت در معاملات ابتدا باید احراز هویت شده باشید.');
        return ctx.scene.leave();
      }
      
      const proposal = await prisma.proposal.findUnique({
        where: { id: proposalId },
        include: { creator: true }
      });
      
      if (!proposal) {
        await ctx.reply('❌ پیشنهاد یافت نشد.');
        return ctx.scene.leave();
      }
      
      if (proposal.status !== 'PENDING') {
        await ctx.reply('⚠️ این پیشنهاد دیگر فعال نیست.');
        return ctx.scene.leave();
      }
      
      if (proposal.creator.telegramId === from.id.toString()) {
        await ctx.reply('⚠️ شما نمی‌توانید برای پیشنهاد خودتان قیمت جدید ثبت کنید!');
        return ctx.scene.leave();
      }
      
      const firstOffer = await prisma.counterOffer.findFirst({
        where: { proposalId: proposalId },
        orderBy: { createdAt: 'asc' }
      });
      
      let promptText = `✍️ **ثبت پیشنهاد قیمت جدید برای تراکنش #${proposal.id}**\n\n` +
        `🔹 **نوع تراکنش:** ${proposal.type === 'BUY' ? '🟢 خرید ارز' : '🔴 فروش ارز'}\n` +
        `🔹 **ارز:** <code>${proposal.currency}</code>\n` +
        `🔹 **مقدار:** <code>${proposal.amount.toLocaleString('fa-IR')}</code>\n` +
        `🔹 **قیمت ثبت‌کننده:** <code>${proposal.price.toLocaleString('fa-IR')}</code> تومان\n`;
        
      if (firstOffer) {
        promptText += `⚠️ اولین پیشنهاد قیمت ثبت‌شده: <code>${firstOffer.price.toLocaleString('fa-IR')}</code> تومان\n`;
        if (proposal.type === 'BUY') {
          promptText += `📌 بر اساس قوانین، قیمت شما **نباید کمتر از** <code>${firstOffer.price.toLocaleString('fa-IR')}</code> تومان باشد.\n`;
        } else {
          promptText += `📌 بر اساس قوانین، قیمت شما **نباید بیشتر از** <code>${firstOffer.price.toLocaleString('fa-IR')}</code> تومان باشد.\n`;
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
      
    } catch (err) {
      console.error('Error in counter offer step 1:', err);
      await ctx.reply('❌ خطایی رخ داد.');
      return ctx.scene.leave();
    }
  },
  
  // Step 2: Validate price and save counter offer
  async (ctx) => {
    const proposalId = ctx.wizard.state.proposalId;
    if (!proposalId) {
      await ctx.reply('❌ اطلاعات پیشنهاد نامعتبر است.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === '❌ انصراف' || text === '/cancel') {
        await ctx.reply('❌ عملیات ثبت پیشنهاد قیمت لغو شد.', Markup.removeKeyboard());
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
          await ctx.reply('⚠️ متاسفانه این پیشنهاد دیگر فعال نیست.', Markup.removeKeyboard());
          return ctx.scene.leave();
        }
        
        const firstOffer = await prisma.counterOffer.findFirst({
          where: { proposalId: proposalId },
          orderBy: { createdAt: 'asc' }
        });
        
        // Enforce pricing constraints
        if (firstOffer) {
          if (proposal.type === 'BUY' && price < firstOffer.price) {
            await ctx.reply(`⚠️ قیمت پیشنهادی شما برای خرید ارز نباید کمتر از اولین پیشنهاد (${firstOffer.price.toLocaleString('fa-IR')} تومان) باشد. لطفا مجددا وارد کنید:`);
            return;
          }
          if (proposal.type === 'SELL' && price > firstOffer.price) {
            await ctx.reply(`⚠️ قیمت پیشنهادی شما برای فروش ارز نباید بیشتر از اولین پیشنهاد (${firstOffer.price.toLocaleString('fa-IR')} تومان) باشد. لطفا مجددا وارد کنید:`);
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
            status: 'PENDING'
          },
          include: {
            proposer: true
          }
        });
        
        await ctx.reply('✅ پیشنهاد قیمت شما با موفقیت ثبت شد و به اطلاع سازنده رسید.', Markup.removeKeyboard());
        
        // Notify the creator privately
        const proposerName = counterOffer.proposer.username 
          ? `@${counterOffer.proposer.username}` 
          : `<a href="tg://user?id=${counterOffer.proposer.telegramId}">${counterOffer.proposer.firstName}</a>`;
          
        const creatorMsg = 
          `🔔 <b>پیشنهاد قیمت جدید برای آگهی #${proposal.id} شما ثبت شده است:</b>\n\n` +
          `🔹 <b>ارز:</b> <code>${proposal.currency}</code>\n` +
          `🔹 <b>مقدار:</b> <code>${proposal.amount.toLocaleString('fa-IR')}</code>\n` +
          `🔹 <b>قیمت اولیه شما:</b> <code>${proposal.price.toLocaleString('fa-IR')}</code> تومان\n` +
          `💵 <b>قیمت پیشنهادی جدید:</b> <code>${price.toLocaleString('fa-IR')}</code> تومان\n` +
          `👤 <b>توسط:</b> ${proposerName}\n\n` +
          `❓ آیا این پیشنهاد قیمت را می‌پذیرید؟`;
          
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
        await ctx.reply('❌ خطا در ذخیره پیشنهاد قیمت.', Markup.removeKeyboard());
      }
      
      return ctx.scene.leave();
    }
    
    await ctx.reply('لطفاً قیمت پیشنهادی را به صورت عدد ارسال کنید یا انصراف دهید.');
  }
);
