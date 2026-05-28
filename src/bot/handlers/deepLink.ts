import { Context, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';
import { formatToShamsi } from '../utils/groupMessage';

/**
 * Handles deep links coming from group inline buttons.
 * E.g., /start deal_123
 */
export async function handleDeepLink(ctx: Context, payload: string) {
  if (payload === 'active_ads') {
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
      activeProposals.forEach(prop => {
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
      console.error('Error listing active ads in deep link:', err);
      await ctx.reply('❌ خطا در دریافت لیست مبادلات فعال.');
    }
    return;
  }

  if (!payload.startsWith('deal_')) {
    await ctx.reply('⚠️ لینک معتبر نیست.');
    return;
  }

  const proposalId = parseInt(payload.replace('deal_', ''), 10);
  if (isNaN(proposalId)) {
    await ctx.reply('⚠️ شناسه پیشنهاد نامعتبر است.');
    return;
  }

  const from = ctx.from;
  if (!from) return;

  try {
    // Check if the user is verified
    const dbAcceptor = await prisma.user.findUnique({
      where: { telegramId: from.id.toString() }
    });

    if (!dbAcceptor || dbAcceptor.verificationStatus !== 'APPROVED') {
      await ctx.reply(
        '⚠️ جهت شرکت در معاملات و پذیرش پیشنهادها، ابتدا باید در ربات احراز هویت شده و عضو گروه باشید.',
        Markup.keyboard([['🔐 شروع احراز هویت']]).resize()
      );
      return;
    }

    // 1. Fetch proposal and creator
    const proposal = await prisma.proposal.findUnique({
      where: { id: proposalId },
      include: { creator: true },
    });

    if (!proposal) {
      await ctx.reply('⚠️ پیشنهاد مورد نظر یافت نشد یا حذف شده است.');
      return;
    }

    if (proposal.status !== 'PENDING') {
      await ctx.reply('⚠️ این پیشنهاد دیگر فعال نیست (قبلاً معامله شده یا لغو شده است).');
      return;
    }

    // Check if the user is the creator of the proposal
    if (proposal.creator.telegramId === from.id.toString()) {
      await ctx.reply('⚠️ شما نمی‌توانید پیشنهاد خودتان را قبول کنید!');
      return;
    }

    // 2. Format details and ask for confirmation
    const typeText = proposal.type === 'BUY' ? '🟢 خرید' : '🔴 فروش';
    const creatorName = proposal.creator.username 
      ? `@${proposal.creator.username}` 
      : proposal.creator.firstName;

    const detailText =
      `📋 **جزئیات پیشنهاد انتخاب شده:**\n\n` +
      `🔹 **نوع تراکنش:** ${typeText}\n` +
      `🔹 **نام ارز:** ${proposal.currency}\n` +
      `🔹 **مقدار:** ${proposal.amount.toLocaleString('fa-IR')}\n` +
      `🔹 **قیمت واحد:** ${proposal.price.toLocaleString('fa-IR')} تومان\n` +
      `🔹 **مبلغ کل:** ${(proposal.amount * proposal.price).toLocaleString('fa-IR')} تومان\n` +
      `👤 **ثبت‌کننده:** ${creatorName}\n\n` +
      `❓ آیا مایل به پذیرش این پیشنهاد هستید؟\n` +
      `⚠️ با پذیرش پیشنهاد، معامله ثبت شده و شما و سازنده پیشنهاد به ادمین متصل خواهید شد تا معامله را تحت نظارت ادمین نهایی کنید.`;

    await ctx.replyWithMarkdown(
      detailText,
      Markup.inlineKeyboard([
        [Markup.button.callback('🤝 قبول تعداد کل با قیمت اصلی', `ACCEPT_DEAL_${proposal.id}`)],
        [Markup.button.callback('✍️ ثبت تعداد و قیمت پیشنهادی جدید', `COUNTER_OFFER_PROP_${proposal.id}`)],
        [Markup.button.callback('❌ انصراف', 'CANCEL_DEAL')]
      ])
    );

  } catch (error) {
    console.error('Error handling deep link:', error);
    await ctx.reply('❌ در پردازش درخواست مشکلی پیش آمد.');
  }
}
