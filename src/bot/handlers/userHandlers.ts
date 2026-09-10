import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import { BotContext } from '../index';
import { config } from '../../config';
import { prisma } from '../../database/db';
import { checkVerified } from '../middleware/auth';
import { handleDeepLink } from './deepLink';
import { VERIFY_USER_SCENE_ID } from '../scenes/verifyUser';
import { REQUEST_LIMIT_INCREASE_SCENE_ID } from '../scenes/requestLimitIncrease';
import { mainKeyboard, verifyStartKeyboard, pendingVerificationKeyboard, getMainKeyboard } from '../utils/keyboards';
import { formatToShamsi } from '../utils/groupMessage';
import { escapeHtml } from '../utils/html';

function extractLivePrice(html: string, marketRow: string): number | null {
  const regex = new RegExp(`<tr[^>]*data-market-row=["']${marketRow}["'][^>]*>`, 'i');
  const match = html.match(regex);
  if (!match) return null;

  const trTag = match[0];
  const priceRegex = /data-price=["']([^"']+)["']/i;
  const priceMatch = trTag.match(priceRegex);
  if (!priceMatch) return null;

  const rialPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
  if (isNaN(rialPrice)) return null;
  return Math.round(rialPrice / 10);
}

export function registerUserHandlers(bot: Telegraf<BotContext>) {
  // Command /start handler
  bot.start(async (ctx) => {
    const text = ctx.message.text;
    const parts = text.split(' ');
    if (parts.length > 1) {
      const payload = parts[1];
      await handleDeepLink(ctx, payload);
      return;
    }

    const from = ctx.from;
    if (!from) return;

    try {
      let user = await prisma.user.findUnique({
        where: { telegramId: from.id.toString() }
      });

      if (!user) {
        user = await prisma.user.create({
          data: {
            telegramId: from.id.toString(),
            username: from.username,
            firstName: from.first_name,
            lastName: from.last_name,
            verificationStatus: 'UNVERIFIED'
          }
        });
      }

      if (user.verificationStatus === 'APPROVED') {
        const dynamicKb = await getMainKeyboard(from.id.toString());
        await ctx.reply(
          `سلام ${escapeHtml(user.firstName)} عزیز! 👋\nبه ربات DanmarkFinance خوش آمدید.\n\nاز منوی زیر استفاده کنید:`,
          dynamicKb
        );
      } else if (user.verificationStatus === 'PENDING') {
        await ctx.reply(
          `سلام ${escapeHtml(user.firstName)} عزیز! 👋\nمدارک احراز هویت شما در حال بررسی توسط مدیریت است.`,
          pendingVerificationKeyboard
        );
      } else {
        await ctx.reply(
          `سلام ${escapeHtml(user.firstName)} عزیز! 👋\nبه ربات ثبت سفارش و احراز هویت DanmarkFinance خوش آمدید.\n\n` +
            `برای استفاده از امکانات کامل ربات، لطفاً ابتدا مراحل احراز هویت را انجام دهید.`,
          verifyStartKeyboard
        );
      }
    } catch (error) {
      console.error('Error handling /start:', error);
      await ctx.reply('خطایی رخ داد. لطفا دوباره تلاش کنید.');
    }
  });

  // Help command
  bot.help(checkVerified, async (ctx) => {
    await ctx.reply(
      `📖 <b>راهنمای ربات:</b>\n\n` +
        `۱. <b>💵 نرخ لحظه‌ای ارز</b> — مشاهده نرخ روز دلار، یورو، کرون و تتر.\n` +
        `۲. <b>📋 مدیریت آگهی‌ها</b> — ثبت آگهی جدید خرید/فروش و ویرایش یا حذف آگهی‌های خودتان.\n` +
        `۳. <b>🤝 مدیریت پیشنهادات</b> — بررسی پیشنهادهای قیمتی که برای آگهی‌های شما ثبت شده و پاسخ به آن‌ها.\n` +
        `۴. <b>📊 لیست مبادلات فعال</b> — مشاهده تمام حواله‌های فعال و آماده مبادله.\n` +
        `۵. <b>⚙️ تنظیمات کاربری</b> — مشاهده وضعیت احراز هویت، سقف آگهی روزانه و مدیریت حساب.\n` +
        `۶. <b>📜 شرایط تبادل ارز</b> — قوانین و شرایط انجام معامله در این ربات.\n\n` +
        `پس از توافق طرفین، معامله برای تایید نهایی به مدیریت ارسال می‌شود و دکمه <b>📤 ارسال فیش واریزی</b> برای شما نمایش داده خواهد شد.`,
      mainKeyboard
    );
  });

  bot.hears('🔐 شروع احراز هویت', async (ctx) => {
    await ctx.scene.enter(VERIFY_USER_SCENE_ID);
  });

  bot.hears('❌ لغو ارسال اطلاعات', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    try {
      const dbUser = await prisma.user.findUnique({
        where: { telegramId: from.id.toString() }
      });

      if (!dbUser || dbUser.verificationStatus !== 'PENDING') {
        await ctx.reply('⚠️ شما در حال حاضر درخواست احراز هویت در انتظار تایید ندارید.');
        return;
      }

      if (dbUser.adminVerifyMsgId) {
        await ctx.telegram.deleteMessage(config.ADMIN_CHAT_ID, dbUser.adminVerifyMsgId).catch((err) => {
          console.error('Failed to delete admin text verification message:', err);
        });
      }
      if (dbUser.adminVerifyPhotoId) {
        await ctx.telegram.deleteMessage(config.ADMIN_CHAT_ID, dbUser.adminVerifyPhotoId).catch((err) => {
          console.error('Failed to delete admin photo verification message:', err);
        });
      }

      await prisma.user.update({
        where: { telegramId: from.id.toString() },
        data: {
          verificationStatus: 'UNVERIFIED',
          documentFileId: null,
          fullName: null,
          country: null,
          phoneNumber: null,
          rejectReason: null,
          adminVerifyMsgId: null,
          adminVerifyPhotoId: null
        }
      });

      await ctx.reply(
        '❌ ارسال مدارک احراز هویت شما با موفقیت لغو و اطلاعات قبلی پاک شد.\n\n' +
          'اکنون می‌توانید مجدداً فرآیند احراز هویت را شروع کنید:',
        verifyStartKeyboard
      );
    } catch (err) {
      console.error('Error canceling verification submission:', err);
      await ctx.reply('❌ خطا در لغو ارسال اطلاعات.');
    }
  });

  bot.hears('🔄 فعال‌سازی حساب کاربری', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    try {
      const dbUser = await prisma.user.findUnique({
        where: { telegramId: from.id.toString() }
      });

      if (!dbUser || dbUser.verificationStatus !== 'DEACTIVATED') {
        await ctx.reply('⚠️ حساب کاربری شما در وضعیت غیرفعال قرار ندارد.');
        return;
      }

      await prisma.user.update({
        where: { telegramId: from.id.toString() },
        data: { verificationStatus: 'APPROVED' }
      });

      const dynamicKb = await getMainKeyboard(from.id.toString());
      await ctx.reply(
        '🎉 <b>حساب کاربری شما با موفقیت مجدداً فعال گردید!</b>\n\nهم‌اکنون می‌توانید از تمامی امکانات ربات استفاده کنید.',
        dynamicKb
      );
    } catch (err) {
      console.error('Error reactivating account:', err);
      await ctx.reply('❌ خطا در فعال‌سازی حساب کاربری.');
    }
  });

  bot.hears('⚙️ تنظیمات کاربری', checkVerified, async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    try {
      const dbUser = await prisma.user.findUnique({
        where: { telegramId: from.id.toString() }
      });

      if (!dbUser) {
        await ctx.reply('❌ اطلاعات کاربری شما یافت نشد.');
        return;
      }

      const verificationStatusText =
        dbUser.verificationStatus === 'APPROVED'
          ? '✅ تایید شده'
          : dbUser.verificationStatus === 'PENDING'
          ? '⏳ در انتظار تایید'
          : dbUser.verificationStatus === 'REJECTED'
          ? '❌ رد شده'
          : 'نامشخص';

      const infoText =
        `👤 <b>مشخصات کاربری شما:</b>\n\n` +
        `🔹 <b>نام و نام خانوادگی:</b> ${escapeHtml(dbUser.firstName)} ${escapeHtml(dbUser.lastName || '')}\n` +
        `🔹 <b>نام کاربری تلگرام:</b> ${escapeHtml(dbUser.username ? `@${dbUser.username}` : 'ندارد')}\n` +
        `🔹 <b>تلفن همراه:</b> ${escapeHtml(dbUser.phoneNumber ?? 'ثبت نشده')}\n` +
        `🔹 <b>کشور محل سکونت:</b> ${escapeHtml(dbUser.country ?? 'ثبت نشده')}\n` +
        `🔹 <b>وضعیت احراز هویت:</b> ${verificationStatusText}\n` +
        `🔹 <b>محدودیت پیشنهاد روزانه:</b> ${dbUser.dailyProposalLimit} عدد\n` +
        `🔹 <b>تاریخ ثبت‌نام:</b> <code>${formatToShamsi(dbUser.createdAt)}</code>`;

      await ctx.reply(infoText, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🚀 افزایش سقف محدودیت آگهی روزانه', 'USER_REQ_LIMIT_INCREASE')],
          [Markup.button.callback('⏸ غیرفعال‌سازی موقت حساب کاربری', 'USER_DEACTIVATE_ACCOUNT')],
          [Markup.button.callback('🗑 حذف کامل اطلاعات شما از ربات', 'USER_DELETE_ACCOUNT')],
          [Markup.button.callback('🔙 بازگشت', 'USER_CLOSE_SETTINGS')]
        ])
      });
    } catch (err) {
      console.error('Error fetching user info:', err);
      await ctx.reply('❌ خطا در بارگذاری اطلاعات کاربری.');
    }
  });

  bot.hears('💵 نرخ لحظه‌ای ارز', checkVerified, async (ctx) => {
    try {
      const response = await axios.get('https://www.tgju.org/', {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
        },
        timeout: 10000
      });

      const html = response.data;
      const usdPrice = extractLivePrice(html, 'price_dollar_rl');
      const eurPrice = extractLivePrice(html, 'price_eur');
      const dkkPrice = extractLivePrice(html, 'price_dkk');
      const usdtPrice = extractLivePrice(html, 'crypto-usdt');

      let ratesText = `💵 <b>نرخ لحظه‌ای ارزها (منبع TGJU):</b>\n\n`;
      ratesText += usdPrice ? `🔹 <b>دلار آمریکا (USD):</b> <code>${usdPrice.toLocaleString('fa-IR')}</code> تومان\n` : `🔹 <b>دلار آمریکا (USD):</b> دریافت نشد\n`;
      ratesText += eurPrice ? `🔹 <b>یورو (EUR):</b> <code>${eurPrice.toLocaleString('fa-IR')}</code> تومان\n` : `🔹 <b>یورو (EUR):</b> دریافت نشد\n`;
      ratesText += dkkPrice ? `🔹 <b>کرون دانمارک (DKK):</b> <code>${dkkPrice.toLocaleString('fa-IR')}</code> تومان\n` : `🔹 <b>کرون دانمارک (DKK):</b> دریافت نشد\n`;
      ratesText += usdtPrice ? `🔹 <b>تتر (USDT):</b> <code>${usdtPrice.toLocaleString('fa-IR')}</code> تومان\n` : `🔹 <b>تتر (USDT):</b> دریافت نشد\n`;

      ratesText += `\n📅 <b>زمان بروزرسانی:</b> <code>${formatToShamsi(new Date())}</code>`;

      await ctx.reply(ratesText, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('Error fetching live rates from tgju:', err);
      await ctx.reply('❌ خطا در دریافت نرخ لحظه‌ای ارزها. لطفاً دقایقی دیگر تلاش کنید.');
    }
  });

  bot.hears('📜 شرایط تبادل ارز', checkVerified, async (ctx) => {
    const rulesText =
      `📜 <b>شرایط و قوانین تبادل ارز در ربات DanmarkFinance:</b>\n\n` +
      `۱. <b>احراز هویت الزامی:</b> تمامی کاربران جهت شرکت در مبادلات باید فرآیند احراز هویت را به صورت کامل طی کرده و مدارک آنها توسط مدیریت تایید شود.\n\n` +
      `۲. <b>نظارت مدیریت:</b> تمامی معاملات و نقل و انتقال‌های مالی تحت نظارت مستقیم ادمین ربات انجام می‌گیرد تا امنیت طرفین تضمین گردد.\n\n` +
      `۳. <b>تعهد قیمت و مقدار:</b> پس از پذیرش یک پیشنهاد، تغییر در قیمت یا مقدار توافق شده بدون هماهنگی با مدیریت امکان‌پذیر نمی‌باشد.\n\n` +
      `۴. <b>مدت زمان تسویه:</b> خریدار و فروشنده موظف هستند در بازه زمانی تعیین شده توسط ادمین اقدام به واریز و ارسال فیش نمایند.\n\n` +
      `۵. <b>مسئولیت اطلاعات:</b> مسئولیت صحت شماره حساب‌ها و اطلاعات ارسالی بر عهده کاربر می‌باشد.`;

    await ctx.reply(rulesText, { parse_mode: 'HTML' });
  });

  // User Settings Callbacks
  bot.use(async (ctx, next) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return next();
    const data = ctx.callbackQuery.data;
    const from = ctx.from;
    if (!from) return next();

    if (data === 'USER_CLOSE_SETTINGS') {
      await ctx.answerCbQuery();
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (data === 'USER_REQ_LIMIT_INCREASE') {
      await ctx.answerCbQuery();
      await ctx.scene.enter(REQUEST_LIMIT_INCREASE_SCENE_ID);
      return;
    }

    if (data === 'USER_DEACTIVATE_ACCOUNT') {
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        '⚠️ <b>غیرفعال‌سازی موقت حساب کاربری</b>\n\n' +
          'با غیرفعال‌سازی حساب، امکان ثبت آگهی یا قبول پیشنهادات تا زمان فعال‌سازی مجدد سلب خواهد شد.\n\n' +
          'آیا مطمئن هستید؟',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ بله، غیرفعال کن', 'CONFIRM_DEACTIVATE_ACCOUNT')],
            [Markup.button.callback('❌ انصراف', 'CANCEL_DEACTIVATE_ACCOUNT')]
          ])
        }
      );
      return;
    }

    if (data === 'CANCEL_DEACTIVATE_ACCOUNT') {
      await ctx.answerCbQuery();
      await ctx.deleteMessage().catch(() => {});
      await ctx.reply('عملیات لغو شد.');
      return;
    }

    if (data === 'CONFIRM_DEACTIVATE_ACCOUNT') {
      await ctx.answerCbQuery();
      try {
        await prisma.user.update({
          where: { telegramId: from.id.toString() },
          data: { verificationStatus: 'DEACTIVATED' }
        });

        await ctx.deleteMessage().catch(() => {});
        await ctx.reply(
          '⚠️ <b>حساب کاربری شما موقتاً غیرفعال شد.</b>\n\nهر زمان مایل بودید می‌توانید با زدن دکمه «🔄 فعال‌سازی حساب کاربری» آن را فعال کنید.',
          Markup.keyboard([['🔄 فعال‌سازی حساب کاربری']]).resize()
        );
      } catch (err) {
        console.error('Error deactivating account:', err);
        await ctx.reply('❌ خطا در غیرفعال‌سازی حساب.');
      }
      return;
    }

    if (data === 'USER_DELETE_ACCOUNT') {
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        '🚨 <b>حذف کامل حساب کاربری</b>\n\n' +
          'توجه: با این اقدام تمام سوابق و اطلاعات شما از دیتابیس پاک خواهد شد و جهت استفاده مجدد باید از نو احراز هویت کنید.\n\n' +
          'آیا از حذف کامل حساب خود مطمئن هستید؟',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🗑 بله، حسابم را پاک کن', 'CONFIRM_DELETE_MY_ACCOUNT')],
            [Markup.button.callback('❌ انصراف', 'CANCEL_DELETE_MY_ACCOUNT')]
          ])
        }
      );
      return;
    }

    if (data === 'CANCEL_DELETE_MY_ACCOUNT') {
      await ctx.answerCbQuery();
      await ctx.deleteMessage().catch(() => {});
      await ctx.reply('عملیات لغو شد.');
      return;
    }

    if (data === 'CONFIRM_DELETE_MY_ACCOUNT') {
      await ctx.answerCbQuery();
      try {
        await prisma.user.delete({
          where: { telegramId: from.id.toString() }
        });

        await ctx.deleteMessage().catch(() => {});
        await ctx.reply(
          '🗑 <b>حساب کاربری و تمام اطلاعات شما با موفقیت از سیستم پاک شد.</b>',
          verifyStartKeyboard
        );
      } catch (err) {
        console.error('Error deleting account:', err);
        await ctx.reply('❌ خطا در حذف حساب کاربری.');
      }
      return;
    }

    return next();
  });

  bot.on('text', checkVerified, async (ctx) => {
    const text = ctx.message.text;
    if (
      [
        '💵 نرخ لحظه‌ای ارز',
        '⚙️ تنظیمات کاربری',
        '🤝 مدیریت پیشنهادات',
        '📋 مدیریت آگهی‌ها',
        '📊 لیست مبادلات فعال',
        '📜 شرایط تبادل ارز',
        '🔐 شروع احراز هویت',
        '❌ لغو ارسال اطلاعات',
        '🔄 فعال‌سازی حساب کاربری',
        '📤 ارسال فیش واریزی',
        '📞 ارتباط مستقیم با ادمین'
      ].includes(text)
    ) {
      return;
    }
    const dynamicKb = await getMainKeyboard(ctx.from?.id.toString() || '');
    await ctx.reply('لطفاً از دکمه‌های منوی زیر استفاده کنید:', dynamicKb);
  });

  bot.on('chat_member', async (ctx) => {
    try {
      const update = ctx.chatMember;
      if (!update || update.chat.id.toString() !== config.GROUP_CHAT_ID.toString()) return;

      const newUser = update.new_chat_member;
      const oldUser = update.old_chat_member;

      const isNowMember = ['member', 'administrator', 'creator'].includes(newUser.status);
      const wasMember = ['member', 'administrator', 'creator'].includes(oldUser.status);

      if (isNowMember && !wasMember) {
        const userIdStr = newUser.user.id.toString();
        const dbUser = await prisma.user.findUnique({
          where: { telegramId: userIdStr }
        });

        if (dbUser && dbUser.verificationStatus === 'APPROVED') {
          const dynamicKb = await getMainKeyboard(userIdStr);
          await ctx.telegram
            .sendMessage(
              userIdStr,
              `🎉 <b>عضویت شما در گروه معاملاتی تایید شد!</b>\n\nهم‌اکنون تمامی امکانات ربات جهت ثبت پیشنهاد و انجام مبادلات برای شما فعال گردید.`,
              { ...dynamicKb }
            )
            .catch((err) => console.error('Failed to notify user upon joining group:', err));
        }
      }
    } catch (err) {
      console.error('Error handling chat_member update:', err);
    }
  });
}
