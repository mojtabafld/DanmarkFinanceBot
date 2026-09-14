import { Telegraf, Markup } from 'telegraf';
import { BotContext } from '../index';
import { config } from '../../config';
import { prisma } from '../../database/db';
import { checkVerified } from '../middleware/auth';
import { MANAGE_OFFERS_SCENE_ID } from '../scenes/manageOffers';
import { UPLOAD_RECEIPT_SCENE_ID } from '../scenes/uploadReceipt';
import { ACCEPT_DEAL_SCENE_ID } from '../scenes/dealWizard';
import { updateGroupProposalMessage } from '../utils/groupMessage';
import { getMainKeyboard, mainKeyboard } from '../utils/keyboards';
import { AMOUNT_EPSILON } from '../utils/amounts';
import { escapeHtml } from '../utils/html';
import { deadlineFor } from '../../domain/dealMachine';

export function registerDealHandlers(bot: Telegraf<BotContext>) {
  bot.hears('🤝 مدیریت پیشنهادات', checkVerified, async (ctx) => {
    await ctx.scene.enter(MANAGE_OFFERS_SCENE_ID);
  });

  bot.hears('📤 ارسال فیش واریزی', checkVerified, async (ctx) => {
    await ctx.scene.enter(UPLOAD_RECEIPT_SCENE_ID);
  });

  bot.hears('📞 ارتباط مستقیم با ادمین', checkVerified, async (ctx) => {
    await ctx.reply(
      `📞 <b>ارتباط مستقیم با مدیریت:</b>\n\n` +
        `جهت پشتیبانی، پیگیری امور یا سوالات بیشتر می‌توانید مستقیماً به آیدی زیر پیام دهید:\n` +
        `👉 @${config.ADMIN_USERNAME}`,
      mainKeyboard
    );
  });

  bot.use(async (ctx, next) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return next();
    const data = ctx.callbackQuery.data;
    const from = ctx.from;
    if (!from) return next();

    if (data.startsWith('ACCEPT_DEAL_')) {
      const proposalId = parseInt(data.replace('ACCEPT_DEAL_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(proposalId)) return;
      await ctx.scene.enter(ACCEPT_DEAL_SCENE_ID, { proposalId });
      return;
    }

    if (data.startsWith('COUNTER_OFFER_PROP_')) {
      const proposalId = parseInt(data.replace('COUNTER_OFFER_PROP_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(proposalId)) return;
      await ctx.scene.enter(MANAGE_OFFERS_SCENE_ID, { proposalId });
      return;
    }

    if (data === 'CANCEL_DEAL') {
      await ctx.answerCbQuery();
      await ctx.reply('❌ عملیات معامله لغو شد.');
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (data.startsWith('OFFER_ACCEPT_')) {
      const offerId = parseInt(data.replace('OFFER_ACCEPT_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(offerId)) return;

      try {
        const offer = await prisma.counterOffer.findUnique({
          where: { id: offerId },
          include: {
            proposal: { include: { creator: true } },
            proposer: true
          }
        });

        if (!offer || offer.status !== 'PENDING') {
          await ctx.reply('⚠️ این پیشنهاد دیگر فعال نیست یا قبلاً تعیین تکلیف شده است.');
          return;
        }

        if (offer.proposal.creator.telegramId !== from.id.toString()) {
          await ctx.reply('⚠️ شما مجاز به تایید این پیشنهاد نیستید.');
          return;
        }

        if (offer.proposal.status !== 'PENDING') {
          await ctx.reply('⚠️ این آگهی دیگر فعال نیست.');
          return;
        }

        const tradeAmount = offer.amount > 0 ? offer.amount : offer.proposal.amount;

        const newDeal = await prisma.$transaction(async (tx) => {
          // Claim the counter offer first: the conditional update only succeeds for
          // whichever concurrent request gets there first, so a double tap on the
          // approve button cannot produce two deals from one offer.
          const claimedOffer = await tx.counterOffer.updateMany({
            where: { id: offerId, status: 'PENDING' },
            data: { status: 'ACCEPTED' }
          });
          if (claimedOffer.count !== 1) {
            throw new Error('OFFER_ALREADY_HANDLED');
          }

          // Decrement inside the WHERE clause rather than reading, subtracting in JS
          // and writing back. Under the default read-committed isolation the
          // read-then-write version let two acceptances both pass the sufficiency
          // check and oversell the ad.
          const claimedAmount = await tx.proposal.updateMany({
            where: {
              id: offer.proposalId,
              status: 'PENDING',
              amount: { gte: tradeAmount }
            },
            data: { amount: { decrement: tradeAmount } }
          });
          if (claimedAmount.count !== 1) {
            throw new Error('INSUFFICIENT_AMOUNT');
          }

          const updatedProp = await tx.proposal.findUniqueOrThrow({
            where: { id: offer.proposalId }
          });
          if (updatedProp.amount <= AMOUNT_EPSILON) {
            await tx.proposal.update({
              where: { id: offer.proposalId },
              data: { amount: 0, status: 'LOCKED' }
            });
          }

          return await tx.deal.create({
            data: {
              proposalId: offer.proposalId,
              acceptorId: offer.proposerId,
              amount: tradeAmount,
              status: 'PENDING_ADMIN',
              deadlineAt: deadlineFor('PENDING_ADMIN')
            }
          });
        });

        await updateGroupProposalMessage(ctx.telegram, offer.proposalId);

        const typeText = offer.proposal.type === 'BUY' ? '🟢 خرید' : '🔴 فروش';

        const adminNotice =
          `🔔 <b>درخواست معامله جدید بر اساس پیشنهاد قیمت (نیازمند تایید مدیریت)</b>\n\n` +
          `🔹 <b>شناسه معامله:</b> <code>#DEAL_${newDeal.id}</code>\n` +
          `🔹 <b>کد آگهی:</b> <code>#PROP_${offer.proposal.code ?? offer.proposal.id}</code>\n` +
          `🔹 <b>نوع آگهی:</b> ${typeText}\n` +
          `🔹 <b>ارز:</b> <code>${escapeHtml(offer.proposal.currency)}</code>\n` +
          `🔹 <b>مقدار مورد معامله:</b> <code>${tradeAmount.toLocaleString('fa-IR')}</code>\n` +
          `🔹 <b>نرخ توافقی (پیشنهادی):</b> <code>${offer.price.toLocaleString('fa-IR')}</code> تومان\n` +
          `🔹 <b>مبلغ کل:</b> <code>${(tradeAmount * offer.price).toLocaleString('fa-IR')}</code> تومان\n\n` +
          `👤 <b>ثبت‌کننده آگهی:</b> ${escapeHtml(offer.proposal.creator.firstName)} (@${escapeHtml(offer.proposal.creator.username ?? '---')})\n` +
          `👤 <b>پیشنهاددهنده (پذیرنده):</b> ${escapeHtml(offer.proposer.firstName)} (@${escapeHtml(offer.proposer.username ?? '---')})\n\n` +
          `❓ آیا این معامله و نرخ توافقی را تایید می‌کنید؟`;

        await ctx.telegram.sendMessage(config.ADMIN_CHAT_ID, adminNotice, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ تایید معامله', `ADMIN_DEAL_APPROVE_${newDeal.id}`),
              Markup.button.callback('❌ رد معامله', `ADMIN_DEAL_REJECT_${newDeal.id}`)
            ]
          ])
        });

        await ctx.reply(
          `✅ <b>پیشنهاد قیمت پذیرفته شد.</b>\n\n` +
            `درخواست معامله به مدیریت ارسال شد. به محض تایید مدیریت، اطلاعات جهت واریز وجه برای طرفین ارسال خواهد شد.`,
          mainKeyboard
        );

        const proposerKb = await getMainKeyboard(offer.proposer.telegramId);
        await ctx.telegram.sendMessage(
          offer.proposer.telegramId,
          `🎉 <b>پیشنهاد قیمت شما برای آگهی #${offer.proposal.code ?? offer.proposal.id} توسط ثبت‌کننده پذیرفته شد!</b>\n\n` +
            `درخواست معامله برای تایید نهایی به مدیریت ارسال گردید. به محض تایید ادمین، پیام راهنمای پرداخت ارسال خواهد شد.`,
          { ...proposerKb }
        );
      } catch (err: any) {
        if (err.message === 'INSUFFICIENT_AMOUNT') {
          await ctx.reply('⚠️ موجودی باقیمانده این آگهی برای این مقدار کافی نیست.');
        } else if (err.message === 'OFFER_ALREADY_HANDLED') {
          await ctx.reply('⚠️ این پیشنهاد هم‌زمان توسط درخواست دیگری تعیین تکلیف شد.');
        } else {
          console.error('Error accepting counter offer:', err);
          await ctx.reply('❌ خطا در تایید پیشنهاد قیمت.');
        }
      }
      return;
    }

    if (data.startsWith('OFFER_REJECT_')) {
      const offerId = parseInt(data.replace('OFFER_REJECT_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(offerId)) return;

      try {
        const offer = await prisma.counterOffer.findUnique({
          where: { id: offerId },
          include: {
            proposal: { include: { creator: true } },
            proposer: true
          }
        });

        if (!offer || offer.status !== 'PENDING') {
          await ctx.reply('⚠️ این پیشنهاد دیگر فعال نیست یا قبلاً تعیین تکلیف شده است.');
          return;
        }

        if (offer.proposal.creator.telegramId !== from.id.toString()) {
          await ctx.reply('⚠️ شما مجاز به رد این پیشنهاد نیستید.');
          return;
        }

        await prisma.counterOffer.update({
          where: { id: offerId },
          data: { status: 'REJECTED' }
        });

        await updateGroupProposalMessage(ctx.telegram, offer.proposalId);

        await ctx.reply('❌ پیشنهاد قیمت با موفقیت رد شد.');

        const proposerKb = await getMainKeyboard(offer.proposer.telegramId);
        await ctx.telegram.sendMessage(
          offer.proposer.telegramId,
          `❌ <b>پیشنهاد قیمت شما برای آگهی #${offer.proposal.code ?? offer.proposal.id} توسط ثبت‌کننده آگهی رد گردید.</b>`,
          { ...proposerKb }
        );
      } catch (err) {
        console.error('Error rejecting counter offer:', err);
        await ctx.reply('❌ خطا در رد پیشنهاد قیمت.');
      }
      return;
    }

    return next();
  });
}
