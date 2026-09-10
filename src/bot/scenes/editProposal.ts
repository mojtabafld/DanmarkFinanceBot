import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { mainKeyboard } from '../utils/keyboards';
import { updateGroupProposalMessage } from '../utils/groupMessage';
import { escapeHtml } from '../utils/html';

interface EditProposalState {
  proposalId?: number;
  amount?: number;
  price?: number;
}

export interface MyEditWizardContext extends Scenes.WizardContext {
  wizard: Scenes.WizardContext['wizard'] & {
    state: EditProposalState;
  };
}

export const EDIT_PROPOSAL_SCENE_ID = 'EDIT_PROPOSAL_SCENE';

export const editProposalWizard = new Scenes.WizardScene<MyEditWizardContext>(
  EDIT_PROPOSAL_SCENE_ID,
  
  // Step 1: Prompt for new amount
  async (ctx) => {
    const state = ctx.scene.state as EditProposalState;
    ctx.wizard.state.proposalId = state.proposalId;
    
    if (!ctx.wizard.state.proposalId) {
      await ctx.reply('❌ اطلاعات آگهی نامعتبر است.', mainKeyboard);
      return ctx.scene.leave();
    }

    try {
      const proposal = await prisma.proposal.findUnique({
        where: { id: ctx.wizard.state.proposalId }
      });

      if (!proposal || proposal.status !== 'PENDING') {
        await ctx.reply('⚠️ این آگهی دیگر فعال یا قابل ویرایش نیست.', mainKeyboard);
        return ctx.scene.leave();
      }

      await ctx.reply(
        `✏️ <b>ویرایش مقدار آگهی #${proposal.code}</b>\n\n` +
        `مقدار فعلی: <code>${proposal.amount.toLocaleString('fa-IR')}</code> ${escapeHtml(proposal.currency)}\n\n` +
        `لطفاً مقدار جدید مورد نظر خود را به صورت عدد انگلیسی وارد کنید:`,
        {
          parse_mode: 'HTML',
          ...Markup.keyboard([['انصراف']]).oneTime().resize()
        }
      );
      return ctx.wizard.next();

    } catch (err) {
      console.error('Error starting edit proposal wizard:', err);
      await ctx.reply('❌ خطایی رخ داد.', mainKeyboard);
      return ctx.scene.leave();
    }
  },

  // Step 2: Handle Amount & Prompt for Price
  async (ctx) => {
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === 'انصراف' || text === '/cancel') {
        await ctx.reply('❌ ویرایش آگهی لغو شد.', mainKeyboard);
        return ctx.scene.leave();
      }

      const amount = parseFloat(text.replace(/,/g, ''));
      if (isNaN(amount) || amount <= 0) {
        await ctx.reply('⚠️ مقدار وارد شده نامعتبر است. لطفا یک عدد بزرگتر از صفر وارد کنید:');
        return;
      }

      ctx.wizard.state.amount = amount;

      try {
        const proposal = await prisma.proposal.findUnique({
          where: { id: ctx.wizard.state.proposalId }
        });
        if (!proposal) return ctx.scene.leave();

        await ctx.reply(
          `✏️ <b>ویرایش نرخ آگهی #${proposal.code}</b>\n\n` +
          `نرخ فعلی: <code>${proposal.price.toLocaleString('fa-IR')}</code> تومان\n\n` +
          `لطفاً نرخ جدید مورد نظر خود را به تومان وارد کنید:`,
          {
            parse_mode: 'HTML',
            ...Markup.keyboard([['انصراف']]).oneTime().resize()
          }
        );
        return ctx.wizard.next();

      } catch (err) {
        console.error('Error in edit wizard step 2:', err);
        return ctx.scene.leave();
      }
    }
    await ctx.reply('لطفاً مقدار را به صورت عدد ارسال کنید.');
  },

  // Step 3: Handle Price & Show Confirmation Summary
  async (ctx) => {
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === 'انصراف' || text === '/cancel') {
        await ctx.reply('❌ ویرایش آگهی لغو شد.', mainKeyboard);
        return ctx.scene.leave();
      }

      const price = parseFloat(text.replace(/,/g, ''));
      if (isNaN(price) || price <= 0) {
        await ctx.reply('⚠️ نرخ وارد شده نامعتبر است. لطفا یک عدد بزرگتر از صفر وارد کنید:');
        return;
      }

      ctx.wizard.state.price = price;

      try {
        const proposal = await prisma.proposal.findUnique({
          where: { id: ctx.wizard.state.proposalId }
        });
        if (!proposal) return ctx.scene.leave();

        const amount = ctx.wizard.state.amount!;
        const total = amount * price;

        const summaryText = 
          `✏️ *پیش‌نویس ویرایش آگهی #${proposal.code}:*\n\n` +
          `🔹 *نوع تراکنش:* ${proposal.type === 'BUY' ? '🟢 خرید' : '🔴 فروش'}\n` +
          `🔹 *نام ارز:* ${escapeHtml(proposal.currency)}\n` +
          `🔹 *مقدار جدید:* ${amount.toLocaleString('fa-IR')}\n` +
          `🔹 *قیمت واحد جدید:* ${price.toLocaleString('fa-IR')} تومان\n` +
          `🔹 *مبلغ کل جدید:* ${total.toLocaleString('fa-IR')} تومان\n\n` +
          `❓ آیا تغییرات فوق مورد تایید است؟`;

        await ctx.replyWithHTML(
          summaryText,
          Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ تایید و اعمال تغییرات', 'CONFIRM_EDIT'),
              Markup.button.callback('❌ انصراف', 'CANCEL_WIZARD')
            ]
          ])
        );
        return ctx.wizard.next();

      } catch (err) {
        console.error('Error in edit wizard step 3:', err);
        return ctx.scene.leave();
      }
    }
    await ctx.reply('لطفاً نرخ جدید را به صورت عدد ارسال کنید.');
  },

  // Step 4: Handle Confirmation & DB Save & Notifications
  async (ctx) => {
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      await ctx.answerCbQuery();

      if (data === 'CANCEL_WIZARD') {
        await ctx.reply('❌ ویرایش آگهی لغو شد.', mainKeyboard);
        return ctx.scene.leave();
      }

      if (data === 'CONFIRM_EDIT') {
        const proposalId = ctx.wizard.state.proposalId!;
        const amount = ctx.wizard.state.amount!;
        const price = ctx.wizard.state.price!;

        try {
          // Get the proposal and its pending counter-offers before editing
          const proposal = await prisma.proposal.findUnique({
            where: { id: proposalId }
          });

          if (!proposal || proposal.status !== 'PENDING') {
            await ctx.reply('⚠️ آگهی دیگر فعال نیست و تغییرات ثبت نشد.', mainKeyboard);
            return ctx.scene.leave();
          }

          // Fetch all users who have pending counter-offers on this proposal
          const pendingOffers = await prisma.counterOffer.findMany({
            where: { proposalId: proposalId, status: 'PENDING' },
            include: { proposer: true }
          });

          // Update in DB
          await prisma.proposal.update({
            where: { id: proposalId },
            data: {
              amount: amount,
              originalAmount: amount, // reset the total amount as well
              price: price,
              editedAt: new Date()
            }
          });

          await ctx.reply('✅ آگهی شما با موفقیت ویرایش شد و در گروه آپدیت گردید.', mainKeyboard);

          // Notify counter-offerers
          const notifyMsg = 
            `🔔 <b>اطلاعیه ویرایش آگهی</b>\n\n` +
            `کاربر گرامی، آگهی کد <code>${proposal.code ?? proposal.id}</code> که شما روی آن پیشنهاد قیمت ثبت کرده بودید، توسط آگهی‌دهنده ویرایش گردید:\n` +
            `🔹 <b>مقدار جدید:</b> <code>${amount.toLocaleString('fa-IR')}</code> ${escapeHtml(proposal.currency)}\n` +
            `🔹 <b>قیمت واحد جدید:</b> <code>${price.toLocaleString('fa-IR')}</code> تومان\n\n` +
            `🔄 در صورت تمایل می‌توانید با زدن دکمه زیر پیشنهاد قیمت خود را متناسب با تغییرات جدید ویرایش کنید یا آن را لغو نمایید:`;

          for (const offer of pendingOffers) {
            await ctx.telegram.sendMessage(offer.proposer.telegramId, notifyMsg, {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([
                [Markup.button.callback('✏️ ویرایش پیشنهاد من', `USER_GO_EDIT_OFFER_${offer.id}`)]
              ])
            }).catch(err => console.error(`Failed to notify proposer ${offer.proposer.telegramId} of edit:`, err));
          }

          // Update group message
          await updateGroupProposalMessage(ctx.telegram, proposalId);

        } catch (error) {
          console.error('Error updating proposal:', error);
          await ctx.reply('❌ خطا در اعمال تغییرات.', mainKeyboard);
        }

        return ctx.scene.leave();
      }
    }

    await ctx.reply('لطفاً یکی از دکمه‌های شیشه‌ای بالا را انتخاب کنید.');
  }
);
