import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';

export const ADMIN_EDIT_PROP_SCENE_ID = 'ADMIN_EDIT_PROP_SCENE';

interface EditPropState {
  proposalId?: number;
  field?: 'amount' | 'price';
}

export interface MyEditPropContext extends Scenes.WizardContext {
  wizard: Scenes.WizardContext['wizard'] & {
    state: EditPropState;
  };
}

export const adminEditPropWizard = new Scenes.WizardScene<MyEditPropContext>(
  ADMIN_EDIT_PROP_SCENE_ID,
  
  // Step 1: Prompt for new value
  async (ctx) => {
    const state = ctx.scene.state as EditPropState;
    ctx.wizard.state.proposalId = state.proposalId;
    ctx.wizard.state.field = state.field;
    
    const proposalId = state.proposalId;
    const field = state.field;
    
    if (!proposalId || !field) {
      await ctx.reply('❌ اطلاعات پیشنهاد یا فیلد مورد نظر نامعتبر است.');
      return ctx.scene.leave();
    }
    
    try {
      const prop = await prisma.proposal.findUnique({
        where: { id: proposalId }
      });
      
      if (!prop) {
        await ctx.reply('❌ پیشنهاد یافت نشد.');
        return ctx.scene.leave();
      }
      
      let promptText = '';
      if (field === 'amount') {
        promptText = `✏️ **ویرایش مقدار پیشنهاد**\n\nمقدار کنونی: <code>${prop.amount.toLocaleString('fa-IR')} ${prop.currency}</code>\n\nلطفاً مقدار جدید را به صورت عدد انگلیسی بنویسید:`;
      } else {
        promptText = `✏️ **ویرایش قیمت واحد پیشنهاد**\n\nقیمت کنونی: <code>${prop.price.toLocaleString('fa-IR')}</code> تومان\n\nلطفاً قیمت جدید را به تومان (عدد انگلیسی) بنویسید:`;
      }
      
      await ctx.reply(promptText, {
        parse_mode: 'HTML',
        ...Markup.keyboard([['❌ انصراف']]).resize().oneTime()
      });
      return ctx.wizard.next();
    } catch (err) {
      console.error('Error in edit prop step 1:', err);
      await ctx.reply('❌ خطایی رخ داد.');
      return ctx.scene.leave();
    }
  },
  
  // Step 2: Receive input, update DB, edit group message
  async (ctx) => {
    const proposalId = ctx.wizard.state.proposalId;
    const field = ctx.wizard.state.field;
    
    if (!proposalId || !field) {
      await ctx.reply('❌ اطلاعات پیشنهاد یافت نشد.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === '❌ انصراف' || text === '/cancel') {
        await ctx.reply('❌ عملیات ویرایش لغو شد.', Markup.removeKeyboard());
        return ctx.scene.leave();
      }
      
      const value = parseFloat(text.replace(/,/g, ''));
      if (isNaN(value) || value <= 0) {
        await ctx.reply('⚠️ لطفا یک عدد بزرگتر از صفر وارد کنید:');
        return;
      }
      
      try {
        const updateData = field === 'amount' ? { amount: value } : { price: value };
        const prop = await prisma.proposal.update({
          where: { id: proposalId },
          data: updateData,
          include: { creator: true }
        });
        
        await ctx.reply('✅ ویرایش پیشنهاد با موفقیت انجام شد.', Markup.removeKeyboard());
        
        // Update the message in the group to show updated details
        if (prop.groupMessageId) {
          const typeHeader = prop.type === 'BUY' ? '🟢 #خرید_ارز' : '🔴 #فروش_ارز';
          const userMention = prop.creator.username 
            ? `@${prop.creator.username}` 
            : `<a href="tg://user?id=${prop.creator.telegramId}">${prop.creator.firstName}</a>`;

          const groupMsgText =
            `📢 <b>پیشنهاد جدید معاملاتی</b> (ویرایش شده توسط مدیریت)\n\n` +
            `<b>${typeHeader}</b>\n\n` +
            `🔹 <b>ارز:</b> <code>${prop.currency}</code>\n` +
            `🔹 <b>مقدار:</b> <code>${prop.amount.toLocaleString('fa-IR')}</code>\n` +
            `🔹 <b>قیمت واحد:</b> <code>${prop.price.toLocaleString('fa-IR')}</code> تومان\n` +
            `🔹 <b>مبلغ کل:</b> <code>${(prop.amount * prop.price).toLocaleString('fa-IR')}</code> تومان\n` +
            `👤 <b>توسط:</b> ${userMention}\n\n` +
            `ℹ️ برای ارسال پاسخ، قبول پیشنهاد یا گفتگو با ثبت‌کننده، روی دکمه زیر کلیک کنید:`;

          const deepLinkUrl = `https://t.me/${config.BOT_USERNAME}?start=deal_${prop.id}`;

          await ctx.telegram.editMessageText(
            config.GROUP_CHAT_ID,
            prop.groupMessageId,
            undefined,
            groupMsgText,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([
                [Markup.button.url('🤝 قبول پیشنهاد / ارسال پاسخ', deepLinkUrl)],
                [Markup.button.callback('⚙️ مدیریت پیشنهاد (ادمین)', `ADMIN_PROP_MANAGE_${prop.id}`)]
              ])
            }
          ).catch(err => console.error('Failed to update group message on admin edit:', err));
        }
        
        // Show updated view button
        await ctx.reply(
          `پیشنهاد شماره ${prop.id} بروزرسانی شد.`,
          Markup.inlineKeyboard([[Markup.button.callback('📋 مشاهده جزئیات پیشنهاد', `ADMIN_PROP_VIEW_${prop.id}`)]])
        );
        
      } catch (error) {
        console.error('Error saving edited proposal field:', error);
        await ctx.reply('❌ خطا در ذخیره ویرایش.', Markup.removeKeyboard());
      }
      return ctx.scene.leave();
    }
    
    await ctx.reply('لطفاً مقدار عددی معتبری ارسال کنید یا روی انصراف کلیک کنید.');
  }
);
