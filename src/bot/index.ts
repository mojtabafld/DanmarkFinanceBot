import { Telegraf, Scenes, session } from 'telegraf';
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

bot.use(session());
bot.use(stage.middleware());
bot.use(dynamicKeyboardMiddleware);

// Register Modular Handlers
registerAdminHandlers(bot);
registerProposalHandlers(bot);
registerDealHandlers(bot);
registerUserHandlers(bot);
