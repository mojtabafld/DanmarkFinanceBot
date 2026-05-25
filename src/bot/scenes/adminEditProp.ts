import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';
import { updateGroupProposalMessage } from '../utils/groupMessage';

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
          await updateGroupProposalMessage(ctx.telegram, prop.id);
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
