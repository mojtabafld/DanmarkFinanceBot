import type { Context, MiddlewareFn } from 'telegraf';
import { t } from '../../i18n';
import { mainKeyboard } from '../utils/keyboards';

/**
 * One way out of any wizard.
 *
 * The twelve wizards each handled cancellation their own way, and several steps had
 * no way out at all, so a user could be stranded partway through identity
 * verification with every keyboard button being read as answer text.
 *
 * This runs before the scene stage: inside a wizard the stage would otherwise consume
 * the message as input for the current step.
 */
const CANCEL_WORDS = new Set([
  '/cancel',
  'انصراف',
  '✖️ انصراف',
  '❌ انصراف',
  '❌ لغو عملیات',
  'لغو'
]);

export const globalCancel: MiddlewareFn<Context> = async (ctx, next) => {
  const message = ctx.message;
  if (!message || !('text' in message)) return next();

  const text = message.text.trim();
  if (!CANCEL_WORDS.has(text)) return next();

  const scene = (ctx as any).scene;
  if (!scene?.current) return next();

  await scene.leave();
  await ctx.reply(t('cancelled'), mainKeyboard);
};
