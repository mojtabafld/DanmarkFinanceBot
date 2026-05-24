import { Telegraf, Scenes, session, Markup, Context } from 'telegraf';
import { config } from '../config';
import { prisma } from '../database/db';
import { createProposalWizard, CREATE_PROPOSAL_SCENE_ID, MyWizardContext } from './scenes/createProposal';
import { handleDeepLink, handleDealCallbacks } from './handlers/deepLink';

// Set up the custom context type for the bot
export interface BotContext extends MyWizardContext {}

export const bot = new Telegraf<BotContext>(config.BOT_TOKEN);

// Register Session and Scenes Middleware
const stage = new Scenes.Stage<BotContext>([createProposalWizard]);
bot.use(session());
bot.use(stage.middleware());

// Main Keyboard Markup
const mainKeyboard = Markup.keyboard([
  ['📝 ثبت پیشنهاد جدید'],
  ['📋 پیشنهادهای فعال من', '❓ راهنما']
]).resize();

// Command /start handler
bot.start(async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  // Check if it's a deep link (e.g. from the group button)
  const payload = ctx.startPayload;
  if (payload) {
    await handleDeepLink(ctx, payload);
    return;
  }

  try {
    // Register/Upsert user in DB
    await prisma.user.upsert({
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

    await ctx.reply(
      `سلام ${from.first_name} عزیز! 🌸\n` +
      `به ربات خرید و فروش ارز خوش آمدید.\n\n` +
      `با استفاده از دکمه‌های زیر می‌توانید پیشنهاد خود را ثبت کنید یا پیشنهادهای فعلی خود را مدیریت کنید.`,
      mainKeyboard
    );
  } catch (error) {
    console.error('Error in start command:', error);
    await ctx.reply('سلام! به ربات خوش آمدید. در ارتباط با دیتابیس مشکلی رخ داده است اما می‌توانید از دکمه‌های زیر استفاده کنید.', mainKeyboard);
  }
});

// Help command
bot.help(async (ctx) => {
  await ctx.reply(
    `📖 **راهنمای ربات:**\n\n` +
    `۱. برای ثبت پیشنهاد جدید دکمه **📝 ثبت پیشنهاد جدید** را بزنید و مراحل را طی کنید.\n` +
    `۲. پیشنهاد شما به گروه ارسال خواهد شد و کاربران دیگر می‌توانند آن را قبول کنند.\n` +
    `۳. برای دیدن پیشنهادهایی که ثبت کرده‌اید و لغو آنها، از دکمه **📋 پیشنهادهای فعال من** استفاده کنید.\n` +
    `۴. در صورت پذیرفته شدن پیشنهاد شما توسط کاربری در گروه، جزئیات معامله جهت انجام مراحل بعدی به ادمین ارسال شده و آیدی ادمین برای شما فرستاده می‌شود.`,
    mainKeyboard
  );
});

// Text command handlers
bot.hears('📝 ثبت پیشنهاد جدید', async (ctx) => {
  // Enter the creation wizard scene
  await ctx.scene.enter(CREATE_PROPOSAL_SCENE_ID);
});

bot.hears('📋 پیشنهادهای فعال من', async (ctx) => {
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

bot.hears('❓ راهنما', async (ctx) => {
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
