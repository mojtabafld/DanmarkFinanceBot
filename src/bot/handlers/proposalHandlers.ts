import { Telegraf } from 'telegraf';
import { BotContext } from '../index';
import { config } from '../../config';
import { prisma } from '../../database/db';
import { checkVerified } from '../middleware/auth';
import { MANAGE_ADS_SCENE_ID } from '../scenes/manageAds';
import { CREATE_PROPOSAL_SCENE_ID } from '../scenes/createProposal';
import { EDIT_PROPOSAL_SCENE_ID } from '../scenes/editProposal';
import { MANAGE_OFFERS_SCENE_ID } from '../scenes/manageOffers';
import { updateGroupProposalMessage } from '../utils/groupMessage';

export function registerProposalHandlers(bot: Telegraf<BotContext>) {
  bot.hears('📋 مدیریت آگهی‌ها', checkVerified, async (ctx) => {
    await ctx.scene.enter(MANAGE_ADS_SCENE_ID);
  });

  bot.hears('📊 لیست مبادلات فعال', checkVerified, async (ctx) => {
    try {
      const activeProposals = await prisma.proposal.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'desc' }
      });

      if (activeProposals.length === 0) {
        await ctx.reply('⚠️ در حال حاضر هیچ حواله فعال و آماده مبادله‌ای در سیستم وجود ندارد.');
        return;
      }

      let text = `📊 <b>لیست مبادلات فعال:</b>\n\n`;
      activeProposals.forEach((prop) => {
        const typeText = prop.type === 'BUY' ? '🟢 خرید' : '🔴 فروش';
        const cleanChatId = config.GROUP_CHAT_ID.toString().startsWith('-100')
          ? config.GROUP_CHAT_ID.toString().substring(4)
          : config.GROUP_CHAT_ID.toString();

        const link = prop.groupMessageId
          ? `https://t.me/c/${cleanChatId}/${prop.groupMessageId}`
          : `https://t.me/${config.BOT_USERNAME}`;

        text += `🔹 <a href="${link}">حواله #${prop.code ?? prop.id}</a> | <b>${typeText}</b> | تسویه: <code>${prop.paymentMethod ?? '---'}</code> | مقدار: <code>${prop.amount.toLocaleString('fa-IR')}</code> ${prop.currency} | نرخ: <code>${prop.price.toLocaleString('fa-IR')}</code> تومان\n\n`;
      });

      await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } catch (err) {
      console.error('Error fetching active trades list:', err);
      await ctx.reply('❌ خطا در دریافت لیست مبادلات فعال.');
    }
  });

  bot.use(async (ctx, next) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return next();
    const data = ctx.callbackQuery.data;

    if (data === 'USER_CREATE_NEW_PROP') {
      await ctx.answerCbQuery();
      await ctx.scene.enter(CREATE_PROPOSAL_SCENE_ID);
      return;
    }

    if (data.startsWith('USER_EDIT_PROP_')) {
      const proposalId = parseInt(data.replace('USER_EDIT_PROP_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(proposalId)) return;
      await ctx.scene.enter(EDIT_PROPOSAL_SCENE_ID, { proposalId });
      return;
    }

    if (data.startsWith('USER_GO_EDIT_OFFER_')) {
      const offerId = parseInt(data.replace('USER_GO_EDIT_OFFER_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(offerId)) return;

      try {
        const offer = await prisma.counterOffer.findUnique({
          where: { id: offerId },
          include: { proposal: true }
        });

        if (!offer || offer.status !== 'PENDING') {
          await ctx.reply('⚠️ این پیشنهاد قیمت دیگر فعال نیست یا تغییر یافته است.');
          return;
        }

        if (offer.proposal.status !== 'PENDING') {
          await ctx.reply('⚠️ آگهی مربوط به این پیشنهاد دیگر فعال نیست.');
          return;
        }

        await ctx.scene.enter(MANAGE_OFFERS_SCENE_ID, { offerId });
      } catch (err) {
        console.error('Error entering manage offers scene from edit notification:', err);
        await ctx.reply('❌ خطا در باز کردن منوی ویرایش پیشنهاد.');
      }
      return;
    }

    if (data.startsWith('DELETE_COMPLETED_AD_MSG_')) {
      const propId = parseInt(data.replace('DELETE_COMPLETED_AD_MSG_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(propId)) return;

      try {
        const prop = await prisma.proposal.findUnique({
          where: { id: propId }
        });

        if (prop && prop.groupMessageId) {
          await ctx.telegram.deleteMessage(config.GROUP_CHAT_ID, prop.groupMessageId).catch((err) => {
            console.error('Failed to delete completed ad group message:', err);
          });
          await prisma.proposal.update({
            where: { id: propId },
            data: { groupMessageId: null }
          });
        }
        await ctx.editMessageText('✅ پیام آگهی با موفقیت از گروه حذف شد.').catch(() => {});
      } catch (err) {
        console.error('Error deleting completed ad msg from prompt:', err);
        await ctx.reply('❌ خطا در حذف پیام آگهی.');
      }
      return;
    }

    if (data.startsWith('KEEP_COMPLETED_AD_MSG_')) {
      await ctx.answerCbQuery();
      await ctx.editMessageText('✅ پیام آگهی در گروه باقی ماند.').catch(() => {});
      return;
    }

    if (data.startsWith('CANCEL_MY_PROP_')) {
      const from = ctx.from;
      if (!from) return next();
      const propId = parseInt(data.replace('CANCEL_MY_PROP_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(propId)) return;

      try {
        const prop = await prisma.proposal.findUnique({
          where: { id: propId },
          include: { creator: true }
        });

        if (!prop || prop.creator.telegramId !== from.id.toString()) {
          await ctx.reply('⚠️ شما مجاز به لغو این پیشنهاد نیستید.');
          return;
        }

        if (prop.status !== 'PENDING') {
          await ctx.reply('⚠️ این پیشنهاد قبلاً معامله یا لغو شده است.');
          await ctx.deleteMessage().catch(() => {});
          return;
        }

        const pendingOffers = await prisma.counterOffer.findMany({
          where: {
            proposalId: propId,
            status: 'PENDING'
          },
          include: { proposer: true }
        });

        await prisma.$transaction([
          prisma.proposal.update({
            where: { id: propId },
            data: { status: 'CANCELLED' }
          }),
          prisma.counterOffer.updateMany({
            where: {
              proposalId: propId,
              status: 'PENDING'
            },
            data: { status: 'REJECTED' }
          })
        ]);

        for (const offer of pendingOffers) {
          await ctx.telegram
            .sendMessage(
              offer.proposer.telegramId,
              `⚠️ **اطلاعیه:** پیشنهاد قیمت <code>${offer.price.toLocaleString('fa-IR')}</code> تومانی شما برای آگهی #${prop.code ?? prop.id} به علت لغو شدن آگهی توسط سازنده، بسته شد.`,
              { parse_mode: 'HTML' }
            )
            .catch(() => {});
        }

        await ctx.reply(`✅ آگهی #${prop.code ?? prop.id} با موفقیت لغو گردید.`);
        await updateGroupProposalMessage(ctx.telegram, propId);
      } catch (err) {
        console.error('Error canceling user proposal:', err);
        await ctx.reply('❌ خطا در لغو آگهی.');
      }
      return;
    }

    return next();
  });
}
