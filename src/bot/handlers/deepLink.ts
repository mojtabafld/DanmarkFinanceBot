import { Context, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';

/**
 * Handles deep links coming from group inline buttons.
 * E.g., /start deal_123
 */
export async function handleDeepLink(ctx: Context, payload: string) {
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
        [
          Markup.button.callback('✅ بله، معامله را قبول می‌کنم', `ACCEPT_DEAL_${proposal.id}`),
          Markup.button.callback('❌ انصراف', 'CANCEL_DEAL')
        ]
      ])
    );

  } catch (error) {
    console.error('Error handling deep link:', error);
    await ctx.reply('❌ در پردازش درخواست مشکلی پیش آمد.');
  }
}

/**
 * Handles callback queries related to deal acceptance.
 */
export async function handleDealCallbacks(ctx: Context) {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  const data = ctx.callbackQuery.data;
  const from = ctx.from;
  if (!from) return;

  if (data === 'CANCEL_DEAL') {
    await ctx.answerCbQuery();
    await ctx.reply('❌ عملیات پذیرش پیشنهاد لغو شد.');
    // Remove the message containing confirmation buttons
    await ctx.deleteMessage().catch(() => {});
    return;
  }

  if (data.startsWith('ACCEPT_DEAL_')) {
    const proposalId = parseInt(data.replace('ACCEPT_DEAL_', ''), 10);
    await ctx.answerCbQuery();

    if (isNaN(proposalId)) {
      await ctx.reply('⚠️ شناسه پیشنهاد نامعتبر است.');
      return;
    }

    try {
      // 1. Transaction to prevent double acceptance and save deal
      const result = await prisma.$transaction(async (tx) => {
        // Find proposal
        const proposal = await tx.proposal.findUnique({
          where: { id: proposalId },
          include: { creator: true },
        });

        if (!proposal) {
          throw new Error('PROPOSAL_NOT_FOUND');
        }

        if (proposal.status !== 'PENDING') {
          throw new Error('PROPOSAL_NOT_PENDING');
        }

        // Upsert acceptor user
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
          },
        });

        if (proposal.creator.id === acceptor.id) {
          throw new Error('CANNOT_ACCEPT_OWN_PROPOSAL');
        }

        // Create deal
        const deal = await tx.deal.create({
          data: {
            proposalId: proposal.id,
            acceptorId: acceptor.id,
            status: 'COMPLETED', // Directly matching
          },
        });

        // Update proposal status
        const updatedProposal = await tx.proposal.update({
          where: { id: proposal.id },
          data: { status: 'COMPLETED' },
          include: { creator: true },
        });

        return { deal, proposal: updatedProposal, acceptor };
      });

      const { proposal, acceptor } = result;

      // 2. Notify Creator (Seller/Buyer)
      const creatorMsg =
        `🔔 **خبر خوب! پیشنهاد شما پذیرفته شد.**\n\n` +
        `🔹 **جزئیات پیشنهاد شما:** ${proposal.amount.toLocaleString('fa-IR')} ${proposal.currency} با قیمت واحد ${proposal.price.toLocaleString('fa-IR')} تومان\n\n` +
        `👉 جهت هماهنگی، انجام معامله و مسائل مالی، لطفاً به ادمین ربات پیام دهید:\n` +
        `📣 آیدی ادمین: @${config.ADMIN_USERNAME}`;

      await ctx.telegram.sendMessage(proposal.creator.telegramId, creatorMsg, { parse_mode: 'Markdown' })
        .catch(err => console.error('Failed to notify creator:', err));

      // 3. Notify Acceptor (User who clicked)
      const acceptorMsg =
        `✅ **معامله با موفقیت ثبت شد.**\n\n` +
        `🔹 **جزئیات پیشنهاد:** ${proposal.amount.toLocaleString('fa-IR')} ${proposal.currency} با قیمت واحد ${proposal.price.toLocaleString('fa-IR')} تومان\n\n` +
        `👉 جهت هماهنگی، انجام معامله و مسائل مالی، لطفاً به ادمین ربات پیام دهید:\n` +
        `📣 آیدی ادمین: @${config.ADMIN_USERNAME}`;

      await ctx.replyWithMarkdown(acceptorMsg);
      await ctx.deleteMessage().catch(() => {});

      // 4. Notify Admin
      const creatorContact = proposal.creator.username 
        ? `@${proposal.creator.username}` 
        : `[${proposal.creator.firstName}](tg://user?id=${proposal.creator.telegramId})`;
      const acceptorContact = acceptor.username 
        ? `@${acceptor.username}` 
        : `[${acceptor.firstName}](tg://user?id=${acceptor.telegramId})`;

      const adminMsg =
        `🔔 **معامله جدید ثبت شد!**\n\n` +
        `📈 **جزئیات معامله:**\n` +
        `🔹 **نوع:** ${proposal.type === 'BUY' ? 'خرید' : 'فروش'}\n` +
        `🔹 **ارز:** ${proposal.currency}\n` +
        `🔹 **مقدار:** ${proposal.amount.toLocaleString('fa-IR')}\n` +
        `🔹 **قیمت واحد:** ${proposal.price.toLocaleString('fa-IR')} تومان\n` +
        `🔹 **مبلغ کل:** ${(proposal.amount * proposal.price).toLocaleString('fa-IR')} تومان\n\n` +
        `👤 **سازنده پیشنهاد (Creator):**\n` +
        `   - نام: ${proposal.creator.firstName} ${proposal.creator.lastName || ''}\n` +
        `   - یوزرنیم: ${creatorContact}\n` +
        `   - آیدی تلگرام: \`${proposal.creator.telegramId}\`\n\n` +
        `👤 **پذیرنده پیشنهاد (Acceptor):**\n` +
        `   - نام: ${acceptor.firstName} ${acceptor.lastName || ''}\n` +
        `   - یوزرنیم: ${acceptorContact}\n` +
        `   - آیدی تلگرام: \`${acceptor.telegramId}\``;

      await ctx.telegram.sendMessage(config.ADMIN_CHAT_ID, adminMsg, { parse_mode: 'Markdown' })
        .catch(err => console.error('Failed to notify admin:', err));

      // 5. Update the Group message to reflect status
      if (proposal.groupMessageId) {
        const updatedGroupText =
          `<b>🤝 #معامله_بسته_شد</b>\n\n` +
          `🔹 <b>ارز:</b> <code>${proposal.currency}</code>\n` +
          `🔹 <b>مقدار:</b> <code>${proposal.amount.toLocaleString('fa-IR')}</code>\n` +
          `🔹 <b>قیمت واحد:</b> <code>${proposal.price.toLocaleString('fa-IR')}</code> تومان\n` +
          `🔹 <b>مبلغ کل:</b> <code>${(proposal.amount * proposal.price).toLocaleString('fa-IR')}</code> تومان\n\n` +
          `✅ این پیشنهاد پذیرفته شد و جهت انجام مراحل بعدی به ادمین ارجاع گردید.`;

        await ctx.telegram.editMessageText(
          config.GROUP_CHAT_ID,
          proposal.groupMessageId,
          undefined,
          updatedGroupText,
          { parse_mode: 'HTML' }
        ).catch(err => console.error('Failed to update group message:', err));
      }

    } catch (error: any) {
      console.error('Error accepting deal:', error);
      if (error.message === 'PROPOSAL_NOT_PENDING' || error.message === 'PROPOSAL_NOT_FOUND') {
        await ctx.reply('⚠️ متاسفانه این پیشنهاد دیگر فعال نیست (معامله شده یا لغو شده است).');
      } else if (error.message === 'CANNOT_ACCEPT_OWN_PROPOSAL') {
        await ctx.reply('⚠️ شما نمی‌توانید پیشنهاد خودتان را قبول کنید!');
      } else {
        await ctx.reply('❌ در انجام معامله خطایی رخ داد. مجدداً تلاش کنید.');
      }
      await ctx.deleteMessage().catch(() => {});
    }
  }
}
