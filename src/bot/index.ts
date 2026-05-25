import { Telegraf, Scenes, session, Markup } from 'telegraf';
import { config } from '../config';
import { prisma } from '../database/db';
import { createProposalWizard, CREATE_PROPOSAL_SCENE_ID, MyWizardContext } from './scenes/createProposal';
import { verifyUserWizard, VERIFY_USER_SCENE_ID } from './scenes/verifyUser';
import { handleDeepLink, handleDealCallbacks } from './handlers/deepLink';

// Set up the custom context type for the bot
export interface BotContext extends MyWizardContext {}

export const bot = new Telegraf<BotContext>(config.BOT_TOKEN);

// Register Session and Scenes Middleware
const stage = new Scenes.Stage<BotContext>([createProposalWizard, verifyUserWizard]);
bot.use(session());
bot.use(stage.middleware());

// Main Keyboard Markup (For Approved Users)
const mainKeyboard = Markup.keyboard([
  ['📝 ثبت پیشنهاد جدید'],
  ['📋 پیشنهادهای فعال من', '❓ راهنما']
]).resize();

// Helper middleware to check if user is verified
const checkVerified = async (ctx: BotContext, next: () => Promise<void>) => {
  const from = ctx.from;
  if (!from) return;

  try {
    const user = await prisma.user.findUnique({
      where: { telegramId: from.id.toString() }
    });

    if (user?.verificationStatus === 'APPROVED') {
      return next();
    }

    if (user?.verificationStatus === 'PENDING') {
      await ctx.reply('⏳ مدارک احراز هویت شما در حال بررسی توسط مدیریت است. لطفا منتظر بمانید.');
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

    // Default: UNVERIFIED
    await ctx.reply(
      '⚠️ برای دسترسی به امکانات ربات ابتدا باید احراز هویت شوید.',
      Markup.keyboard([['🔐 شروع احراز هویت']]).resize()
    );
  } catch (error) {
    console.error('Error checking verification middleware:', error);
    await ctx.reply('خطا در بررسی وضعیت احراز هویت.');
  }
};

// Command /start handler
bot.start(async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  // Check if it's a deep link (e.g. from the group button)
  const payload = ctx.startPayload;
  if (payload) {
    // We allow deep link handler to check verification internally
    await handleDeepLink(ctx, payload);
    return;
  }

  try {
    // Register/Upsert user in DB
    const dbUser = await prisma.user.upsert({
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

    if (dbUser.verificationStatus === 'UNVERIFIED') {
      await ctx.reply(
        `سلام ${from.first_name} عزیز! 🌸\n` +
        `به ربات خرید و فروش ارز خوش آمدید.\n\n` +
        `⚠️ برای شروع استفاده از ربات و عضویت در گروه معاملاتی، ابتدا باید احراز هویت خود را تکمیل کنید.`,
        Markup.keyboard([['🔐 شروع احراز هویت']]).resize()
      );
      return;
    }

    if (dbUser.verificationStatus === 'PENDING') {
      await ctx.reply(
        `⏳ مدارک احراز هویت شما قبلاً ارسال شده و در حال بررسی توسط مدیریت است.\n` +
        `پس از تایید ادمین، لینک ورود به گروه معاملاتی برای شما ارسال خواهد شد.`,
        Markup.removeKeyboard()
      );
      return;
    }

    if (dbUser.verificationStatus === 'REJECTED') {
      await ctx.reply(
        `❌ متاسفانه درخواست احراز هویت شما مورد تایید قرار نگرفت.\n` +
        (dbUser.rejectReason ? `💬 علت رد درخواست: ${dbUser.rejectReason}\n\n` : '\n') +
        `می‌توانید مجدداً تلاش کنید:`,
        Markup.keyboard([['🔐 شروع احراز هویت']]).resize()
      );
      return;
    }

    // Approved user
    await ctx.reply(
      `سلام ${from.first_name} عزیز! 🌸\n` +
      `احراز هویت شما قبلا تایید شده است. می‌توانید از دکمه‌های زیر استفاده کنید:`,
      mainKeyboard
    );

  } catch (error) {
    console.error('Error in start command:', error);
    await ctx.reply('سلام! به ربات خوش آمدید. خطایی در برقراری ارتباط رخ داده است.');
  }
});

// Help command
bot.help(checkVerified, async (ctx) => {
  await ctx.reply(
    `📖 **راهنمای ربات:**\n\n` +
    `۱. برای ثبت پیشنهاد جدید دکمه **📝 ثبت پیشنهاد جدید** را بزنید و مراحل را طی کنید.\n` +
    `۲. پیشنهاد شما به گروه ارسال خواهد شد و کاربران دیگر می‌توانند آن را قبول کنند.\n` +
    `۳. برای دیدن پیشنهادهایی که ثبت کرده‌اید و لغو آنها، از دکمه **📋 پیشنهادهای فعال من** استفاده کنید.\n` +
    `۴. در صورت پذیرفته شدن پیشنهاد شما توسط کاربری در گروه، جزئیات معامله جهت انجام مراحل بعدی به ادمین ارسال شده و آیدی ادمین برای شما فرستاده می‌شود.`,
    mainKeyboard
  );
});

// Start verification hears
bot.hears('🔐 شروع احراز هویت', async (ctx) => {
  await ctx.scene.enter(VERIFY_USER_SCENE_ID);
});

// Text command handlers (Protected with checkVerified middleware)
bot.hears('📝 ثبت پیشنهاد جدید', checkVerified, async (ctx) => {
  // Enter the creation wizard scene
  await ctx.scene.enter(CREATE_PROPOSAL_SCENE_ID);
});

bot.hears('📋 پیشنهادهای فعال من', checkVerified, async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  try {
    const user = await prisma.user.findUnique({
      where: { telegramId: from.id.toString() },
      include: {
        proposals: {
          where: { status: 'PENDING' },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    const activeProposals = user?.proposals || [];

    if (activeProposals.length === 0) {
      await ctx.reply('⚠️ شما هیچ پیشنهاد فعالی در گروه ندارید.');
      return;
    }

    await ctx.reply(`📋 لیست پیشنهادهای فعال شما (${activeProposals.length} مورد):`);

    for (const prop of activeProposals) {
      const typeText = prop.type === 'BUY' ? '🟢 خرید' : '🔴 فروش';
      const msg = 
        `🔸 **ارز:** ${prop.currency}\n` +
        `🔸 **نوع:** ${typeText}\n` +
        `🔸 **مقدار:** ${prop.amount.toLocaleString('fa-IR')}\n` +
        `🔸 **قیمت واحد:** ${prop.price.toLocaleString('fa-IR')} تومان\n` +
        `🔸 **مبلغ کل:** ${(prop.amount * prop.price).toLocaleString('fa-IR')} تومان`;

      await ctx.reply(msg, 
        Markup.inlineKeyboard([
          [Markup.button.callback('❌ لغو این پیشنهاد', `CANCEL_MY_PROP_${prop.id}`)]
        ])
      );
    }
  } catch (error) {
    console.error('Error fetching active proposals:', error);
    await ctx.reply('❌ خطا در بارگذاری پیشنهادها.');
  }
});

bot.hears('❓ راهنما', checkVerified, async (ctx) => {
  await ctx.reply(
    `📖 **راهنمای ربات:**\n\n` +
    `۱. برای ثبت پیشنهاد جدید دکمه **📝 ثبت پیشنهاد جدید** را بزنید و مراحل را طی کنید.\n` +
    `۲. پیشنهاد شما به گروه ارسال خواهد شد و کاربران دیگر می‌توانند آن را قبول کنند.\n` +
    `۳. برای دیدن پیشنهادهایی که ثبت کرده‌اید و لغو آنها، از دکمه **📋 پیشنهادهای فعال من** استفاده کنید.\n` +
    `۴. در صورت پذیرفته شدن پیشنهاد شما توسط کاربری در گروه، جزئیات معامله جهت انجام مراحل بعدی به ادمین ارسال شده و آیدی ادمین برای شما فرستاده می‌شود.`,
    mainKeyboard
  );
});

// Handle standard callback queries (like canceling user proposals or deal confirmations)
bot.on('callback_query', async (ctx) => {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  const data = ctx.callbackQuery.data;

  const from = ctx.from;
  if (!from) return;

  // Handle Admin User Approvals
  if (data.startsWith('APPROVE_USER_')) {
    const userId = parseInt(data.replace('APPROVE_USER_', ''), 10);
    await ctx.answerCbQuery();
    if (isNaN(userId)) return;

    try {
      const user = await prisma.user.update({
        where: { id: userId },
        data: { verificationStatus: 'APPROVED' }
      });

      // Generate a single-use invite link to the group (valid for 24 hours)
      const inviteLink = await ctx.telegram.createChatInviteLink(config.GROUP_CHAT_ID, {
        member_limit: 1,
        name: `Invite for ${user.fullName}`,
        expire_date: Math.floor(Date.now() / 1000) + 86400 // 24 hours
      });

      // Notify the User
      const userMsg =
        `🎉 **احراز هویت شما با موفقیت توسط مدیریت تایید شد!**\n\n` +
        `لینک عضویت یک‌بار مصرف شما در گروه معاملاتی دانمارک (دارای اعتبار ۲۴ ساعته):\n` +
        `🔗 ${inviteLink.invite_link}\n\n` +
        `پس از عضویت در گروه، با اجرای مجدد ربات می‌توانید پیشنهادهای خود را ثبت کنید.`;
      
      await ctx.telegram.sendMessage(user.telegramId, userMsg, { parse_mode: 'Markdown' });

      // Update Admin Message
      await ctx.editMessageCaption(
        `✅ **احراز هویت کاربر تایید شد**\n\n` +
        `👤 **نام کامل:** ${user.fullName}\n` +
        `🌍 **کشور:** ${user.country}\n` +
        `📱 **تلفن:** ${user.phoneNumber}\n\n` +
        `🔗 لینک عضویت صادر و ارسال شد.`
      ).catch(() => {});

    } catch (error) {
      console.error('Error approving user:', error);
      await ctx.reply('❌ خطا در تایید درخواست احراز هویت.');
    }
    return;
  }

  // Handle Admin User Rejections
  if (data.startsWith('REJECT_USER_')) {
    const userId = parseInt(data.replace('REJECT_USER_', ''), 10);
    await ctx.answerCbQuery();
    if (isNaN(userId)) return;

    try {
      const user = await prisma.user.update({
        where: { id: userId },
        data: { verificationStatus: 'REJECTED' }
      });

      // Notify the User
      const userMsg =
        `❌ **درخواست احراز هویت شما مورد تایید قرار نگرفت.**\n\n` +
        `شما می‌توانید با زدن دکمه «🔐 شروع احراز هویت» مجدداً تلاش کرده و مدارک هویتی معتبر ارسال کنید.`;
      
      await ctx.telegram.sendMessage(user.telegramId, userMsg);

      // Update Admin Message
      await ctx.editMessageCaption(
        `❌ **احراز هویت کاربر رد صلاحیت شد**\n\n` +
        `👤 **نام کامل:** ${user.fullName}\n` +
        `🌍 **کشور:** ${user.country}\n` +
        `📱 **تلفن:** ${user.phoneNumber}`
      ).catch(() => {});

    } catch (error) {
      console.error('Error rejecting user:', error);
      await ctx.reply('❌ خطا در رد درخواست احراز هویت.');
    }
    return;
  }

  // Handle My Proposal Cancellation
  if (data.startsWith('CANCEL_MY_PROP_')) {
    const propId = parseInt(data.replace('CANCEL_MY_PROP_', ''), 10);
    await ctx.answerCbQuery();

    if (isNaN(propId)) return;

    try {
      // Find proposal and verify ownership
      const prop = await prisma.proposal.findUnique({
        where: { id: propId },
        include: { creator: true }
      });

      if (!prop || prop.creator.telegramId !== from.id.toString()) {
        await ctx.reply('⚠️ شما مجاز به لغو این پیشنهاد نیستید.');
        return;
      }

      if (prop.status !== 'PENDING') {
        await ctx.reply('⚠️ این پیشنهاد قبلاً معامله یا لغو شده است.');
        await ctx.deleteMessage().catch(() => {});
        return;
      }

      // Update state in database
      await prisma.proposal.update({
        where: { id: propId },
        data: { status: 'CANCELLED' }
      });

      await ctx.reply('✅ پیشنهاد شما با موفقیت لغو شد.');
      await ctx.deleteMessage().catch(() => {});

      // Update the message in the group to show it is cancelled
      if (prop.groupMessageId) {
        const updatedGroupText =
          `<b>❌ #پیشنهاد_لغو_شد</b>\n\n` +
          `🔹 <b>ارز:</b> <code>${prop.currency}</code>\n` +
          `🔹 <b>مقدار:</b> <code>${prop.amount.toLocaleString('fa-IR')}</code>\n` +
          `🔹 <b>قیمت واحد:</b> <code>${prop.price.toLocaleString('fa-IR')}</code> تومان\n\n` +
          `⚠️ این پیشنهاد توسط ثبت‌کننده آن لغو گردید.`;

        await ctx.telegram.editMessageText(
          config.GROUP_CHAT_ID,
          prop.groupMessageId,
          undefined,
          updatedGroupText,
          { parse_mode: 'HTML' }
        ).catch(err => console.error('Failed to update group message on cancel:', err));
      }

    } catch (error) {
      console.error('Error canceling user proposal:', error);
      await ctx.reply('❌ خطا در لغو پیشنهاد.');
    }
    return;
  }

  // Delegate deal-specific callbacks to deepLink handler
  if (data.startsWith('ACCEPT_DEAL_') || data === 'CANCEL_DEAL') {
    await handleDealCallbacks(ctx);
    return;
  }
});
