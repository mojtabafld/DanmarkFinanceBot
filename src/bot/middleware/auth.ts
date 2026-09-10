import { Context, MiddlewareFn, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';
import { mainKeyboard, getMainKeyboard, pendingVerificationKeyboard } from '../utils/keyboards';
import { escapeHtml } from '../utils/html';

export const dynamicKeyboardMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const telegramId = ctx.from?.id.toString() || '';

  const usesStaticMainKeyboard = (extra: any) =>
    extra === mainKeyboard ||
    (extra?.reply_markup &&
      (extra.reply_markup === mainKeyboard.reply_markup ||
        JSON.stringify(extra.reply_markup) === JSON.stringify(mainKeyboard.reply_markup)));

  /**
   * Swaps the static main keyboard for the one that matches the user's current
   * state, so a reply written against `mainKeyboard` still shows the extra
   * payment buttons when that user has a deal awaiting payment.
   */
  const withDynamicKeyboard = <R>(send: (text: string, extra: any) => Promise<R>) =>
    async (text: string, extra: any = {}): Promise<R> => {
      if (extra && typeof extra === 'object' && usesStaticMainKeyboard(extra)) {
        const dynamicKb = await getMainKeyboard(telegramId);
        extra = { ...extra, reply_markup: dynamicKb.reply_markup };
      }
      return send(text, extra);
    };

  ctx.reply = withDynamicKeyboard(ctx.reply.bind(ctx)) as typeof ctx.reply;
  ctx.replyWithHTML = withDynamicKeyboard(ctx.replyWithHTML.bind(ctx)) as typeof ctx.replyWithHTML;

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
          (user.rejectReason ? `💬 علت: ${escapeHtml(user.rejectReason)}\n\n` : '\n') +
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
