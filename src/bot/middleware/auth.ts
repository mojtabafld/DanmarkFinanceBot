import { Context, MiddlewareFn, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';
import { mainKeyboard, getMainKeyboard, pendingVerificationKeyboard } from '../utils/keyboards';

export const dynamicKeyboardMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const telegramId = ctx.from?.id.toString() || '';

  const originalReply = ctx.reply.bind(ctx);
  ctx.reply = async (text: string, extra: any = {}) => {
    if (extra && typeof extra === 'object') {
      if (
        extra === mainKeyboard ||
        (extra.reply_markup &&
          (extra.reply_markup === mainKeyboard.reply_markup ||
            JSON.stringify(extra.reply_markup) === JSON.stringify(mainKeyboard.reply_markup)))
      ) {
        const dynamicKb = await getMainKeyboard(telegramId);
        extra.reply_markup = dynamicKb.reply_markup;
      }
    }
    return originalReply(text, extra);
  };

  const originalReplyWithHTML = ctx.replyWithHTML.bind(ctx);
  ctx.replyWithHTML = async (text: string, extra: any = {}) => {
    if (extra && typeof extra === 'object') {
      if (
        extra === mainKeyboard ||
        (extra.reply_markup &&
          (extra.reply_markup === mainKeyboard.reply_markup ||
            JSON.stringify(extra.reply_markup) === JSON.stringify(mainKeyboard.reply_markup)))
      ) {
        const dynamicKb = await getMainKeyboard(telegramId);
        extra.reply_markup = dynamicKb.reply_markup;
      }
    }
    return originalReplyWithHTML(text, extra);
  };

  const originalReplyWithMarkdown = ctx.replyWithMarkdown.bind(ctx);
  ctx.replyWithMarkdown = async (text: string, extra: any = {}) => {
    if (extra && typeof extra === 'object') {
      if (
        extra === mainKeyboard ||
        (extra.reply_markup &&
          (extra.reply_markup === mainKeyboard.reply_markup ||
            JSON.stringify(extra.reply_markup) === JSON.stringify(mainKeyboard.reply_markup)))
      ) {
        const dynamicKb = await getMainKeyboard(telegramId);
        extra.reply_markup = dynamicKb.reply_markup;
      }
    }
    return originalReplyWithMarkdown(text, extra);
  };

  return next();
};

export const checkVerified: MiddlewareFn<Context> = async (ctx, next) => {
  const from = ctx.from;
  if (!from) return;

  try {
    const user = await prisma.user.findUnique({
      where: { telegramId: from.id.toString() }
    });

    if (user?.verificationStatus === 'APPROVED') {
      try {
        const member = await ctx.telegram.getChatMember(config.GROUP_CHAT_ID, from.id);
        const isActiveMember = ['member', 'administrator', 'creator'].includes(member.status);

        if (isActiveMember) {
          return next();
        }

        const inviteLink = await ctx.telegram.createChatInviteLink(config.GROUP_CHAT_ID, {
          member_limit: 1,
          name: `Re-invite for ${user.fullName || from.first_name}`,
          expire_date: Math.floor(Date.now() / 1000) + 86400
        });

        await ctx.reply(
          '⚠️ کاربر گرامی، احراز هویت شما تایید شده است، اما برای ثبت پیشنهاد یا فعالیت در ربات باید عضو گروه معاملاتی باشید.\n\n' +
            'لطفاً ابتدا از طریق لینک زیر وارد گروه شوید و سپس اقدام کنید:\n' +
            `🔗 ${inviteLink.invite_link}`,
          mainKeyboard
        );
        return;
      } catch (err) {
        console.error('Error checking group membership in middleware:', err);
        return next();
      }
    }

    if (user?.verificationStatus === 'PENDING') {
      await ctx.reply(
        '⏳ مدارک احراز هویت شما در حال بررسی توسط مدیریت است. لطفا منتظر بمانید.',
        pendingVerificationKeyboard
      );
      return;
    }

    if (user?.verificationStatus === 'DEACTIVATED') {
      await ctx.reply(
        '⚠️ حساب کاربری شما موقتاً غیرفعال شده است. جهت استفاده از امکانات ربات باید ابتدا حساب خود را فعال کنید.',
        Markup.keyboard([['🔄 فعال‌سازی حساب کاربری']]).resize()
      );
      return;
    }

    if (user?.verificationStatus === 'REJECTED') {
      await ctx.reply(
        `❌ متاسفانه احراز هویت شما تایید نشده است.\n` +
          (user.rejectReason ? `💬 علت: ${user.rejectReason}\n\n` : '\n') +
          `جهت شروع مجدد، دکمه زیر را کلیک کنید:`,
        Markup.keyboard([['🔐 شروع احراز هویت']]).resize()
      );
      return;
    }

    await ctx.reply(
      '⚠️ برای دسترسی به امکانات ربات ابتدا باید احراز هویت شوید.',
      Markup.keyboard([['🔐 شروع احراز هویت']]).resize()
    );
  } catch (error) {
    console.error('Error checking verification middleware:', error);
    await ctx.reply('خطا در بررسی وضعیت احراز هویت.');
  }
};

export const requireAdmin: MiddlewareFn<Context> = async (ctx, next) => {
  const from = ctx.from;
  if (!from || from.id.toString() !== config.ADMIN_CHAT_ID.toString()) {
    await ctx.reply('⚠️ شما دسترسی به بخش مدیریت ندارید.');
    return;
  }
  return next();
};
