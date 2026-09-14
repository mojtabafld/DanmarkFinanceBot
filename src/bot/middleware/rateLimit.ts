import type { Context, MiddlewareFn } from 'telegraf';
import { consume } from '../../data/rateLimit';
import { t } from '../../i18n';

/**
 * Blanket flood control on incoming updates.
 *
 * There was previously no throttle anywhere, so one script could fill the trading
 * group, flood the admin chat, or drive the outbound rate scrape hard enough to get
 * the server blocked by the source.
 *
 * Callback queries are answered rather than dropped, because an unanswered query
 * leaves a spinner on the user's button until Telegram times it out.
 */
export const rateLimitMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const from = ctx.from;
  if (!from) return next();

  const result = await consume('general', from.id);
  if (result.allowed) return next();

  const message = t('limit.hit', { seconds: result.retryAfterSeconds });

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(message, { show_alert: true }).catch(() => {});
    return;
  }

  await ctx.reply(message).catch(() => {});
};
