import { Telegram, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';

export async function updateGroupProposalMessage(telegram: Telegram, proposalId: number) {
  try {
    const prop = await prisma.proposal.findUnique({
      where: { id: proposalId },
      include: {
        creator: true,
        counterOffers: {
          include: { proposer: true },
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!prop || !prop.groupMessageId) return;

    const isCompleted = prop.status === 'COMPLETED';
    const isCancelled = prop.status === 'CANCELLED' || prop.status === 'CANCELLED_BY_ADMIN';
    const isLocked = prop.status === 'LOCKED';

    let header = '📢 <b>پیشنهاد جدید معاملاتی</b>';
    if (isCompleted) {
      header = '🤝 <b>#معامله_بسته_شد</b>';
    } else if (isCancelled) {
      header = '❌ <b>#پیشنهاد_لغو_شد</b>';
    } else if (isLocked) {
      header = '🔒 <b>#معامله_در_انتظار_تایید_مدیریت</b>';
    }

    const typeHeader = prop.type === 'BUY' ? '🟢 #خرید_ارز' : '🔴 #فروش_ارز';
    const userMention = prop.creator.username 
      ? `@${prop.creator.username}` 
      : `<a href="tg://user?id=${prop.creator.telegramId}">${prop.creator.firstName}</a>`;

    let msgText =
      `${header}\n\n` +
      `<b>${typeHeader}</b>\n\n` +
      `🔹 <b>ارز:</b> <code>${prop.currency}</code>\n` +
      `🔹 <b>مقدار:</b> <code>${prop.amount.toLocaleString('fa-IR')}</code>\n` +
      `🔹 <b>قیمت واحد:</b> <code>${prop.price.toLocaleString('fa-IR')}</code> تومان\n` +
      `🔹 <b>مبلغ کل:</b> <code>${(prop.amount * prop.price).toLocaleString('fa-IR')}</code> تومان\n` +
      `👤 <b>توسط:</b> ${userMention}\n`;

    if (prop.counterOffers.length > 0) {
      msgText += `\n💬 <b>پیشنهادهای قیمت مطرح شده:</b>\n`;
      for (const offer of prop.counterOffers) {
        let statusIcon = '🟡';
        let statusText = 'در انتظار تایید';
        if (offer.status === 'ACCEPTED') {
          statusIcon = '🟢 🤝';
          statusText = 'پذیرفته شده';
        } else if (offer.status === 'REJECTED') {
          statusIcon = '🔴 ❌';
          statusText = 'رد شده';
        }
        
        const proposerMention = offer.proposer.username
          ? `@${offer.proposer.username}`
          : `<a href="tg://user?id=${offer.proposer.telegramId}">${offer.proposer.firstName}</a>`;
          
        msgText += `${statusIcon} مقدار <code>${offer.amount.toLocaleString('fa-IR')}</code> با قیمت <code>${offer.price.toLocaleString('fa-IR')}</code> تومان توسط ${proposerMention} (${statusText})\n`;
      }
    }

    if (!isCompleted && !isCancelled && !isLocked) {
      msgText += `\nℹ️ برای ارسال پاسخ، قبول پیشنهاد یا گفتگو با ثبت‌کننده، روی دکمه زیر کلیک کنید:`;
      
      const deepLinkUrl = `https://t.me/${config.BOT_USERNAME}?start=deal_${prop.id}`;
      await telegram.editMessageText(
        config.GROUP_CHAT_ID,
        prop.groupMessageId,
        undefined,
        msgText,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('🤝 قبول پیشنهاد / ارسال پاسخ', deepLinkUrl)]
          ])
        }
      ).catch(err => console.error('Failed to edit group message:', err));
    } else {
      if (isCompleted) {
        msgText += `\n✅ این پیشنهاد پذیرفته شد و با تایید مدیریت معامله با موفقیت نهایی و بسته شد.`;
      } else if (isCancelled) {
        msgText += `\n⚠️ این پیشنهاد توسط مدیریت ربات لغو گردید.`;
      } else if (isLocked) {
        msgText += `\n🔒 این پیشنهاد توسط یکی از کاربران پذیرفته شده و در انتظار تایید نهایی مدیریت است.`;
      }
      
      await telegram.editMessageText(
        config.GROUP_CHAT_ID,
        prop.groupMessageId,
        undefined,
        msgText,
        { parse_mode: 'HTML' }
      ).catch(err => console.error('Failed to edit completed/cancelled/locked group message:', err));
    }
  } catch (error) {
    console.error('Error updating group proposal message:', error);
  }
}
