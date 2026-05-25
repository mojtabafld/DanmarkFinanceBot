import { Telegraf, Scenes, session, Markup } from 'telegraf';
import { config } from '../config';
import { prisma } from '../database/db';
import { createProposalWizard, CREATE_PROPOSAL_SCENE_ID, MyWizardContext } from './scenes/createProposal';
import { verifyUserWizard, VERIFY_USER_SCENE_ID } from './scenes/verifyUser';
import { adminSearchWizard, ADMIN_SEARCH_SCENE_ID } from './scenes/adminSearch';
import { adminEditUserWizard, adminRejectUserWizard, ADMIN_EDIT_USER_SCENE_ID, ADMIN_REJECT_USER_SCENE_ID } from './scenes/adminEditUser';
import { adminEditPropWizard, ADMIN_EDIT_PROP_SCENE_ID } from './scenes/adminEditProp';
import { handleDeepLink, handleDealCallbacks } from './handlers/deepLink';
import { counterOfferWizard, COUNTER_OFFER_SCENE_ID } from './scenes/counterOffer';
import { updateGroupProposalMessage } from './utils/groupMessage';
import { mainKeyboard, verifyStartKeyboard } from './utils/keyboards';

// Set up the custom context type for the bot
export interface BotContext extends MyWizardContext {}

export const bot = new Telegraf<BotContext>(config.BOT_TOKEN);

// Register Session and Scenes Middleware
const stage = new Scenes.Stage<BotContext>([
  createProposalWizard,
  verifyUserWizard,
  adminSearchWizard,
  adminEditUserWizard,
  adminRejectUserWizard,
  adminEditPropWizard,
  counterOfferWizard
]);
bot.use(session());
bot.use(stage.middleware());



// Helper middleware to check if user is verified
const checkVerified = async (ctx: BotContext, next: () => Promise<void>) => {
  const from = ctx.from;
  if (!from) return;

  try {
    const user = await prisma.user.findUnique({
      where: { telegramId: from.id.toString() }
    });

    if (user?.verificationStatus === 'APPROVED') {
      // User is verified in DB. Now dynamically check if they are in the group!
      try {
        const member = await ctx.telegram.getChatMember(config.GROUP_CHAT_ID, from.id);
        const isActiveMember = ['member', 'administrator', 'creator'].includes(member.status);
        
        if (isActiveMember) {
          return next();
        }

        // User is verified in DB but NOT in the group. Regenerate invite link and tell them to join!
        const inviteLink = await ctx.telegram.createChatInviteLink(config.GROUP_CHAT_ID, {
          member_limit: 1,
          name: `Re-invite for ${user.fullName || from.first_name}`,
          expire_date: Math.floor(Date.now() / 1000) + 86400 // 24 hours
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
        // Fallback to allow if API call fails due to missing bot rights
        return next();
      }
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
        verifyStartKeyboard
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

// Admin Command (Restricted to config.ADMIN_CHAT_ID)
bot.command('admin', async (ctx) => {
  const from = ctx.from;
  if (!from || from.id.toString() !== config.ADMIN_CHAT_ID.toString()) {
    await ctx.reply('⚠️ شما مجاز به استفاده از این دستور نیستید.');
    return;
  }

  await ctx.reply(
    '⚙️ <b>منوی مدیریت ربات DanmarkFinance:</b>\n\n' +
    'یکی از گزینه‌های زیر را انتخاب کنید:',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('👥 تایید شده‌ها', 'ADMIN_LIST_APPROVED'),
          Markup.button.callback('⏳ در انتظار تایید', 'ADMIN_LIST_PENDING')
        ],
        [
          Markup.button.callback('❌ رد صلاحیت شده‌ها', 'ADMIN_LIST_REJECTED'),
          Markup.button.callback('🔍 جستجوی کاربر', 'ADMIN_SEARCH_USER')
        ],
        [
          Markup.button.callback('📋 مدیریت پیشنهادات', 'ADMIN_LIST_PROPOSALS'),
          Markup.button.callback('📊 آمار کل سیستم', 'ADMIN_STATS')
        ],
        [Markup.button.callback('❌ بستن منو', 'ADMIN_CLOSE')]
      ])
    }
  );
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

// Catch-all text handler for verified users to restore keyboard
bot.on('text', checkVerified, async (ctx) => {
  await ctx.reply('لطفاً جهت استفاده از امکانات ربات، یکی از دکمه‌های زیر را انتخاب کنید:', mainKeyboard);
});

// Handle standard callback queries
bot.on('callback_query', async (ctx) => {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  const data = ctx.callbackQuery.data;

  const from = ctx.from;
  if (!from) return;

  const isAdmin = from.id.toString() === config.ADMIN_CHAT_ID.toString();

  // ADMIN CALLBACKS
  if (isAdmin) {
    // 1. Admin Close Menu
    if (data === 'ADMIN_CLOSE') {
      await ctx.answerCbQuery();
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    // 2. Admin Main Menu
    if (data === 'ADMIN_MAIN_MENU') {
      await ctx.answerCbQuery();
      const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;
      if (hasPhoto) {
        await ctx.deleteMessage().catch(() => {});
        await ctx.reply(
          '⚙️ <b>منوی مدیریت ربات DanmarkFinance:</b>\n\n' +
          'یکی از گزینه‌های زیر را انتخاب کنید:',
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('👥 تایید شده‌ها', 'ADMIN_LIST_APPROVED'),
                Markup.button.callback('⏳ در انتظار تایید', 'ADMIN_LIST_PENDING')
              ],
              [
                Markup.button.callback('❌ رد صلاحیت شده‌ها', 'ADMIN_LIST_REJECTED'),
                Markup.button.callback('🔍 جستجوی کاربر', 'ADMIN_SEARCH_USER')
              ],
              [
                Markup.button.callback('📋 مدیریت پیشنهادات', 'ADMIN_LIST_PROPOSALS'),
                Markup.button.callback('📊 آمار کل سیستم', 'ADMIN_STATS')
              ],
              [Markup.button.callback('❌ بستن منو', 'ADMIN_CLOSE')]
            ])
          }
        );
      } else {
        await ctx.editMessageText(
          '⚙️ <b>منوی مدیریت ربات DanmarkFinance:</b>\n\n' +
          'یکی از گزینه‌های زیر را انتخاب کنید:',
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('👥 تایید شده‌ها', 'ADMIN_LIST_APPROVED'),
                Markup.button.callback('⏳ در انتظار تایید', 'ADMIN_LIST_PENDING')
              ],
              [
                Markup.button.callback('❌ رد صلاحیت شده‌ها', 'ADMIN_LIST_REJECTED'),
                Markup.button.callback('🔍 جستجوی کاربر', 'ADMIN_SEARCH_USER')
              ],
              [
                Markup.button.callback('📋 مدیریت پیشنهادات', 'ADMIN_LIST_PROPOSALS'),
                Markup.button.callback('📊 آمار کل سیستم', 'ADMIN_STATS')
              ],
              [Markup.button.callback('❌ بستن منو', 'ADMIN_CLOSE')]
            ])
          }
        ).catch(() => {});
      }
      return;
    }

    // 3. Admin System Stats
    if (data === 'ADMIN_STATS') {
      await ctx.answerCbQuery();
      try {
        const approvedCount = await prisma.user.count({ where: { verificationStatus: 'APPROVED' } });
        const pendingCount = await prisma.user.count({ where: { verificationStatus: 'PENDING' } });
        const rejectedCount = await prisma.user.count({ where: { verificationStatus: 'REJECTED' } });
        
        const pendingProps = await prisma.proposal.count({ where: { status: 'PENDING' } });
        const completedProps = await prisma.proposal.count({ where: { status: 'COMPLETED' } });

        const statsText =
          `📊 <b>آمار کل سیستم ربات DanmarkFinance:</b>\n\n` +
          `👥 <b>وضعیت کاربران:</b>\n` +
          `  - تایید شده: <code>${approvedCount}</code> نفر\n` +
          `  - در انتظار تایید: <code>${pendingCount}</code> نفر\n` +
          `  - رد صلاحیت شده: <code>${rejectedCount}</code> نفر\n\n` +
          `📈 <b>پیشنهادات ثبت شده:</b>\n` +
          `  - پیشنهادهای فعال: <code>${pendingProps}</code> مورد\n` +
          `  - معاملات موفق: <code>${completedProps}</code> مورد`;

        await ctx.editMessageText(statsText, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔙 بازگشت', 'ADMIN_MAIN_MENU')]
          ])
        }).catch(() => {});
      } catch (error) {
        console.error('Error fetching admin stats:', error);
        await ctx.reply('خطا در بارگذاری آمار.');
      }
      return;
    }

    // 4. Admin List Approved Users (Paginated)
    if (data === 'ADMIN_LIST_APPROVED' || data.startsWith('ADMIN_LIST_APP_')) {
      await ctx.answerCbQuery();
      const page = data.startsWith('ADMIN_LIST_APP_') ? parseInt(data.replace('ADMIN_LIST_APP_', ''), 10) : 0;
      const pageSize = 10;
      try {
        const total = await prisma.user.count({ where: { verificationStatus: 'APPROVED' } });
        const users = await prisma.user.findMany({
          where: { verificationStatus: 'APPROVED' },
          skip: page * pageSize,
          take: pageSize,
          orderBy: { updatedAt: 'desc' }
        });

        const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;

        if (users.length === 0 && page === 0) {
          const emptyText = '👥 هیچ کاربر تاییدشده‌ای یافت نشد.';
          const emptyMarkup = Markup.inlineKeyboard([[Markup.button.callback('🔙 بازگشت', 'ADMIN_MAIN_MENU')]]);
          if (hasPhoto) {
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(emptyText, emptyMarkup);
          } else {
            await ctx.editMessageText(emptyText, emptyMarkup).catch(() => {});
          }
          return;
        }

        const buttons = users.map(u => [
          Markup.button.callback(
            `${u.fullName || u.firstName} (@${u.username || 'ندارد'})`,
            `ADMIN_USER_VIEW_${u.id}`
          )
        ]);

        const navRow = [];
        if (page > 0) {
          navRow.push(Markup.button.callback('⬅️ صفحه قبل', `ADMIN_LIST_APP_${page - 1}`));
        }
        if ((page + 1) * pageSize < total) {
          navRow.push(Markup.button.callback('صفحه بعد ➡️', `ADMIN_LIST_APP_${page + 1}`));
        }
        if (navRow.length > 0) {
          buttons.push(navRow);
        }

        buttons.push([Markup.button.callback('🔙 بازگشت به منو', 'ADMIN_MAIN_MENU')]);

        const totalPages = Math.ceil(total / pageSize) || 1;
        const msgText = `👥 <b>لیست کاربران تایید شده:</b>\n` +
          `صفحه <code>${page + 1}</code> از <code>${totalPages}</code> (کل: <code>${total}</code> نفر)\n\n` +
          `برای مشاهده مشخصات و مدیریت هر کاربر کلیک کنید:`;

        const markup = {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(buttons)
        };

        if (hasPhoto) {
          await ctx.deleteMessage().catch(() => {});
          await ctx.reply(msgText, markup as any);
        } else {
          await ctx.editMessageText(msgText, markup as any).catch(() => {});
        }
      } catch (error) {
        console.error('Error listing approved users:', error);
      }
      return;
    }

    // 5. Admin List Pending Users (Paginated)
    if (data === 'ADMIN_LIST_PENDING' || data.startsWith('ADMIN_LIST_PEN_')) {
      await ctx.answerCbQuery();
      const page = data.startsWith('ADMIN_LIST_PEN_') ? parseInt(data.replace('ADMIN_LIST_PEN_', ''), 10) : 0;
      const pageSize = 10;
      try {
        const total = await prisma.user.count({ where: { verificationStatus: 'PENDING' } });
        const users = await prisma.user.findMany({
          where: { verificationStatus: 'PENDING' },
          skip: page * pageSize,
          take: pageSize,
          orderBy: { createdAt: 'desc' }
        });

        const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;

        if (users.length === 0 && page === 0) {
          const emptyText = '⏳ هیچ درخواستی در انتظار تایید نیست.';
          const emptyMarkup = Markup.inlineKeyboard([[Markup.button.callback('🔙 بازگشت', 'ADMIN_MAIN_MENU')]]);
          if (hasPhoto) {
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(emptyText, emptyMarkup);
          } else {
            await ctx.editMessageText(emptyText, emptyMarkup).catch(() => {});
          }
          return;
        }

        const buttons = users.map(u => [
          Markup.button.callback(
            `⏳ ${u.fullName || u.firstName} (@${u.username || 'ندارد'})`,
            `ADMIN_USER_VIEW_${u.id}`
          )
        ]);

        const navRow = [];
        if (page > 0) {
          navRow.push(Markup.button.callback('⬅️ صفحه قبل', `ADMIN_LIST_PEN_${page - 1}`));
        }
        if ((page + 1) * pageSize < total) {
          navRow.push(Markup.button.callback('صفحه بعد ➡️', `ADMIN_LIST_PEN_${page + 1}`));
        }
        if (navRow.length > 0) {
          buttons.push(navRow);
        }

        buttons.push([Markup.button.callback('🔙 بازگشت به منو', 'ADMIN_MAIN_MENU')]);

        const totalPages = Math.ceil(total / pageSize) || 1;
        const msgText = `⏳ <b>لیست درخواست‌های در انتظار بررسی:</b>\n` +
          `صفحه <code>${page + 1}</code> از <code>${totalPages}</code> (کل: <code>${total}</code> نفر)\n\n` +
          `جهت بررسی هر کاربر کلیک کنید:`;

        const markup = {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(buttons)
        };

        if (hasPhoto) {
          await ctx.deleteMessage().catch(() => {});
          await ctx.reply(msgText, markup as any);
        } else {
          await ctx.editMessageText(msgText, markup as any).catch(() => {});
        }
      } catch (error) {
        console.error('Error listing pending users:', error);
      }
      return;
    }

    // 5.5. Admin List Rejected Users (Paginated)
    if (data === 'ADMIN_LIST_REJECTED' || data.startsWith('ADMIN_LIST_REJ_')) {
      await ctx.answerCbQuery();
      const page = data.startsWith('ADMIN_LIST_REJ_') ? parseInt(data.replace('ADMIN_LIST_REJ_', ''), 10) : 0;
      const pageSize = 10;
      try {
        const total = await prisma.user.count({ where: { verificationStatus: 'REJECTED' } });
        const users = await prisma.user.findMany({
          where: { verificationStatus: 'REJECTED' },
          skip: page * pageSize,
          take: pageSize,
          orderBy: { updatedAt: 'desc' }
        });

        const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;

        if (users.length === 0 && page === 0) {
          const emptyText = '❌ هیچ کاربر رد صلاحیت شده‌ای یافت نشد.';
          const emptyMarkup = Markup.inlineKeyboard([[Markup.button.callback('🔙 بازگشت', 'ADMIN_MAIN_MENU')]]);
          if (hasPhoto) {
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(emptyText, emptyMarkup);
          } else {
            await ctx.editMessageText(emptyText, emptyMarkup).catch(() => {});
          }
          return;
        }

        const buttons = users.map(u => [
          Markup.button.callback(
            `❌ ${u.fullName || u.firstName} (@${u.username || 'ندارد'})`,
            `ADMIN_USER_VIEW_${u.id}`
          )
        ]);

        const navRow = [];
        if (page > 0) {
          navRow.push(Markup.button.callback('⬅️ صفحه قبل', `ADMIN_LIST_REJ_${page - 1}`));
        }
        if ((page + 1) * pageSize < total) {
          navRow.push(Markup.button.callback('صفحه بعد ➡️', `ADMIN_LIST_REJ_${page + 1}`));
        }
        if (navRow.length > 0) {
          buttons.push(navRow);
        }

        buttons.push([Markup.button.callback('🔙 بازگشت به منو', 'ADMIN_MAIN_MENU')]);

        const totalPages = Math.ceil(total / pageSize) || 1;
        const msgText = `❌ <b>لیست کاربران رد صلاحیت شده:</b>\n` +
          `صفحه <code>${page + 1}</code> از <code>${totalPages}</code> (کل: <code>${total}</code> نفر)\n\n` +
          `برای مشاهده مشخصات و مدیریت هر کاربر کلیک کنید:`;

        const markup = {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(buttons)
        };

        if (hasPhoto) {
          await ctx.deleteMessage().catch(() => {});
          await ctx.reply(msgText, markup as any);
        } else {
          await ctx.editMessageText(msgText, markup as any).catch(() => {});
        }
      } catch (error) {
        console.error('Error listing rejected users:', error);
      }
      return;
    }

    // 6. Admin View User Details
    if (data.startsWith('ADMIN_USER_VIEW_')) {
      const userId = parseInt(data.replace('ADMIN_USER_VIEW_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(userId)) return;

      try {
        const u = await prisma.user.findUnique({ where: { id: userId } });
        if (!u) {
          await ctx.reply('کاربر مورد نظر یافت نشد.');
          return;
        }

        const proposalsCount = await prisma.proposal.count({
          where: { creatorId: u.id }
        });
        const activeProposalsCount = await prisma.proposal.count({
          where: { creatorId: u.id, status: 'PENDING' }
        });

        const detailsText =
          `👤 <b>مشخصات کاربر:</b>\n\n` +
          `🔹 <b>نام واقعی:</b> <code>${u.fullName || 'ثبت نشده'}</code>\n` +
          `🔹 <b>نام کاربری:</b> @${u.username || 'ندارد'}\n` +
          `🔹 <b>شماره تماس:</b> <code>${u.phoneNumber || 'ثبت نشده'}</code>\n` +
          `🔹 <b>کشور محل اقامت:</b> <code>${u.country || 'ثبت نشده'}</code>\n` +
          `🔹 <b>وضعیت کنونی:</b> <code>${u.verificationStatus}</code>\n` +
          `🔹 <b>حد مجاز روزانه:</b> <code>${u.dailyProposalLimit}</code> پیشنهاد\n` +
          `🔹 <b>تعداد پیشنهادها:</b> <code>${proposalsCount}</code> (فعال: <code>${activeProposalsCount}</code>)\n` +
          `🔹 <b>شناسه تلگرام:</b> <code>${u.telegramId}</code>` +
          (u.rejectReason ? `\n💬 <b>علت رد/لغو:</b> <code>${u.rejectReason}</code>` : '');

        const buttons = [];
        
        // Show Approve/Reject/Revoke buttons based on current verification status
        if (u.verificationStatus === 'PENDING') {
          buttons.push([
            Markup.button.callback('✅ تایید درخواست', `APPROVE_USER_${u.id}`),
            Markup.button.callback('❌ رد درخواست', `REJECT_USER_${u.id}`)
          ]);
        } else if (u.verificationStatus === 'APPROVED') {
          buttons.push([
            Markup.button.callback('🚫 لغو احراز هویت و اخراج', `ADMIN_USER_REVOKE_${u.id}`)
          ]);
        } else if (u.verificationStatus === 'REJECTED') {
          buttons.push([
            Markup.button.callback('✅ تایید احراز هویت', `APPROVE_USER_${u.id}`)
          ]);
        }

        // Edit buttons row 1
        buttons.push([
          Markup.button.callback('✏️ نام واقعی', `ADMIN_EDIT_name_${u.id}`),
          Markup.button.callback('✏️ شماره تماس', `ADMIN_EDIT_phone_${u.id}`)
        ]);
        
        // Edit buttons row 2
        buttons.push([
          Markup.button.callback('✏️ کشور اقامت', `ADMIN_EDIT_country_${u.id}`),
          Markup.button.callback('✏️ حد مجاز روزانه', `ADMIN_EDIT_limit_${u.id}`)
        ]);

        // Status & Delete row
        buttons.push([
          Markup.button.callback('✏️ تغییر وضعیت', `ADMIN_EDIT_status_${u.id}`),
          Markup.button.callback('🗑 حذف کامل از ربات', `ADMIN_USER_DELETE_${u.id}`)
        ]);

        // View User's Proposals row
        buttons.push([
          Markup.button.callback('📋 پیشنهادهای این کاربر', `ADMIN_USER_PROPS_${u.id}_0`)
        ]);
        
        // Back button based on status
        let backTarget = 'ADMIN_MAIN_MENU';
        if (u.verificationStatus === 'PENDING') backTarget = 'ADMIN_LIST_PENDING';
        else if (u.verificationStatus === 'APPROVED') backTarget = 'ADMIN_LIST_APPROVED';
        else if (u.verificationStatus === 'REJECTED') backTarget = 'ADMIN_LIST_REJECTED';
        
        buttons.push([Markup.button.callback('🔙 بازگشت به لیست', backTarget)]);

        if (u.documentFileId) {
          await ctx.deleteMessage().catch(() => {});
          await ctx.replyWithPhoto(u.documentFileId, {
            caption: detailsText,
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
          });
        } else {
          const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;
          if (hasPhoto) {
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(detailsText, {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard(buttons)
            });
          } else {
            await ctx.editMessageText(detailsText, {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard(buttons)
            }).catch(() => {});
          }
        }
      } catch (error) {
        console.error('Error viewing user details:', error);
      }
      return;
    }

    // 7. Admin Revoke / Rejection (Redirect to reject wizard to get reason)
    if (data.startsWith('ADMIN_USER_REVOKE_') || data.startsWith('REJECT_USER_')) {
      await ctx.answerCbQuery();
      let userIdStr = '';
      if (data.startsWith('ADMIN_USER_REVOKE_')) {
        userIdStr = data.replace('ADMIN_USER_REVOKE_', '');
      } else {
        userIdStr = data.replace('REJECT_USER_', '');
      }
      const userId = parseInt(userIdStr, 10);
      if (isNaN(userId)) return;

      await ctx.deleteMessage().catch(() => {});
      await ctx.scene.enter(ADMIN_REJECT_USER_SCENE_ID, { userId });
      return;
    }

    // 8. Admin Delete User completely
    if (data.startsWith('ADMIN_USER_DELETE_')) {
      const userId = parseInt(data.replace('ADMIN_USER_DELETE_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(userId)) return;

      try {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (user) {
          // Kick first
          const tgId = parseInt(user.telegramId, 10);
          await ctx.telegram.banChatMember(config.GROUP_CHAT_ID, tgId).catch(() => {});
          await ctx.telegram.unbanChatMember(config.GROUP_CHAT_ID, tgId).catch(() => {});

          // Delete DB
          await prisma.user.delete({ where: { id: userId } });
          
          // Notify user
          await ctx.telegram.sendMessage(user.telegramId, '❌ اکانت کاربری شما در ربات توسط مدیریت به طور کامل حذف شد.').catch(() => {});

          await ctx.reply(`🗑 کاربر **${user.fullName || user.firstName}** به همراه تمامی داده‌هایش حذف و از گروه اخراج شد.`);
          await ctx.deleteMessage().catch(() => {});
        }
      } catch (error) {
        console.error('Error deleting user:', error);
        await ctx.reply('❌ خطا در حذف کامل کاربر.');
      }
      return;
    }

    // 9. Admin Search Trigger
    if (data === 'ADMIN_SEARCH_USER') {
      await ctx.answerCbQuery();
      await ctx.scene.enter(ADMIN_SEARCH_SCENE_ID);
      return;
    }

    // 10. Admin Edit Field Trigger
    if (data.startsWith('ADMIN_EDIT_')) {
      await ctx.answerCbQuery();
      const parts = data.replace('ADMIN_EDIT_', '').split('_');
      if (parts.length < 2) return;

      const fieldShort = parts[0];
      const userId = parseInt(parts[1], 10);
      if (isNaN(userId)) return;

      let field: 'fullName' | 'phoneNumber' | 'country' | 'dailyProposalLimit' | 'verificationStatus' = 'fullName';
      if (fieldShort === 'name') field = 'fullName';
      else if (fieldShort === 'phone') field = 'phoneNumber';
      else if (fieldShort === 'country') field = 'country';
      else if (fieldShort === 'limit') field = 'dailyProposalLimit';
      else if (fieldShort === 'status') field = 'verificationStatus';

      await ctx.scene.enter(ADMIN_EDIT_USER_SCENE_ID, { userId, field });
      return;
    }

    // 11. Secure User Approvals (moved inside isAdmin block)
    if (data.startsWith('APPROVE_USER_')) {
      const userId = parseInt(data.replace('APPROVE_USER_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(userId)) return;

      try {
        const user = await prisma.user.update({
          where: { id: userId },
          data: { verificationStatus: 'APPROVED' }
        });

        // Generate invite link
        const inviteLink = await ctx.telegram.createChatInviteLink(config.GROUP_CHAT_ID, {
          member_limit: 1,
          name: `Invite for ${user.fullName}`,
          expire_date: Math.floor(Date.now() / 1000) + 86400 // 24 hours
        });

        // Notify user
        const userMsg =
          `🎉 **احراز هویت شما با موفقیت توسط مدیریت تایید شد!**\n\n` +
          `لینک عضویت یک‌بار مصرف شما در گروه معاملاتی دانمارک (دارای اعتبار ۲۴ ساعته):\n` +
          `🔗 ${inviteLink.invite_link}\n\n` +
          `پس از عضویت در گروه، می‌توانید پیشنهادهای خود را از دکمه‌های زیر ثبت و مدیریت کنید.`;
        
        await ctx.telegram.sendMessage(user.telegramId, userMsg, {
          parse_mode: 'Markdown',
          ...mainKeyboard
        });

        // Update Admin Message
        const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;
        const confirmationText = 
          `✅ **احراز هویت کاربر تایید شد**\n\n` +
          `👤 **نام کامل:** ${user.fullName}\n` +
          `🌍 **کشور:** ${user.country}\n` +
          `📱 **تلفن:** ${user.phoneNumber}\n\n` +
          `🔗 لینک عضویت صادر و ارسال شد.`;

        if (hasPhoto) {
          await ctx.editMessageCaption(confirmationText).catch(() => {});
        } else {
          await ctx.editMessageText(confirmationText).catch(() => {});
        }

      } catch (error) {
        console.error('Error approving user:', error);
        await ctx.reply('❌ خطا در تایید درخواست احراز هویت.');
      }
      return;
    }

    // 12. Admin manages proposal from group message click
    if (data.startsWith('ADMIN_PROP_MANAGE_')) {
      const propId = parseInt(data.replace('ADMIN_PROP_MANAGE_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(propId)) return;

      try {
        const prop = await prisma.proposal.findUnique({
          where: { id: propId },
          include: { creator: true }
        });

        if (!prop) {
          await ctx.reply('❌ پیشنهاد مورد نظر یافت نشد.');
          return;
        }

        const u = prop.creator;
        
        const proposalsCount = await prisma.proposal.count({
          where: { creatorId: u.id }
        });
        const activeProposalsCount = await prisma.proposal.count({
          where: { creatorId: u.id, status: 'PENDING' }
        });

        const detailsText =
          `⚙️ <b>مدیریت کاربر از روی پیشنهاد گروه:</b>\n\n` +
          `👤 <b>مشخصات کاربر:</b>\n` +
          `🔹 <b>نام واقعی:</b> <code>${u.fullName || 'ثبت نشده'}</code>\n` +
          `🔹 <b>نام کاربری:</b> @${u.username || 'ندارد'}\n` +
          `🔹 <b>شماره تماس:</b> <code>${u.phoneNumber || 'ثبت نشده'}</code>\n` +
          `🔹 <b>کشور محل اقامت:</b> <code>${u.country || 'ثبت نشده'}</code>\n` +
          `🔹 <b>وضعیت کنونی:</b> <code>${u.verificationStatus}</code>\n` +
          `🔹 <b>حد مجاز روزانه:</b> <code>${u.dailyProposalLimit}</code> پیشنهاد\n` +
          `🔹 <b>تعداد پیشنهادها:</b> <code>${proposalsCount}</code> (فعال: <code>${activeProposalsCount}</code>)\n` +
          `🔹 <b>شناسه تلگرام:</b> <code>${u.telegramId}</code>` +
          (u.rejectReason ? `\n💬 <b>علت رد/لغو:</b> <code>${u.rejectReason}</code>` : '');

        const buttons = [];
        
        // Show Approve/Reject/Revoke buttons based on current verification status
        if (u.verificationStatus === 'PENDING') {
          buttons.push([
            Markup.button.callback('✅ تایید درخواست', `APPROVE_USER_${u.id}`),
            Markup.button.callback('❌ رد درخواست', `REJECT_USER_${u.id}`)
          ]);
        } else if (u.verificationStatus === 'APPROVED') {
          buttons.push([
            Markup.button.callback('🚫 لغو احراز هویت و اخراج', `ADMIN_USER_REVOKE_${u.id}`)
          ]);
        } else if (u.verificationStatus === 'REJECTED') {
          buttons.push([
            Markup.button.callback('✅ تایید احراز هویت', `APPROVE_USER_${u.id}`)
          ]);
        }

        // Edit buttons row 1
        buttons.push([
          Markup.button.callback('✏️ نام واقعی', `ADMIN_EDIT_name_${u.id}`),
          Markup.button.callback('✏️ شماره تماس', `ADMIN_EDIT_phone_${u.id}`)
        ]);
        
        // Edit buttons row 2
        buttons.push([
          Markup.button.callback('✏️ کشور اقامت', `ADMIN_EDIT_country_${u.id}`),
          Markup.button.callback('✏️ حد مجاز روزانه', `ADMIN_EDIT_limit_${u.id}`)
        ]);

        // Status & Delete row
        buttons.push([
          Markup.button.callback('✏️ تغییر وضعیت', `ADMIN_EDIT_status_${u.id}`),
          Markup.button.callback('🗑 حذف کامل از ربات', `ADMIN_USER_DELETE_${u.id}`)
        ]);
        
        buttons.push([Markup.button.callback('🔙 بازگشت به منوی اصلی', 'ADMIN_MAIN_MENU')]);

        // Send this management page directly to the admin's private chat
        if (u.documentFileId) {
          await ctx.telegram.sendPhoto(config.ADMIN_CHAT_ID, u.documentFileId, {
            caption: detailsText,
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
          });
        } else {
          await ctx.telegram.sendMessage(config.ADMIN_CHAT_ID, detailsText, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
          });
        }

        // Send confirmation alert in group (visible only to the admin who clicked it)
        await ctx.answerCbQuery('⚙️ مشخصات کاربر ثبت‌کننده به چت خصوصی شما ارسال شد.', { show_alert: false });

      } catch (error) {
        console.error('Error in ADMIN_PROP_MANAGE_:', error);
        await ctx.answerCbQuery('❌ خطا در بررسی مشخصات.', { show_alert: true });
      }
      return;
    }

    // 13. Admin List All Proposals (Paginated)
    if (data === 'ADMIN_LIST_PROPOSALS' || data.startsWith('ADMIN_LIST_PROP_')) {
      await ctx.answerCbQuery();
      const page = data.startsWith('ADMIN_LIST_PROP_') ? parseInt(data.replace('ADMIN_LIST_PROP_', ''), 10) : 0;
      const pageSize = 10;

      try {
        const total = await prisma.proposal.count({ where: { status: 'PENDING' } });
        const props = await prisma.proposal.findMany({
          where: { status: 'PENDING' },
          skip: page * pageSize,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
          include: { creator: true }
        });

        const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;

        if (props.length === 0 && page === 0) {
          const emptyText = '📋 هیچ پیشنهاد فعال و معلقی در سیستم یافت نشد.';
          const emptyMarkup = Markup.inlineKeyboard([[Markup.button.callback('🔙 بازگشت', 'ADMIN_MAIN_MENU')]]);
          if (hasPhoto) {
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(emptyText, emptyMarkup);
          } else {
            await ctx.editMessageText(emptyText, emptyMarkup).catch(() => {});
          }
          return;
        }

        const buttons = props.map(p => [
          Markup.button.callback(
            `[${p.type === 'BUY' ? '🟢 خرید' : '🔴 فروش'}] ${p.amount.toLocaleString('fa-IR')} ${p.currency} - T (توسط ${p.creator.fullName || p.creator.firstName})`,
            `ADMIN_PROP_VIEW_${p.id}`
          )
        ]);

        const navRow = [];
        if (page > 0) {
          navRow.push(Markup.button.callback('⬅️ صفحه قبل', `ADMIN_LIST_PROP_${page - 1}`));
        }
        if ((page + 1) * pageSize < total) {
          navRow.push(Markup.button.callback('صفحه بعد ➡️', `ADMIN_LIST_PROP_${page + 1}`));
        }
        if (navRow.length > 0) {
          buttons.push(navRow);
        }

        buttons.push([Markup.button.callback('🔙 بازگشت به منو', 'ADMIN_MAIN_MENU')]);

        const totalPages = Math.ceil(total / pageSize) || 1;
        const msgText = `📋 <b>مدیریت پیشنهادات فعال کل سیستم:</b>\n` +
          `صفحه <code>${page + 1}</code> از <code>${totalPages}</code> (کل: <code>${total}</code> پیشنهاد فعال)\n\n` +
          `برای مشاهده جزئیات و مدیریت هر پیشنهاد کلیک کنید:`;

        const markup = {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(buttons)
        };

        if (hasPhoto) {
          await ctx.deleteMessage().catch(() => {});
          await ctx.reply(msgText, markup as any);
        } else {
          await ctx.editMessageText(msgText, markup as any).catch(() => {});
        }
      } catch (error) {
        console.error('Error listing proposals for admin:', error);
      }
      return;
    }

    // 14. Admin List Proposals of a Specific User (Paginated)
    if (data.startsWith('ADMIN_USER_PROPS_')) {
      await ctx.answerCbQuery();
      const parts = data.replace('ADMIN_USER_PROPS_', '').split('_');
      if (parts.length < 2) return;
      const userId = parseInt(parts[0], 10);
      const page = parseInt(parts[1], 10) || 0;
      if (isNaN(userId)) return;

      const pageSize = 10;
      try {
        const u = await prisma.user.findUnique({ where: { id: userId } });
        if (!u) return;

        const total = await prisma.proposal.count({ where: { creatorId: userId } });
        const props = await prisma.proposal.findMany({
          where: { creatorId: userId },
          skip: page * pageSize,
          take: pageSize,
          orderBy: { createdAt: 'desc' }
        });

        const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;

        if (props.length === 0 && page === 0) {
          const emptyText = `📋 کاربر **${u.fullName || u.firstName}** هیچ پیشنهادی ثبت نکرده است.`;
          const emptyMarkup = Markup.inlineKeyboard([[Markup.button.callback('👤 بازگشت به پرونده کاربر', `ADMIN_USER_VIEW_${userId}`)]]);
          if (hasPhoto) {
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(emptyText, emptyMarkup);
          } else {
            await ctx.editMessageText(emptyText, emptyMarkup).catch(() => {});
          }
          return;
        }

        const buttons = props.map(p => [
          Markup.button.callback(
            `[${p.type === 'BUY' ? '🟢 خرید' : '🔴 فروش'}] ${p.amount.toLocaleString('fa-IR')} ${p.currency} [${p.status}]`,
            `ADMIN_PROP_VIEW_${p.id}`
          )
        ]);

        const navRow = [];
        if (page > 0) {
          navRow.push(Markup.button.callback('⬅️ صفحه قبل', `ADMIN_USER_PROPS_${userId}_${page - 1}`));
        }
        if ((page + 1) * pageSize < total) {
          navRow.push(Markup.button.callback('صفحه بعد ➡️', `ADMIN_USER_PROPS_${userId}_${page + 1}`));
        }
        if (navRow.length > 0) {
          buttons.push(navRow);
        }

        buttons.push([Markup.button.callback('👤 بازگشت به مشخصات کاربر', `ADMIN_USER_VIEW_${userId}`)]);

        const totalPages = Math.ceil(total / pageSize) || 1;
        const msgText = `📋 <b>پیشنهادات کاربر: ${u.fullName || u.firstName}</b>\n` +
          `صفحه <code>${page + 1}</code> از <code>${totalPages}</code> (کل: <code>${total}</code> پیشنهاد)\n\n` +
          `جهت مدیریت پیشنهاد کلیک کنید:`;

        const markup = {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(buttons)
        };

        if (hasPhoto) {
          await ctx.deleteMessage().catch(() => {});
          await ctx.reply(msgText, markup as any);
        } else {
          await ctx.editMessageText(msgText, markup as any).catch(() => {});
        }
      } catch (error) {
        console.error('Error listing user proposals for admin:', error);
      }
      return;
    }

    // 15. Admin View Proposal Details
    if (data.startsWith('ADMIN_PROP_VIEW_')) {
      const propId = parseInt(data.replace('ADMIN_PROP_VIEW_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(propId)) return;

      try {
        const prop = await prisma.proposal.findUnique({
          where: { id: propId },
          include: { creator: true }
        });

        if (!prop) {
          await ctx.reply('❌ پیشنهاد مورد نظر یافت نشد.');
          return;
        }

        const details =
          `📋 <b>مشخصات کامل پیشنهاد معاملاتی:</b>\n\n` +
          `🔹 <b>شناسه پیشنهاد:</b> <code>#${prop.id}</code>\n` +
          `🔹 <b>ثبت‌کننده:</b> <code>${prop.creator.fullName || prop.creator.firstName}</code> (@${prop.creator.username || 'ندارد'})\n` +
          `🔹 <b>شناسه تلگرام ثبت‌کننده:</b> <code>${prop.creator.telegramId}</code>\n` +
          `🔹 <b>نوع معامله:</b> ${prop.type === 'BUY' ? '🟢 خرید (Buy)' : '🔴 فروش (Sell)'}\n` +
          `🔹 <b>ارز:</b> <code>${prop.currency}</code>\n` +
          `🔹 <b>مقدار:</b> <code>${prop.amount.toLocaleString('fa-IR')}</code>\n` +
          `🔹 <b>قیمت واحد:</b> <code>${prop.price.toLocaleString('fa-IR')}</code> تومان\n` +
          `🔹 <b>مبلغ کل:</b> <code>${(prop.amount * prop.price).toLocaleString('fa-IR')}</code> تومان\n` +
          `🔹 <b>وضعیت کنونی:</b> <code>${prop.status}</code>\n` +
          `🔹 <b>تاریخ ثبت:</b> <code>${prop.createdAt.toLocaleString('fa-IR')}</code>`;

        const buttons = [];
        
        if (prop.status === 'PENDING') {
          buttons.push([
            Markup.button.callback('❌ لغو پیشنهاد در گروه', `ADMIN_PROP_CANCEL_${prop.id}`)
          ]);
          buttons.push([
            Markup.button.callback('✏️ ویرایش مقدار', `ADMIN_PROP_EDIT_amount_${prop.id}`),
            Markup.button.callback('✏️ ویرایش قیمت', `ADMIN_PROP_EDIT_price_${prop.id}`)
          ]);
        }
        
        buttons.push([
          Markup.button.callback('🗑 حذف کامل از دیتابیس', `ADMIN_PROP_DELETE_${prop.id}`)
        ]);
        
        buttons.push([
          Markup.button.callback('👤 پرونده کاربر ثبت‌کننده', `ADMIN_USER_VIEW_${prop.creator.id}`),
          Markup.button.callback('🔙 لیست پیشنهادهای کاربر', `ADMIN_USER_PROPS_${prop.creator.id}_0`)
        ]);

        const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;
        if (hasPhoto) {
          await ctx.deleteMessage().catch(() => {});
          await ctx.reply(details, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
          });
        } else {
          await ctx.editMessageText(details, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
          }).catch(() => {});
        }
      } catch (error) {
        console.error('Error viewing proposal details:', error);
      }
      return;
    }

    // 16. Admin Cancel Proposal
    if (data.startsWith('ADMIN_PROP_CANCEL_')) {
      const propId = parseInt(data.replace('ADMIN_PROP_CANCEL_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(propId)) return;

      try {
        const prop = await prisma.proposal.findUnique({
          where: { id: propId },
          include: { creator: true }
        });

        if (!prop) {
          await ctx.reply('❌ پیشنهاد یافت نشد.');
          return;
        }

        await prisma.proposal.update({
          where: { id: propId },
          data: { status: 'CANCELLED' }
        });

        await ctx.reply(`✅ پیشنهاد شماره #${propId} با موفقیت لغو شد.`);
        
        await ctx.telegram.sendMessage(
          prop.creator.telegramId,
          `⚠️ **پیشنهاد معامله شما (شماره #${propId}) توسط مدیریت ربات لغو شد.**`
        ).catch(() => {});

        if (prop.groupMessageId) {
          await updateGroupProposalMessage(ctx.telegram, prop.id);
        }

        const updatedTarget = `ADMIN_PROP_VIEW_${propId}`;
        const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;
        if (hasPhoto) {
          await ctx.deleteMessage().catch(() => {});
          await ctx.reply('در حال بارگذاری مجدد...', Markup.inlineKeyboard([[Markup.button.callback('🔄 مشاهده پرونده پیشنهاد', updatedTarget)]]));
        } else {
          await ctx.editMessageText(
            '🔄 پیشنهاد لغو شد. جهت مشاهده وضعیت جدید کلیک کنید:',
            Markup.inlineKeyboard([[Markup.button.callback('🔄 مشاهده پرونده پیشنهاد', updatedTarget)]])
          ).catch(() => {});
        }

      } catch (error) {
        console.error('Error in ADMIN_PROP_CANCEL_:', error);
        await ctx.reply('❌ خطا در لغو پیشنهاد.');
      }
      return;
    }

    // 17. Admin Delete Proposal
    if (data.startsWith('ADMIN_PROP_DELETE_')) {
      const propId = parseInt(data.replace('ADMIN_PROP_DELETE_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(propId)) return;

      try {
        const prop = await prisma.proposal.findUnique({
          where: { id: propId },
          include: { creator: true }
        });

        if (!prop) {
          await ctx.reply('❌ پیشنهاد یافت نشد.');
          return;
        }

        if (prop.groupMessageId) {
          await ctx.telegram.deleteMessage(config.GROUP_CHAT_ID, prop.groupMessageId)
            .catch(err => console.error('Failed to delete group message:', err));
        }

        await prisma.proposal.delete({
          where: { id: propId }
        });

        await ctx.reply(`🗑 پیشنهاد شماره #${propId} به طور کامل از دیتابیس و گروه حذف شد.`);
        await ctx.deleteMessage().catch(() => {});

      } catch (error) {
        console.error('Error deleting proposal:', error);
        await ctx.reply('❌ خطا در حذف کامل پیشنهاد.');
      }
      return;
    }

    // 18. Admin Edit Proposal Field Trigger
    if (data.startsWith('ADMIN_PROP_EDIT_')) {
      await ctx.answerCbQuery();
      const parts = data.replace('ADMIN_PROP_EDIT_', '').split('_');
      if (parts.length < 2) return;

      const field = parts[0] as 'amount' | 'price';
      const proposalId = parseInt(parts[1], 10);
      if (isNaN(proposalId)) return;

      await ctx.scene.enter(ADMIN_EDIT_PROP_SCENE_ID, { proposalId, field });
      return;
    }
  }

  // Handle non-admin clicks on ADMIN_PROP_MANAGE_
  if (data.startsWith('ADMIN_PROP_MANAGE_') && !isAdmin) {
    await ctx.answerCbQuery('⚠️ این دکمه مخصوص مدیریت ربات است.', { show_alert: true });
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
        await updateGroupProposalMessage(ctx.telegram, prop.id);
      }

    } catch (error) {
      console.error('Error canceling user proposal:', error);
      await ctx.reply('❌ خطا در لغو پیشنهاد.');
    }
    return;
  }

  // Handle Counter Offer registration trigger
  if (data.startsWith('COUNTER_OFFER_PROP_')) {
    const proposalId = parseInt(data.replace('COUNTER_OFFER_PROP_', ''), 10);
    await ctx.answerCbQuery();
    if (isNaN(proposalId)) return;
    await ctx.scene.enter(COUNTER_OFFER_SCENE_ID, { proposalId });
    return;
  }

  // Handle Counter Offer Acceptance
  if (data.startsWith('OFFER_ACCEPT_')) {
    const offerId = parseInt(data.replace('OFFER_ACCEPT_', ''), 10);
    await ctx.answerCbQuery();
    if (isNaN(offerId)) return;
    
    try {
      const offer = await prisma.counterOffer.findUnique({
        where: { id: offerId },
        include: {
          proposer: true,
          proposal: {
            include: { creator: true }
          }
        }
      });
      
      if (!offer) {
        await ctx.reply('❌ پیشنهاد قیمت یافت نشد.');
        return;
      }
      
      if (offer.proposal.creator.telegramId !== from.id.toString()) {
        await ctx.reply('⚠️ شما مجاز به انجام این عملیات نیستید.');
        return;
      }
      
      if (offer.status !== 'PENDING' || offer.proposal.status !== 'PENDING') {
        await ctx.reply('⚠️ این پیشنهاد قیمت یا آگهی اصلی دیگر فعال نیست.');
        return;
      }
      
      // Run transaction to accept deal
      const result = await prisma.$transaction(async (tx) => {
        // Update accepted offer
        const acceptedOffer = await tx.counterOffer.update({
          where: { id: offer.id },
          data: { status: 'ACCEPTED' }
        });
        
        // Reject other pending offers for this proposal
        await tx.counterOffer.updateMany({
          where: {
            proposalId: offer.proposalId,
            id: { not: offer.id },
            status: 'PENDING'
          },
          data: { status: 'REJECTED' }
        });
        
        // Mark proposal completed
        const completedProposal = await tx.proposal.update({
          where: { id: offer.proposalId },
          data: { status: 'COMPLETED' },
          include: { creator: true }
        });
        
        // Create a deal record
        const deal = await tx.deal.create({
          data: {
            proposalId: offer.proposalId,
            acceptorId: offer.proposerId,
            status: 'COMPLETED'
          }
        });
        
        return { acceptedOffer, completedProposal };
      });
      
      const { completedProposal } = result;
      
      // Notify proposer
      const proposerMsg = 
        `✅ **خبر خوب! پیشنهاد قیمت شما پذیرفته شد.**\n\n` +
        `🔹 **جزئیات پیشنهاد:** ${completedProposal.amount.toLocaleString('fa-IR')} ${completedProposal.currency} با قیمت واحد ${offer.price.toLocaleString('fa-IR')} تومان\n\n` +
        `👉 جهت هماهنگی، انجام معامله و مسائل مالی، لطفاً به ادمین ربات پیام دهید:\n` +
        `📣 آیدی ادمین: @${config.ADMIN_USERNAME}`;
         
      await ctx.telegram.sendMessage(offer.proposer.telegramId, proposerMsg)
        .catch(err => console.error('Failed to notify proposer:', err));
         
      // Notify creator (sender of callback)
      await ctx.reply(
        `✅ معامله با قیمت پیشنهادی جدید ${offer.price.toLocaleString('fa-IR')} تومان ثبت شد. جهت انجام مراحل بعدی به ادمین مراجعه کنید: @${config.ADMIN_USERNAME}`
      );
      
      // Notify admin
      const creatorContact = completedProposal.creator.username 
        ? `@${completedProposal.creator.username}` 
        : `[${completedProposal.creator.firstName}](tg://user?id=${completedProposal.creator.telegramId})`;
      const proposerContact = offer.proposer.username 
        ? `@${offer.proposer.username}` 
        : `[${offer.proposer.firstName}](tg://user?id=${offer.proposer.telegramId})`;
         
      const adminMsg = 
        `🔔 **معامله جدید با قیمت پیشنهادی ثبت شد!**\n\n` +
        `📈 **جزئیات معامله:**\n` +
        `🔹 **نوع:** ${completedProposal.type === 'BUY' ? 'خرید' : 'فروش'}\n` +
        `🔹 **ارز:** ${completedProposal.currency}\n` +
        `🔹 **مقدار:** ${completedProposal.amount.toLocaleString('fa-IR')}\n` +
        `🔹 **قیمت پایه اولیه:** ${completedProposal.price.toLocaleString('fa-IR')} تومان\n` +
        `🔹 **قیمت نهایی مورد توافق:** ${offer.price.toLocaleString('fa-IR')} تومان\n` +
        `🔹 **مبلغ کل نهایی:** ${(completedProposal.amount * offer.price).toLocaleString('fa-IR')} تومان\n\n` +
        `👤 **سازنده پیشنهاد (Creator):**\n` +
        `   - نام: ${completedProposal.creator.firstName} ${completedProposal.creator.lastName || ''}\n` +
        `   - یوزرنیم: ${creatorContact}\n` +
        `   - آیدی تلگرام: \`${completedProposal.creator.telegramId}\`\n\n` +
        `👤 **پیشنهاددهنده قیمت (Counter Proposer):**\n` +
        `   - نام: ${offer.proposer.firstName} ${offer.proposer.lastName || ''}\n` +
        `   - یوزرنیم: ${proposerContact}\n` +
        `   - آیدی تلگرام: \`${offer.proposer.telegramId}\``;
         
      await ctx.telegram.sendMessage(config.ADMIN_CHAT_ID, adminMsg, { parse_mode: 'Markdown' })
        .catch(err => console.error('Failed to notify admin:', err));
         
      // Update group message
      await updateGroupProposalMessage(ctx.telegram, offer.proposalId);
      
      // Update the message in creator's chat to remove buttons
      await ctx.editMessageText(`✅ پیشنهاد قیمت ${offer.price.toLocaleString('fa-IR')} تومانی را پذیرفتید. معامله ثبت شد.`).catch(() => {});
       
    } catch (err) {
      console.error('Error accepting counter offer:', err);
      await ctx.reply('❌ خطا در پذیرش پیشنهاد قیمت.');
    }
    return;
  }

  // Handle Counter Offer Rejection
  if (data.startsWith('OFFER_REJECT_')) {
    const offerId = parseInt(data.replace('OFFER_REJECT_', ''), 10);
    await ctx.answerCbQuery();
    if (isNaN(offerId)) return;
    
    try {
      const offer = await prisma.counterOffer.findUnique({
        where: { id: offerId },
        include: {
          proposer: true,
          proposal: {
            include: { creator: true }
          }
        }
      });
      
      if (!offer) {
        await ctx.reply('❌ پیشنهاد قیمت یافت نشد.');
        return;
      }
      
      if (offer.proposal.creator.telegramId !== from.id.toString()) {
        await ctx.reply('⚠️ شما مجاز به انجام این عملیات نیستید.');
        return;
      }
      
      if (offer.status !== 'PENDING') {
        await ctx.reply('⚠️ این پیشنهاد قیمت قبلاً تعیین تکلیف شده است.');
        return;
      }
      
      // Update database
      await prisma.counterOffer.update({
        where: { id: offer.id },
        data: { status: 'REJECTED' }
      });
      
      // Notify proposer
      const proposerMsg = `❌ **پیشنهاد قیمت شما رد شد.**\n\nپیشنهاد قیمت ${offer.price.toLocaleString('fa-IR')} تومانی شما برای پیشنهاد #${offer.proposalId} توسط سازنده پذیرفته نشد.`;
      await ctx.telegram.sendMessage(offer.proposer.telegramId, proposerMsg)
        .catch(err => console.error('Failed to notify proposer of rejection:', err));
         
      // Notify creator
      await ctx.reply('❌ پیشنهاد قیمت رد شد.');
      
      // Update group message
      await updateGroupProposalMessage(ctx.telegram, offer.proposalId);
      
      // Edit message to remove buttons
      await ctx.editMessageText(`❌ پیشنهاد قیمت ${offer.price.toLocaleString('fa-IR')} تومانی را رد کردید.`).catch(() => {});
       
    } catch (err) {
      console.error('Error rejecting counter offer:', err);
      await ctx.reply('❌ خطا در رد پیشنهاد قیمت.');
    }
    return;
  }

  // Delegate deal-specific callbacks to deepLink handler
  if (data.startsWith('ACCEPT_DEAL_') || data === 'CANCEL_DEAL') {
    await handleDealCallbacks(ctx);
    return;
  }
});

// Handle when a member status changes in the group (User joins group)
bot.on('chat_member', async (ctx) => {
  const chatMember = ctx.chatMember;
  const chat = ctx.chat;

  // Only care about updates from our designated group
  if (chat.id !== config.GROUP_CHAT_ID) return;

  const newMember = chatMember.new_chat_member;
  const status = newMember.status;
  const user = newMember.user;

  // Determine if they just joined (transitioning from not being a member to being one)
  const isJoined = ['member', 'administrator', 'creator'].includes(status);
  const wasNotJoined = ['left', 'kicked', 'restricted'].includes(chatMember.old_chat_member.status);

  if (isJoined && wasNotJoined && !user.is_bot) {
    try {
      // Find the user in our database
      const dbUser = await prisma.user.findUnique({
        where: { telegramId: user.id.toString() }
      });

      // Send the main keyboard and welcome message ONLY if they are already APPROVED in DB
      if (dbUser && dbUser.verificationStatus === 'APPROVED') {
        await ctx.telegram.sendMessage(
          user.id,
          `🎉 **عضویت شما در گروه معاملاتی دانمارک با موفقیت تایید شد!**\n\n` +
          `اکنون می‌توانید از منوی دکمه‌های زیر برای ثبت پیشنهاد جدید خرید یا فروش و مدیریت پیشنهادهای خود استفاده کنید:`,
          mainKeyboard
        );
      }
    } catch (error) {
      console.error('Error handling chat_member join event:', error);
    }
  }
});
