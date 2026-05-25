import { Telegram, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';

export function formatToShamsi(date: Date): string {
  try {
    const formatter = new Intl.DateTimeFormat('fa-IR', {
      calendar: 'persian',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    return formatter.format(date);
  } catch (e) {
    return date.toISOString();
  }
}

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

    // Fetch details of deals associated with this ad
    const deals = await prisma.deal.findMany({
      where: { proposalId: prop.id },
      include: { acceptor: true }
    });
    const inProgressAmount = deals.filter(d => d.status === 'PENDING_ADMIN').reduce((sum, d) => sum + d.amount, 0);
    const tradedAmount = deals.filter(d => d.status === 'COMPLETED').reduce((sum, d) => sum + d.amount, 0);
    const totalAmount = prop.originalAmount ?? (prop.amount + inProgressAmount + tradedAmount);

    let msgText =
      `${header}\n\n` +
      `<b>${typeHeader}</b>\n\n` +
      `🔹 <b>کد حواله:</b> <code>${prop.code ?? '---'}</code>\n` +
      `🔹 <b>ارز:</b> <code>${prop.currency}</code>\n` +
      `🔹 <b>نوع تسویه:</b> <code>${prop.paymentMethod ?? '---'}</code>\n` +
      `🔹 <b>مقدار کل:</b> <code>${totalAmount.toLocaleString('fa-IR')}</code>\n`;

    if (inProgressAmount > 0) {
      msgText += `🔸 <b>در حال مبادله:</b> <code>${inProgressAmount.toLocaleString('fa-IR')}</code>\n`;
    }
    if (tradedAmount > 0) {
      msgText += `✅ <b>مبادله شده:</b> <code>${tradedAmount.toLocaleString('fa-IR')}</code>\n`;
    }

    msgText +=
      `🔹 <b>مقدار باقیمانده:</b> <code>${prop.amount.toLocaleString('fa-IR')}</code>\n` +
      `🔹 <b>قیمت واحد:</b> <code>${prop.price.toLocaleString('fa-IR')}</code> تومان\n` +
      `🔹 <b>مبلغ کل باقیمانده:</b> <code>${(prop.amount * prop.price).toLocaleString('fa-IR')}</code> تومان\n` +
      `👤 <b>توسط:</b> ${userMention}\n` +
      `📅 <b>تاریخ ثبت:</b> <code>${formatToShamsi(prop.createdAt)}</code>\n`;

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

    // Display completed trades history under completed ad
    const completedDeals = deals.filter(d => d.status === 'COMPLETED');
    if (completedDeals.length > 0) {
      msgText += `\n🤝 <b>جزئیات معاملات انجام شده:</b>\n`;
      for (let i = 0; i < completedDeals.length; i++) {
        const deal = completedDeals[i];
        
        // Find if this deal was from a counter offer to display the agreed price
        const acceptedOffer = await prisma.counterOffer.findFirst({
          where: {
            proposalId: prop.id,
            proposerId: deal.acceptorId,
            status: 'ACCEPTED'
          }
        });
        const tradePrice = acceptedOffer ? acceptedOffer.price : prop.price;
        
        const acceptorMention = deal.acceptor.username
          ? `@${deal.acceptor.username}`
          : `<a href="tg://user?id=${deal.acceptor.telegramId}">${deal.acceptor.firstName}</a>`;
          
        msgText += `🔹 <b>معامله ${i + 1}:</b> مقدار <code>${deal.amount.toLocaleString('fa-IR')}</code> با نرخ <code>${tradePrice.toLocaleString('fa-IR')}</code> تومان توسط ${acceptorMention}\n`;
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
