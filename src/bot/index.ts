import { Telegraf, Scenes, session } from 'telegraf';
import { createPrismaSessionStore } from '../database/sessionStore';
import { config } from '../config';

// Import Wizard Scenes
import { createProposalWizard, MyWizardContext } from './scenes/createProposal';
import { verifyUserWizard } from './scenes/verifyUser';
import { adminSearchWizard } from './scenes/adminSearch';
import { adminEditUserWizard, adminRejectUserWizard } from './scenes/adminEditUser';
import { adminEditPropWizard } from './scenes/adminEditProp';
import { acceptDealWizard } from './scenes/dealWizard';
import { editProposalWizard } from './scenes/editProposal';
import { adminUpdateRatesWizard } from './scenes/adminUpdateRates';
import { requestLimitIncreaseWizard } from './scenes/requestLimitIncrease';
import { manageAdsWizard } from './scenes/manageAds';
import { manageOffersWizard } from './scenes/manageOffers';
import { uploadReceiptWizard } from './scenes/uploadReceipt';

// Import Middleware and Domain Handlers
import { dynamicKeyboardMiddleware } from './middleware/auth';
import { registerAdminHandlers } from './handlers/adminHandlers';
import { registerProposalHandlers } from './handlers/proposalHandlers';
import { registerDealHandlers } from './handlers/dealHandlers';
import { registerUserHandlers } from './handlers/userHandlers';

// Custom Bot Context
export interface BotContext extends MyWizardContext {}

export const bot = new Telegraf<BotContext>(config.BOT_TOKEN);

/**
 * Telegram API methods that accept a `parse_mode` alongside their text or caption.
 */
const PARSE_MODE_METHODS = new Set([
  'sendMessage',
  'editMessageText',
  'sendPhoto',
  'editMessageCaption',
  'sendDocument',
  'sendVideo',
  'sendAnimation',
  'sendAudio',
  'sendVoice',
  'copyMessage'
]);

/**
 * Every message this bot composes is written in Telegram's HTML flavour, so default
 * `parse_mode` to HTML at the API boundary instead of relying on each of the ~200
 * call sites to remember it. Call sites that pass an explicit parse_mode still win.
 *
 * Because this makes markup active everywhere, any user-supplied value interpolated
 * into a message MUST go through `escapeHtml` from ./utils/html.
 */
const originalCallApi = bot.telegram.callApi.bind(bot.telegram);
(bot.telegram as any).callApi = (method: string, payload: any, ...rest: any[]) => {
  if (
    payload &&
    typeof payload === 'object' &&
    PARSE_MODE_METHODS.has(method) &&
    payload.parse_mode === undefined
  ) {
    payload = { ...payload, parse_mode: 'HTML' };
  }
  return originalCallApi(method as any, payload, ...rest);
};

// Register Session and Scenes Middleware Stage
const stage = new Scenes.Stage<BotContext>([
  createProposalWizard,
  verifyUserWizard,
  adminSearchWizard,
  adminEditUserWizard,
  adminRejectUserWizard,
  adminEditPropWizard,
  acceptDealWizard,
  editProposalWizard,
  adminUpdateRatesWizard,
  requestLimitIncreaseWizard,
  manageAdsWizard,
  manageOffersWizard,
  uploadReceiptWizard
]);

bot.use(session({ store: createPrismaSessionStore<any>() }));
bot.use(stage.middleware());
bot.use(dynamicKeyboardMiddleware);

// Register Modular Handlers
registerAdminHandlers(bot);
registerProposalHandlers(bot);
registerDealHandlers(bot);
registerUserHandlers(bot);

/**
 * Last-resort handler. Without it a single rejected Telegram API call inside a
 * handler surfaces as an unhandled rejection, which on Node 20 terminates the
 * process and takes the whole bot down for every user.
 */
bot.catch(async (err, ctx) => {
  console.error(`Unhandled error while processing ${ctx.updateType}:`, err);
  try {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('❌ خطای غیرمنتظره. لطفاً دوباره تلاش کنید.', { show_alert: true });
    } else if (ctx.chat) {
      await ctx.reply('❌ خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.');
    }
  } catch (replyErr) {
    console.error('Failed to notify user about the error:', replyErr);
  }
});
