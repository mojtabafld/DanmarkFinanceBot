import { Telegraf, Markup } from 'telegraf';
import { BotContext } from '../index';
import { config } from '../../config';
import { prisma } from '../../database/db';
import { getMainKeyboard, mainKeyboard } from '../utils/keyboards';
import { updateGroupProposalMessage, formatToShamsi, getTimezoneByCountry } from '../utils/groupMessage';
import { ADMIN_SEARCH_SCENE_ID } from '../scenes/adminSearch';
import { ADMIN_EDIT_USER_SCENE_ID, ADMIN_REJECT_USER_SCENE_ID } from '../scenes/adminEditUser';
import { ADMIN_EDIT_PROP_SCENE_ID } from '../scenes/adminEditProp';
import { ADMIN_UPDATE_RATES_SCENE_ID } from '../scenes/adminUpdateRates';
import { canOperate, notifyChatId } from '../../data/admins';
import { recordAudit, snapshot } from '../../data/audit';
import { transitionDeal } from '../../data/deals';
import { refreshDealCards } from './dealCardHandlers';
import { applyDealEvent } from '../../domain/dealMachine';
import { escapeHtml, mentionUser } from '../utils/html';

/**
 * Callback-data prefixes that only the admin may trigger. Kept in one place so a
 * new admin button cannot silently ship without an authorization check.
 */
export const ADMIN_CALLBACK_PREFIXES = [
  'ADMIN_',
  'APPROVE_USER_',
  'REJECT_USER_',
  'CONFIRM_BUYER_RECEIPT_',
  'REJECT_BUYER_RECEIPT_',
  'CONFIRM_SELLER_RECEIPT_',
  'REJECT_SELLER_RECEIPT_'
] as const;

/**
 * Buttons already delivered to Telegram keep the callback data they were sent with
 * forever, so receipt buttons from before the CONFIRM_/APPROVE_ rename still arrive
 * under the old names. Map them onto the names the handlers below actually match.
 */
const CALLBACK_ALIASES: Record<string, string> = {
  APPROVE_BUYER_RECEIPT_: 'CONFIRM_BUYER_RECEIPT_',
  APPROVE_SELLER_RECEIPT_: 'CONFIRM_SELLER_RECEIPT_'
};

export function normalizeCallbackData(data: string): string {
  for (const [alias, canonical] of Object.entries(CALLBACK_ALIASES)) {
    if (data.startsWith(alias)) return canonical + data.slice(alias.length);
  }
  return data;
}

export function isAdminCallback(data: string): boolean {
  return ADMIN_CALLBACK_PREFIXES.some(prefix => data.startsWith(prefix));
}

export function registerAdminHandlers(bot: Telegraf<BotContext>) {
  // Admin Command (/admin)
  bot.command('admin', async (ctx) => {
    const from = ctx.from;
    if (!from || !(await canOperate(from.id))) {
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
            Markup.button.callback('👥 مدیریت کاربران', 'ADMIN_USER_MNG'),
            Markup.button.callback('📋 مدیریت آگهی‌ها', 'ADMIN_PROP_MNG')
          ],
          [
            Markup.button.callback('📈 آپدیت نرخ ارز', 'ADMIN_RATES_MNG'),
            Markup.button.callback('📊 آمار کل سیستم', 'ADMIN_STATS')
          ],
          [Markup.button.callback('❌ بستن منو', 'ADMIN_CLOSE')]
        ])
      }
    );
  });

  bot.use(async (ctx, next) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return next();
    const data = normalizeCallbackData(ctx.callbackQuery.data);
    const from = ctx.from;
    if (!from) return next();

    // Identity is a lookup against the Admin table now. Comparing the sender against
    // ADMIN_CHAT_ID could never match when that id named a group, which is what the
    // setup docs told operators to configure.
    const isAdmin = await canOperate(from.id);

    if (isAdminCallback(data) && !isAdmin) {
      await ctx.answerCbQuery('⚠️ این دکمه مخصوص مدیریت ربات است.', { show_alert: true });
      return;
    }

    if (!isAdmin) return next();

    if (data === 'ADMIN_CLOSE') {
      await ctx.answerCbQuery();
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (data === 'ADMIN_MAIN_MENU') {
      await ctx.answerCbQuery();
      const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;
      const menuText = '⚙️ <b>منوی مدیریت ربات DanmarkFinance:</b>\n\nیکی از گزینه‌های زیر را انتخاب کنید:';
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('👥 مدیریت کاربران', 'ADMIN_USER_MNG'),
          Markup.button.callback('📋 مدیریت آگهی‌ها', 'ADMIN_PROP_MNG')
        ],
        [
          Markup.button.callback('📈 آپدیت نرخ ارز', 'ADMIN_RATES_MNG'),
          Markup.button.callback('📊 آمار کل سیستم', 'ADMIN_STATS')
        ],
        [Markup.button.callback('❌ بستن منو', 'ADMIN_CLOSE')]
      ]);

      if (hasPhoto) {
        await ctx.deleteMessage().catch(() => {});
        await ctx.reply(menuText, { parse_mode: 'HTML', ...keyboard });
      } else {
        await ctx.editMessageText(menuText, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
      }
      return;
    }

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
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 بازگشت', 'ADMIN_MAIN_MENU')]])
        }).catch(() => {});
      } catch (error) {
        console.error('Error fetching admin stats:', error);
        await ctx.reply('خطا در بارگذاری آمار.');
      }
      return;
    }

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

        const buttons = users.map((u) => [
          Markup.button.callback(
            `${escapeHtml(u.fullName || u.firstName)} (@${escapeHtml(u.username || 'ندارد')})`,
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

        buttons.push([Markup.button.callback('🔙 بازگشت به مدیریت کاربران', 'ADMIN_USER_MNG')]);

        const totalPages = Math.ceil(total / pageSize) || 1;
        const msgText =
          `👥 <b>لیست کاربران تایید شده:</b>\n` +
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

        const buttons = users.map((u) => [
          Markup.button.callback(
            `⏳ ${escapeHtml(u.fullName || u.firstName)} (@${escapeHtml(u.username || 'ندارد')})`,
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

        buttons.push([Markup.button.callback('🔙 بازگشت به مدیریت کاربران', 'ADMIN_USER_MNG')]);

        const totalPages = Math.ceil(total / pageSize) || 1;
        const msgText =
          `⏳ <b>لیست درخواست‌های در انتظار بررسی:</b>\n` +
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
          const emptyText = '❌ هیچ کاربر رد صلاحیتی وجود ندارد.';
          const emptyMarkup = Markup.inlineKeyboard([[Markup.button.callback('🔙 بازگشت', 'ADMIN_MAIN_MENU')]]);
          if (hasPhoto) {
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(emptyText, emptyMarkup);
          } else {
            await ctx.editMessageText(emptyText, emptyMarkup).catch(() => {});
          }
          return;
        }

        const buttons = users.map((u) => [
          Markup.button.callback(
            `❌ ${escapeHtml(u.fullName || u.firstName)} (@${escapeHtml(u.username || 'ندارد')})`,
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

        buttons.push([Markup.button.callback('🔙 بازگشت به مدیریت کاربران', 'ADMIN_USER_MNG')]);

        const totalPages = Math.ceil(total / pageSize) || 1;
        const msgText =
          `❌ <b>لیست کاربران رد صلاحیت شده:</b>\n` +
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
        console.error('Error listing rejected users:', error);
      }
      return;
    }

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

        const proposalsCount = await prisma.proposal.count({ where: { creatorId: u.id } });
        const activeProposalsCount = await prisma.proposal.count({
          where: { creatorId: u.id, status: 'PENDING' }
        });

        const detailsText =
          `👤 <b>مشخصات کاربر:</b>\n\n` +
          `🔹 <b>نام واقعی:</b> <code>${escapeHtml(u.fullName || 'ثبت نشده')}</code>\n` +
          `🔹 <b>نام کاربری:</b> @${escapeHtml(u.username || 'ندارد')}\n` +
          `🔹 <b>شماره تماس:</b> <code>${escapeHtml(u.phoneNumber || 'ثبت نشده')}</code>\n` +
          `🔹 <b>کشور محل اقامت:</b> <code>${escapeHtml(u.country || 'ثبت نشده')}</code>\n` +
          `🔹 <b>وضعیت کنونی:</b> <code>${u.verificationStatus}</code>\n` +
          `🔹 <b>حد مجاز روزانه:</b> <code>${u.dailyProposalLimit}</code> پیشنهاد\n` +
          `🔹 <b>تعداد پیشنهادها:</b> <code>${proposalsCount}</code> (فعال: <code>${activeProposalsCount}</code>)\n` +
          `🔹 <b>شناسه تلگرام:</b> <code>${u.telegramId}</code>` +
          (u.rejectReason ? `\n💬 <b>علت رد/لغو:</b> <code>${escapeHtml(u.rejectReason)}</code>` : '');

        const buttons = [];

        if (u.verificationStatus === 'PENDING') {
          buttons.push([
            Markup.button.callback('✅ تایید درخواست', `APPROVE_USER_${u.id}`),
            Markup.button.callback('❌ رد درخواست', `REJECT_USER_${u.id}`)
          ]);
        } else if (u.verificationStatus === 'APPROVED') {
          buttons.push([Markup.button.callback('🚫 لغو احراز هویت و اخراج', `ADMIN_USER_REVOKE_${u.id}`)]);
        } else if (u.verificationStatus === 'REJECTED') {
          buttons.push([Markup.button.callback('✅ تایید احراز هویت', `APPROVE_USER_${u.id}`)]);
        }

        buttons.push([
          Markup.button.callback('✏️ نام واقعی', `ADMIN_EDIT_name_${u.id}`),
          Markup.button.callback('✏️ شماره تماس', `ADMIN_EDIT_phone_${u.id}`)
        ]);

        buttons.push([
          Markup.button.callback('✏️ کشور اقامت', `ADMIN_EDIT_country_${u.id}`),
          Markup.button.callback('✏️ حد مجاز روزانه', `ADMIN_EDIT_limit_${u.id}`)
        ]);

        buttons.push([
          Markup.button.callback('✏️ تغییر وضعیت', `ADMIN_EDIT_status_${u.id}`),
          Markup.button.callback('🗑 حذف کامل از ربات', `ADMIN_USER_DELETE_${u.id}`)
        ]);

        buttons.push([Markup.button.callback('📋 پیشنهادهای این کاربر', `ADMIN_USER_PROPS_${u.id}_0`)]);

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

    if (data.startsWith('ADMIN_USER_DELETE_')) {
      const userId = parseInt(data.replace('ADMIN_USER_DELETE_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(userId)) return;

      try {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (user) {
          const tgId = parseInt(user.telegramId, 10);
          await ctx.telegram.banChatMember(config.GROUP_CHAT_ID, tgId).catch(() => {});
          await ctx.telegram.unbanChatMember(config.GROUP_CHAT_ID, tgId).catch(() => {});

          await prisma.user.delete({ where: { id: userId } });

          await ctx.telegram
            .sendMessage(user.telegramId, '❌ اکانت کاربری شما در ربات توسط مدیریت به طور کامل حذف شد.')
            .catch(() => {});

          await ctx.reply(
            `🗑 کاربر <b>${escapeHtml(user.fullName || user.firstName)}</b> به همراه تمامی داده‌هایش حذف و از گروه اخراج شد.`
          );
          await ctx.deleteMessage().catch(() => {});
        }
      } catch (error) {
        console.error('Error deleting user:', error);
        await ctx.reply('❌ خطا در حذف کامل کاربر.');
      }
      return;
    }

    if (data === 'ADMIN_SEARCH_USER') {
      await ctx.answerCbQuery();
      await ctx.scene.enter(ADMIN_SEARCH_SCENE_ID);
      return;
    }

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

    if (data.startsWith('APPROVE_USER_')) {
      const userId = parseInt(data.replace('APPROVE_USER_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(userId)) return;

      try {
        const user = await prisma.user.update({
          where: { id: userId },
          data: { verificationStatus: 'APPROVED' }
        });

        const inviteLink = await ctx.telegram.createChatInviteLink(config.GROUP_CHAT_ID, {
          member_limit: 1,
          name: `Invite for ${user.fullName}`,
          expire_date: Math.floor(Date.now() / 1000) + 86400
        });

        const userMsg =
          `🎉 <b>احراز هویت شما با موفقیت توسط مدیریت تایید شد!</b>\n\n` +
          `لینک عضویت یک‌بار مصرف شما در گروه معاملاتی دانمارک (دارای اعتبار ۲۴ ساعته):\n` +
          `🔗 ${inviteLink.invite_link}\n\n` +
          `پس از عضویت در گروه، می‌توانید پیشنهادهای خود را از دکمه‌های زیر ثبت و مدیریت کنید.`;

        await ctx.telegram.sendMessage(user.telegramId, userMsg, {
          parse_mode: 'HTML',
          ...mainKeyboard
        });

        const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;
        const confirmationText =
          `✅ <b>احراز هویت کاربر تایید شد</b>\n\n` +
          `👤 <b>نام کامل:</b> ${escapeHtml(user.fullName)}\n` +
          `🌍 <b>کشور:</b> ${escapeHtml(user.country)}\n` +
          `📱 <b>تلفن:</b> ${escapeHtml(user.phoneNumber)}\n\n` +
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

        const proposalsCount = await prisma.proposal.count({ where: { creatorId: u.id } });
        const activeProposalsCount = await prisma.proposal.count({
          where: { creatorId: u.id, status: 'PENDING' }
        });

        const detailsText =
          `⚙️ <b>مدیریت کاربر از روی پیشنهاد گروه:</b>\n\n` +
          `👤 <b>مشخصات کاربر:</b>\n` +
          `🔹 <b>نام واقعی:</b> <code>${escapeHtml(u.fullName || 'ثبت نشده')}</code>\n` +
          `🔹 <b>نام کاربری:</b> @${escapeHtml(u.username || 'ندارد')}\n` +
          `🔹 <b>شماره تماس:</b> <code>${escapeHtml(u.phoneNumber || 'ثبت نشده')}</code>\n` +
          `🔹 <b>کشور محل اقامت:</b> <code>${escapeHtml(u.country || 'ثبت نشده')}</code>\n` +
          `🔹 <b>وضعیت کنونی:</b> <code>${u.verificationStatus}</code>\n` +
          `🔹 <b>حد مجاز روزانه:</b> <code>${u.dailyProposalLimit}</code> پیشنهاد\n` +
          `🔹 <b>تعداد پیشنهادها:</b> <code>${proposalsCount}</code> (فعال: <code>${activeProposalsCount}</code>)\n` +
          `🔹 <b>شناسه تلگرام:</b> <code>${u.telegramId}</code>` +
          (u.rejectReason ? `\n💬 <b>علت رد/لغو:</b> <code>${escapeHtml(u.rejectReason)}</code>` : '');

        const buttons = [];

        if (u.verificationStatus === 'PENDING') {
          buttons.push([
            Markup.button.callback('✅ تایید درخواست', `APPROVE_USER_${u.id}`),
            Markup.button.callback('❌ رد درخواست', `REJECT_USER_${u.id}`)
          ]);
        } else if (u.verificationStatus === 'APPROVED') {
          buttons.push([Markup.button.callback('🚫 لغو احراز هویت و اخراج', `ADMIN_USER_REVOKE_${u.id}`)]);
        } else if (u.verificationStatus === 'REJECTED') {
          buttons.push([Markup.button.callback('✅ تایید احراز هویت', `APPROVE_USER_${u.id}`)]);
        }

        buttons.push([
          Markup.button.callback('✏️ نام واقعی', `ADMIN_EDIT_name_${u.id}`),
          Markup.button.callback('✏️ شماره تماس', `ADMIN_EDIT_phone_${u.id}`)
        ]);

        buttons.push([
          Markup.button.callback('✏️ کشور اقامت', `ADMIN_EDIT_country_${u.id}`),
          Markup.button.callback('✏️ حد مجاز روزانه', `ADMIN_EDIT_limit_${u.id}`)
        ]);

        buttons.push([
          Markup.button.callback('✏️ تغییر وضعیت', `ADMIN_EDIT_status_${u.id}`),
          Markup.button.callback('🗑 حذف کامل از ربات', `ADMIN_USER_DELETE_${u.id}`)
        ]);

        buttons.push([Markup.button.callback('🔙 بازگشت به منوی اصلی', 'ADMIN_MAIN_MENU')]);

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

        await ctx.answerCbQuery('⚙️ مشخصات کاربر ثبت‌کننده به چت خصوصی شما ارسال شد.', { show_alert: false });
      } catch (error) {
        console.error('Error in ADMIN_PROP_MANAGE_:', error);
        await ctx.answerCbQuery('❌ خطا در بررسی مشخصات.', { show_alert: true });
      }
      return;
    }

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

        const buttons = props.map((p) => [
          Markup.button.callback(
            `[${p.type === 'BUY' ? '🟢 خرید' : '🔴 فروش'}] ${p.amount.toLocaleString('fa-IR')} ${escapeHtml(p.currency)} (توسط ${escapeHtml(p.creator.fullName || p.creator.firstName)})`,
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

        buttons.push([Markup.button.callback('🔙 بازگشت به مدیریت آگهی‌ها', 'ADMIN_PROP_MNG')]);

        const totalPages = Math.ceil(total / pageSize) || 1;
        const msgText =
          `📋 <b>مدیریت پیشنهادات فعال کل سیستم:</b>\n` +
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
          const emptyText = `📋 کاربر <b>${escapeHtml(u.fullName || u.firstName)}</b> هیچ پیشنهادی ثبت نکرده است.`;
          const emptyMarkup = Markup.inlineKeyboard([
            [Markup.button.callback('👤 بازگشت به پرونده کاربر', `ADMIN_USER_VIEW_${userId}`)]
          ]);
          if (hasPhoto) {
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(emptyText, emptyMarkup);
          } else {
            await ctx.editMessageText(emptyText, emptyMarkup).catch(() => {});
          }
          return;
        }

        const buttons = props.map((p) => [
          Markup.button.callback(
            `[${p.type === 'BUY' ? '🟢 خرید' : '🔴 فروش'}] ${p.amount.toLocaleString('fa-IR')} ${escapeHtml(p.currency)} [${p.status}]`,
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
        const msgText =
          `📋 <b>پیشنهادات کاربر: ${escapeHtml(u.fullName || u.firstName)}</b>\n` +
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
          `🔹 <b>ثبت‌کننده:</b> <code>${escapeHtml(prop.creator.fullName || prop.creator.firstName)}</code> (@${escapeHtml(prop.creator.username || 'ندارد')})\n` +
          `🔹 <b>شناسه تلگرام ثبت‌کننده:</b> <code>${prop.creator.telegramId}</code>\n` +
          `🔹 <b>نوع معامله:</b> ${prop.type === 'BUY' ? '🟢 خرید (Buy)' : '🔴 فروش (Sell)'}\n` +
          `🔹 <b>ارز:</b> <code>${escapeHtml(prop.currency)}</code>\n` +
          `🔹 <b>مقدار:</b> <code>${prop.amount.toLocaleString('fa-IR')}</code>\n` +
          `🔹 <b>قیمت واحد:</b> <code>${prop.price.toLocaleString('fa-IR')}</code> تومان\n` +
          `🔹 <b>مبلغ کل:</b> <code>${(prop.amount * prop.price).toLocaleString('fa-IR')}</code> تومان\n` +
          `🔹 <b>وضعیت کنونی:</b> <code>${prop.status}</code>\n` +
          `🔹 <b>تاریخ ثبت:</b> <code>${prop.createdAt.toLocaleString('fa-IR')}</code>`;

        const buttons = [];

        if (prop.status === 'PENDING') {
          buttons.push([Markup.button.callback('❌ لغو پیشنهاد در گروه', `ADMIN_PROP_CANCEL_${prop.id}`)]);
          buttons.push([
            Markup.button.callback('✏️ ویرایش مقدار', `ADMIN_PROP_EDIT_amount_${prop.id}`),
            Markup.button.callback('✏️ ویرایش قیمت', `ADMIN_PROP_EDIT_price_${prop.id}`)
          ]);
        } else if (prop.status === 'PENDING_APPROVAL') {
          buttons.push([
            Markup.button.callback('✅ تایید آگهی', `ADMIN_PROP_APPROVE_${prop.id}`),
            Markup.button.callback('❌ رد آگهی', `ADMIN_PROP_REJECT_${prop.id}`)
          ]);
        }

        buttons.push([Markup.button.callback('🗑 حذف کامل از دیتابیس', `ADMIN_PROP_DELETE_${prop.id}`)]);

        let backTarget = 'ADMIN_PROP_MNG';
        if (prop.status === 'PENDING') backTarget = 'ADMIN_LIST_PROPOSALS';
        else if (prop.status === 'PENDING_APPROVAL') backTarget = 'ADMIN_LIST_PENDING_APPROVAL';
        else if (prop.status === 'COMPLETED' || prop.status === 'CANCELLED') backTarget = 'ADMIN_LIST_ENDED_PROPOSALS';

        buttons.push([
          Markup.button.callback('👤 پرونده کاربر ثبت‌کننده', `ADMIN_USER_VIEW_${prop.creator.id}`),
          Markup.button.callback('🔙 بازگشت به لیست آگهی‌ها', backTarget)
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

        await ctx.telegram
          .sendMessage(
            prop.creator.telegramId,
            `⚠️ <b>پیشنهاد معامله شما (شماره #${propId}) توسط مدیریت ربات لغو شد.</b>`
          )
          .catch(() => {});

        if (prop.groupMessageId) {
          await updateGroupProposalMessage(ctx.telegram, prop.id);
        }

        const updatedTarget = `ADMIN_PROP_VIEW_${propId}`;
        const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;
        if (hasPhoto) {
          await ctx.deleteMessage().catch(() => {});
          await ctx.reply(
            'در حال بارگذاری مجدد...',
            Markup.inlineKeyboard([[Markup.button.callback('🔄 مشاهده پرونده پیشنهاد', updatedTarget)]])
          );
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
          await ctx.telegram
            .deleteMessage(config.GROUP_CHAT_ID, prop.groupMessageId)
            .catch((err) => console.error('Failed to delete group message:', err));
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

    if (data === 'ADMIN_USER_MNG') {
      await ctx.answerCbQuery();
      const userMngText =
        `👥 <b>مدیریت کاربران - DanmarkFinance:</b>\n\n` +
        `لطفاً یکی از بخش‌های زیر را انتخاب کنید:`;
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('👥 تایید شده‌ها', 'ADMIN_LIST_APPROVED'),
          Markup.button.callback('⏳ در انتظار بررسی', 'ADMIN_LIST_PENDING')
        ],
        [
          Markup.button.callback('❌ رد صلاحیت شده‌ها', 'ADMIN_LIST_REJECTED'),
          Markup.button.callback('🔍 جستجوی کاربر', 'ADMIN_SEARCH_USER')
        ],
        [Markup.button.callback('🔙 بازگشت به منوی اصلی', 'ADMIN_MAIN_MENU')]
      ]);

      const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;
      if (hasPhoto) {
        await ctx.deleteMessage().catch(() => {});
        await ctx.reply(userMngText, { parse_mode: 'HTML', ...keyboard });
      } else {
        await ctx.editMessageText(userMngText, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
      }
      return;
    }

    if (data === 'ADMIN_PROP_MNG') {
      await ctx.answerCbQuery();
      const propMngText =
        `📋 <b>مدیریت آگهی‌ها - DanmarkFinance:</b>\n\n` +
        `لطفاً یکی از بخش‌های زیر را انتخاب کنید:`;
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('📋 لیست آگهی‌های فعال', 'ADMIN_LIST_PROPOSALS'),
          Markup.button.callback('⏳ در انتظار تایید ادمین', 'ADMIN_LIST_PENDING_APPROVAL')
        ],
        [Markup.button.callback('🗄 آگهی‌های پایان‌یافته (آرشیو)', 'ADMIN_LIST_ENDED_PROPOSALS')],
        [Markup.button.callback('🔙 بازگشت به منوی اصلی', 'ADMIN_MAIN_MENU')]
      ]);

      const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;
      if (hasPhoto) {
        await ctx.deleteMessage().catch(() => {});
        await ctx.reply(propMngText, { parse_mode: 'HTML', ...keyboard });
      } else {
        await ctx.editMessageText(propMngText, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
      }
      return;
    }

    if (data === 'ADMIN_RATES_MNG') {
      await ctx.answerCbQuery();
      await ctx.deleteMessage().catch(() => {});
      await ctx.scene.enter(ADMIN_UPDATE_RATES_SCENE_ID);
      return;
    }

    if (data === 'ADMIN_LIST_PENDING_APPROVAL' || data.startsWith('ADMIN_LIST_PEN_APP_')) {
      await ctx.answerCbQuery();
      const page = data.startsWith('ADMIN_LIST_PEN_APP_') ? parseInt(data.replace('ADMIN_LIST_PEN_APP_', ''), 10) : 0;
      const pageSize = 10;

      try {
        const total = await prisma.proposal.count({ where: { status: 'PENDING_APPROVAL' } });
        const props = await prisma.proposal.findMany({
          where: { status: 'PENDING_APPROVAL' },
          skip: page * pageSize,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
          include: { creator: true }
        });

        const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;

        if (props.length === 0 && page === 0) {
          const emptyText = '📋 هیچ آگهی در انتظار تایید مدیریتی یافت نشد.';
          const emptyMarkup = Markup.inlineKeyboard([[Markup.button.callback('🔙 بازگشت', 'ADMIN_PROP_MNG')]]);
          if (hasPhoto) {
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(emptyText, emptyMarkup);
          } else {
            await ctx.editMessageText(emptyText, emptyMarkup).catch(() => {});
          }
          return;
        }

        const buttons = props.map((p) => [
          Markup.button.callback(
            `[${p.type === 'BUY' ? '🟢 خرید' : '🔴 فروش'}] ${p.amount.toLocaleString('fa-IR')} ${escapeHtml(p.currency)} (توسط ${escapeHtml(p.creator.fullName || p.creator.firstName)})`,
            `ADMIN_PROP_VIEW_${p.id}`
          )
        ]);

        const navRow = [];
        if (page > 0) {
          navRow.push(Markup.button.callback('⬅️ صفحه قبل', `ADMIN_LIST_PEN_APP_${page - 1}`));
        }
        if ((page + 1) * pageSize < total) {
          navRow.push(Markup.button.callback('صفحه بعد ➡️', `ADMIN_LIST_PEN_APP_${page + 1}`));
        }
        if (navRow.length > 0) {
          buttons.push(navRow);
        }

        buttons.push([Markup.button.callback('🔙 بازگشت به مدیریت آگهی‌ها', 'ADMIN_PROP_MNG')]);

        const totalPages = Math.ceil(total / pageSize) || 1;
        const msgText =
          `📋 <b>آگهی‌های در انتظار بررسی و تایید:</b>\n` +
          `صفحه <code>${page + 1}</code> از <code>${totalPages}</code> (کل: <code>${total}</code> آگهی)\n\n` +
          `برای مشاهده جزئیات و تایید/رد هر آگهی کلیک کنید:`;

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
        console.error('Error listing pending approval proposals:', error);
      }
      return;
    }

    if (data === 'ADMIN_LIST_ENDED_PROPOSALS' || data.startsWith('ADMIN_LIST_END_PROP_')) {
      await ctx.answerCbQuery();
      const page = data.startsWith('ADMIN_LIST_END_PROP_') ? parseInt(data.replace('ADMIN_LIST_END_PROP_', ''), 10) : 0;
      const pageSize = 10;

      try {
        const total = await prisma.proposal.count({
          where: { status: { in: ['COMPLETED', 'CANCELLED'] } }
        });
        const props = await prisma.proposal.findMany({
          where: { status: { in: ['COMPLETED', 'CANCELLED'] } },
          skip: page * pageSize,
          take: pageSize,
          orderBy: { updatedAt: 'desc' },
          include: { creator: true }
        });

        const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;

        if (props.length === 0 && page === 0) {
          const emptyText = '🗄 هیچ آگهی پایان‌یافته‌ای در سیستم یافت نشد.';
          const emptyMarkup = Markup.inlineKeyboard([[Markup.button.callback('🔙 بازگشت', 'ADMIN_PROP_MNG')]]);
          if (hasPhoto) {
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(emptyText, emptyMarkup);
          } else {
            await ctx.editMessageText(emptyText, emptyMarkup).catch(() => {});
          }
          return;
        }

        const buttons = props.map((p) => [
          Markup.button.callback(
            `[${p.status === 'COMPLETED' ? '✅ موفق' : '❌ لغو'}] ${p.amount.toLocaleString('fa-IR')} ${escapeHtml(p.currency)} (توسط ${escapeHtml(p.creator.fullName || p.creator.firstName)})`,
            `ADMIN_PROP_VIEW_${p.id}`
          )
        ]);

        const navRow = [];
        if (page > 0) {
          navRow.push(Markup.button.callback('⬅️ صفحه قبل', `ADMIN_LIST_END_PROP_${page - 1}`));
        }
        if ((page + 1) * pageSize < total) {
          navRow.push(Markup.button.callback('صفحه بعد ➡️', `ADMIN_LIST_END_PROP_${page + 1}`));
        }
        if (navRow.length > 0) {
          buttons.push(navRow);
        }

        buttons.push([Markup.button.callback('🔙 بازگشت به مدیریت آگهی‌ها', 'ADMIN_PROP_MNG')]);

        const totalPages = Math.ceil(total / pageSize) || 1;
        const msgText =
          `🗄 <b>آرشیو آگهی‌های پایان‌یافته:</b>\n` +
          `صفحه <code>${page + 1}</code> از <code>${totalPages}</code> (کل: <code>${total}</code> آگهی)\n\n` +
          `برای مشاهده جزئیات یا حذف کامل هر آگهی کلیک کنید:`;

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
        console.error('Error listing ended proposals:', error);
      }
      return;
    }

    if (data.startsWith('ADMIN_PROP_APPROVE_')) {
      const propId = parseInt(data.replace('ADMIN_PROP_APPROVE_', ''), 10);
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

        if (prop.status !== 'PENDING_APPROVAL') {
          await ctx.reply(`⚠️ این آگهی قبلاً تعیین تکلیف شده است (وضعیت فعلی: ${prop.status}).`);
          return;
        }

        const typeHeader = prop.type === 'BUY' ? '🟢 #خرید_ارز' : '🔴 #فروش_ارز';
        const userMention = mentionUser(prop.creator);

        const groupMsgText =
          `📢 <b>پیشنهاد جدید معاملاتی</b>\n\n` +
          `<b>${typeHeader}</b>\n\n` +
          `🔹 <b>کد حواله:</b> <code>${prop.code ?? '---'}</code>\n` +
          `🔹 <b>ارز:</b> <code>${escapeHtml(prop.currency)}</code>\n` +
          `🔹 <b>نوع تسویه:</b> <code>${escapeHtml(prop.paymentMethod ?? '---')}</code>\n` +
          `🔹 <b>مقدار کل:</b> <code>${prop.amount.toLocaleString('fa-IR')}</code>\n` +
          `🔹 <b>مقدار باقیمانده:</b> <code>${prop.amount.toLocaleString('fa-IR')}</code>\n` +
          `🔹 <b>قیمت واحد:</b> <code>${prop.price.toLocaleString('fa-IR')}</code> تومان\n` +
          `🔹 <b>مبلغ کل:</b> <code>${(prop.amount * prop.price).toLocaleString('fa-IR')}</code> تومان\n` +
          `👤 <b>توسط:</b> ${userMention}\n` +
          `📅 <b>تاریخ ثبت:</b> <code>${escapeHtml(formatToShamsi(prop.createdAt, getTimezoneByCountry(prop.creator.country)))}</code>\n\n` +
          `ℹ️ برای ارسال پاسخ، قبول پیشنهاد یا گفتگو با ثبت‌کننده، روی دکمه زیر کلیک کنید:`;

        const deepLinkUrl = `https://t.me/${config.BOT_USERNAME}?start=deal_${prop.id}`;

        const sentMessage = await ctx.telegram.sendMessage(config.GROUP_CHAT_ID, groupMsgText, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.url('🤝 قبول پیشنهاد / ارسال پاسخ', deepLinkUrl)]])
        });

        const updatedProp = await prisma.proposal.update({
          where: { id: propId },
          data: {
            status: 'PENDING',
            groupMessageId: sentMessage.message_id
          },
          include: { creator: true }
        });

        await ctx.telegram
          .sendMessage(
            updatedProp.creator.telegramId,
            `🎉 <b>پیشنهاد معاملاتی شما (کد حواله ${updatedProp.code}) با موفقیت توسط مدیریت تایید و در گروه منتشر شد.</b>`
          )
          .catch((err) => console.error('Failed to notify creator of approval:', err));

        const successMsgText = `✅ پیشنهاد شماره <code>${updatedProp.code}</code> با موفقیت تایید و در گروه منتشر شد.`;

        const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;
        if (hasPhoto) {
          await ctx.editMessageCaption(successMsgText, { parse_mode: 'HTML' }).catch(() => {});
        } else {
          await ctx.editMessageText(successMsgText, { parse_mode: 'HTML' }).catch(() => {});
        }

        const adminMsgText =
          `🔔 <b>پیشنهاد جدید معاملاتی ثبت شد:</b>\n\n` +
          `<b>${typeHeader}</b>\n\n` +
          `🔹 <b>کد حواله:</b> <code>${updatedProp.code}</code>\n` +
          `🔹 <b>ارز:</b> <code>${escapeHtml(updatedProp.currency)}</code>\n` +
          `🔹 <b>نوع تسویه:</b> <code>${escapeHtml(updatedProp.paymentMethod)}</code>\n` +
          `🔹 <b>مقدار:</b> <code>${updatedProp.amount.toLocaleString('fa-IR')}</code>\n` +
          `🔹 <b>قیمت واحد:</b> <code>${updatedProp.price.toLocaleString('fa-IR')}</code> تومان\n` +
          `🔹 <b>مبلغ کل:</b> <code>${(updatedProp.amount * updatedProp.price).toLocaleString('fa-IR')}</code> تومان\n` +
          `👤 <b>توسط:</b> ${userMention}\n` +
          `📅 <b>تاریخ ثبت:</b> <code>${escapeHtml(formatToShamsi(updatedProp.createdAt, getTimezoneByCountry(updatedProp.creator.country)))}</code>\n\n` +
          `⚙️ <b>دکمه‌های مدیریت پیشنهاد:</b>`;

        await ctx.telegram
          .sendMessage(config.ADMIN_CHAT_ID, adminMsgText, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('❌ لغو پیشنهاد', `ADMIN_PROP_CANCEL_${updatedProp.id}`),
                Markup.button.callback('🗑 حذف پیشنهاد', `ADMIN_PROP_DELETE_${updatedProp.id}`)
              ],
              [
                Markup.button.callback('✏️ مقدار', `ADMIN_PROP_EDIT_amount_${updatedProp.id}`),
                Markup.button.callback('✏️ قیمت', `ADMIN_PROP_EDIT_price_${updatedProp.id}`)
              ],
              [Markup.button.callback('👤 پرونده کاربر ثبت‌کننده', `ADMIN_USER_VIEW_${updatedProp.creatorId}`)]
            ])
          })
          .catch((err) => console.error('Failed to send admin control panel:', err));
      } catch (err) {
        console.error('Error approving proposal:', err);
        await ctx.reply('❌ خطا در تایید آگهی.');
      }
      return;
    }

    if (data.startsWith('ADMIN_PROP_REJECT_')) {
      const propId = parseInt(data.replace('ADMIN_PROP_REJECT_', ''), 10);
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

        if (prop.status !== 'PENDING_APPROVAL') {
          await ctx.reply(`⚠️ این آگهی قبلاً تعیین تکلیف شده است (وضعیت فعلی: ${prop.status}).`);
          return;
        }

        const updatedProp = await prisma.proposal.update({
          where: { id: propId },
          data: { status: 'CANCELLED' },
          include: { creator: true }
        });

        await ctx.telegram
          .sendMessage(
            updatedProp.creator.telegramId,
            `❌ <b>پیشنهاد معاملاتی شما (کد حواله ${updatedProp.code}) توسط مدیریت رد شد.</b>`
          )
          .catch((err) => console.error('Failed to notify creator of rejection:', err));

        const rejectMsgText = `❌ پیشنهاد شماره <code>${updatedProp.code}</code> رد صلاحیت و لغو شد.`;

        const hasPhoto = ctx.callbackQuery.message && 'photo' in ctx.callbackQuery.message;
        if (hasPhoto) {
          await ctx.editMessageCaption(rejectMsgText, { parse_mode: 'HTML' }).catch(() => {});
        } else {
          await ctx.editMessageText(rejectMsgText, { parse_mode: 'HTML' }).catch(() => {});
        }
      } catch (err) {
        console.error('Error rejecting proposal:', err);
        await ctx.reply('❌ خطا در رد آگهی.');
      }
      return;
    }

    if (data.startsWith('ADMIN_APPROVE_LIMIT_')) {
      const targetUserId = parseInt(data.replace('ADMIN_APPROVE_LIMIT_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(targetUserId)) return;

      try {
        const targetUser = await prisma.user.findUnique({
          where: { id: targetUserId }
        });

        if (!targetUser) {
          await ctx.reply('❌ کاربر یافت نشد.');
          return;
        }

        const updatedUser = await prisma.user.update({
          where: { id: targetUserId },
          data: {
            dailyProposalLimit: 10,
            hasPendingLimitRequest: false
          }
        });

        await ctx.telegram
          .sendMessage(
            targetUser.telegramId,
            `🎉 <b>درخواست افزایش سقف آگهی روزانه شما تایید شد!</b>\n\n` +
              `سقف آگهی‌های مجاز روزانه شما به <code>10</code> عدد افزایش یافت.`,
            { parse_mode: 'HTML' }
          )
          .catch((err) => console.error('Failed to notify user about limit increase approval:', err));

        const confirmationText = `✅ درخواست افزایش سقف روزانه کاربر <b>${escapeHtml(updatedUser.fullName || updatedUser.firstName)}</b> با موفقیت تایید شد و به ۱۰ عدد ارتقا یافت.`;
        await ctx.editMessageText(confirmationText, { parse_mode: 'HTML' }).catch(() => {});
      } catch (err) {
        console.error('Error in ADMIN_APPROVE_LIMIT:', err);
        await ctx.reply('❌ خطا در اعمال تغییرات سقف روزانه.');
      }
      return;
    }

    if (data.startsWith('ADMIN_REJECT_LIMIT_')) {
      const targetUserId = parseInt(data.replace('ADMIN_REJECT_LIMIT_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(targetUserId)) return;

      try {
        const targetUser = await prisma.user.findUnique({
          where: { id: targetUserId }
        });

        if (!targetUser) {
          await ctx.reply('❌ کاربر یافت نشد.');
          return;
        }

        await prisma.user.update({
          where: { id: targetUserId },
          data: { hasPendingLimitRequest: false }
        });

        await ctx.telegram
          .sendMessage(
            targetUser.telegramId,
            `❌ <b>درخواست افزایش سقف آگهی روزانه شما مورد موافقت مدیریت قرار نگرفت.</b>`
          )
          .catch((err) => console.error('Failed to notify user about limit increase rejection:', err));

        const confirmationText = `❌ درخواست افزایش سقف روزانه کاربر <b>${escapeHtml(targetUser.fullName || targetUser.firstName)}</b> رد شد.`;
        await ctx.editMessageText(confirmationText, { parse_mode: 'HTML' }).catch(() => {});
      } catch (err) {
        console.error('Error in ADMIN_REJECT_LIMIT:', err);
        await ctx.reply('❌ خطا در رد درخواست.');
      }
      return;
    }

    if (data.startsWith('ADMIN_DEAL_APPROVE_')) {
      const dealId = parseInt(data.replace('ADMIN_DEAL_APPROVE_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(dealId)) return;

      try {
        const deal = await prisma.deal.findUnique({
          where: { id: dealId },
          include: {
            proposal: { include: { creator: true } },
            acceptor: true
          }
        });

        if (!deal) {
          await ctx.reply('❌ معامله یافت نشد.');
          return;
        }

        if (deal.status !== 'PENDING_ADMIN') {
          await ctx.reply(`⚠️ این معامله قبلاً تعیین تکلیف شده است (وضعیت فعلی: ${deal.status}).`);
          return;
        }

        const acceptedOffer = await prisma.counterOffer.findFirst({
          where: {
            proposalId: deal.proposalId,
            proposerId: deal.acceptorId,
            status: 'ACCEPTED'
          }
        });
        const agreedPrice = acceptedOffer ? acceptedOffer.price : deal.proposal.price;
        const totalValue = deal.amount * agreedPrice;

        const moved = await transitionDeal(dealId, { type: 'ADMIN_APPROVE' }, from.id.toString());
        if (!moved.ok) {
          await ctx.reply(`⚠️ این معامله هم‌زمان تغییر کرد یا دیگر در این مرحله نیست (${moved.current ?? moved.reason}).`);
          return;
        }
        await refreshDealCards(ctx.telegram, dealId);

        const isProposalBuy = deal.proposal.type === 'BUY';
        const buyer = isProposalBuy ? deal.proposal.creator : deal.acceptor;
        const seller = isProposalBuy ? deal.acceptor : deal.proposal.creator;

        const buyerMsg =
          `🎉 <b>معامله شما با موفقیت توسط مدیریت تایید شد.</b>\n\n` +
          `🔹 <b>مقدار:</b> ${deal.amount.toLocaleString('fa-IR')} ${escapeHtml(deal.proposal.currency)}\n` +
          `🔹 <b>قیمت واحد:</b> ${agreedPrice.toLocaleString('fa-IR')} تومان\n` +
          `🔹 <b>مبلغ کل قابل واریز:</b> ${totalValue.toLocaleString('fa-IR')} تومان\n\n` +
          `لطفاً مبلغ کل فوق را واریز نموده و فیش واریزی خود را از طریق دکمه زیر ارسال فرمایید:`;

        const buyerKb = await getMainKeyboard(buyer.telegramId);
        await ctx.telegram.sendMessage(buyer.telegramId, buyerMsg, {
          parse_mode: 'HTML',
          ...buyerKb
        });

        const sellerMsg =
          `ℹ️ <b>معامله شما توسط مدیریت تایید شد.</b>\n\n` +
          `خریدار در حال واریز وجه می‌باشد. به محض واریز و تایید فیش توسط ادمین، اطلاع‌رسانی خواهد شد.`;

        const sellerKb = await getMainKeyboard(seller.telegramId);
        await ctx.telegram.sendMessage(seller.telegramId, sellerMsg, {
          parse_mode: 'HTML',
          ...sellerKb
        });

        await ctx.editMessageText(`✅ معامله #${dealId} تایید شد و خریدار جهت واریز وجه هدایت گردید.`).catch(() => {});
      } catch (err) {
        console.error('Error approving deal:', err);
        await ctx.reply('❌ خطا در تایید معامله.');
      }
      return;
    }

    if (data.startsWith('ADMIN_DEAL_REJECT_')) {
      const dealId = parseInt(data.replace('ADMIN_DEAL_REJECT_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(dealId)) return;

      try {
        const deal = await prisma.deal.findUnique({
          where: { id: dealId },
          include: {
            proposal: { include: { creator: true } },
            acceptor: true
          }
        });

        if (!deal) {
          await ctx.reply('❌ معامله یافت نشد.');
          return;
        }

        if (deal.status !== 'PENDING_ADMIN') {
          await ctx.reply(`⚠️ این معامله قبلاً تعیین تکلیف شده است (وضعیت فعلی: ${deal.status}).`);
          return;
        }

        const acceptedOffer = await prisma.counterOffer.findFirst({
          where: {
            proposalId: deal.proposalId,
            proposerId: deal.acceptorId,
            status: 'ACCEPTED'
          }
        });
        const agreedPrice = acceptedOffer ? acceptedOffer.price : deal.proposal.price;

        // Rejecting also returns the reserved amount to the ad, so this stays one
        // compound transaction rather than a call to transitionDeal. The lifecycle is
        // still the authority on whether the rejection is legal at all.
        const verdict = applyDealEvent(deal.status, { type: 'ADMIN_REJECT' });
        if (!verdict.ok) {
          await ctx.reply(`⚠️ در وضعیت فعلی (${deal.status}) امکان رد این معامله نیست.`);
          return;
        }

        await prisma.$transaction(async (tx) => {
          const claimed = await tx.deal.updateMany({
            where: { id: dealId, status: verdict.from },
            data: { status: verdict.to, deadlineAt: null, remindedAt: null }
          });
          if (claimed.count !== 1) throw new Error('DEAL_RACED');

          await recordAudit(tx, {
            actor: from.id.toString(),
            action: 'deal.admin_reject',
            subjectType: 'Deal',
            subjectId: dealId,
            before: { status: verdict.from },
            after: { status: verdict.to },
            note: 'amount returned to the ad'
          });

          const freshProposal = await tx.proposal.findUnique({
            where: { id: deal.proposalId }
          });

          if (!freshProposal) {
            throw new Error('PROPOSAL_NOT_FOUND');
          }

          const newAmount = freshProposal.amount + deal.amount;
          await tx.proposal.update({
            where: { id: deal.proposalId },
            data: {
              amount: newAmount,
              status: 'PENDING'
            }
          });

          const offerToReject = await tx.counterOffer.findFirst({
            where: {
              proposalId: deal.proposalId,
              proposerId: deal.acceptorId,
              status: 'ACCEPTED'
            }
          });

          if (offerToReject) {
            await tx.counterOffer.update({
              where: { id: offerToReject.id },
              data: { status: 'REJECTED' }
            });
          }
        });

        const creatorMsg =
          `❌ <b>معامله مربوط به آگهی #${deal.proposalId} توسط مدیریت تایید نهایی نشد و رد گردید.</b>\n\n` +
          `🔄 آگهی شما مجدداً در گروه فعال و دکمه قبول پیشنهاد بازگردانده شد.`;

        const creatorKb = await getMainKeyboard(deal.proposal.creator.telegramId);
        await ctx.telegram
          .sendMessage(deal.proposal.creator.telegramId, creatorMsg, { ...creatorKb })
          .catch((err) => console.error('Failed to notify creator of rejection:', err));

        const acceptorMsg =
          `❌ <b>معامله شما توسط مدیریت تایید نهایی نشد و لغو گردید.</b>\n\n` +
          `🔹 <b>جزئیات:</b> مقدار <code>${deal.amount.toLocaleString('fa-IR')}</code> ${escapeHtml(deal.proposal.currency)} با قیمت ${agreedPrice.toLocaleString('fa-IR')} تومان`;

        const acceptorKb = await getMainKeyboard(deal.acceptor.telegramId);
        await ctx.telegram
          .sendMessage(deal.acceptor.telegramId, acceptorMsg, {
            parse_mode: 'HTML',
            ...acceptorKb
          })
          .catch((err) => console.error('Failed to notify acceptor of rejection:', err));

        await ctx.editMessageText(`❌ معامله #${dealId} رد شد.`).catch(() => {});
        await updateGroupProposalMessage(ctx.telegram, deal.proposalId);
      } catch (err: any) {
        if (err?.message === 'DEAL_RACED') {
          await ctx.reply('⚠️ این معامله هم‌زمان توسط درخواست دیگری تعیین تکلیف شد.');
        } else {
          console.error('Error in ADMIN_DEAL_REJECT callback:', err);
          await ctx.reply('❌ خطایی در رد معامله رخ داد.');
        }
      }
      return;
    }

    if (data.startsWith('CONFIRM_BUYER_RECEIPT_')) {
      const dealId = parseInt(data.replace('CONFIRM_BUYER_RECEIPT_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(dealId)) return;

      try {
        const deal = await prisma.deal.findUnique({
          where: { id: dealId },
          include: {
            proposal: { include: { creator: true } },
            acceptor: true
          }
        });

        if (!deal || deal.status !== 'BUYER_PAID_PENDING_APPROVAL') {
          await ctx.reply(`❌ معامله در وضعیت معتبری نیست یا قبلاً بررسی شده است. (وضعیت فعلی: ${deal?.status})`);
          return;
        }

        const moved = await transitionDeal(dealId, { type: 'ADMIN_CONFIRM_BUYER_RECEIPT' }, from.id.toString());
        if (!moved.ok) {
          await ctx.reply(`⚠️ این معامله هم‌زمان تغییر کرد یا دیگر در این مرحله نیست (${moved.current ?? moved.reason}).`);
          return;
        }
        await refreshDealCards(ctx.telegram, dealId);

        const isProposalBuy = deal.proposal.type === 'BUY';
        const seller = isProposalBuy ? deal.acceptor : deal.proposal.creator;

        const sellerKb = await getMainKeyboard(seller.telegramId);
        await ctx.telegram.sendMessage(
          seller.telegramId,
          `✅ <b>فیش واریزی خریدار توسط مدیریت تایید شد.</b>\n\n` +
            `🔹 <b>مقدار:</b> ${deal.amount.toLocaleString('fa-IR')} ${escapeHtml(deal.proposal.currency)}\n\n` +
            `لطفاً اقدام به واریز ارز نموده و فیش را از طریق دکمه <b>«📤 ارسال فیش واریزی»</b> ارسال فرمایید.`,
          {
            parse_mode: 'HTML',
            ...sellerKb
          }
        );

        const hasPhoto = ctx.callbackQuery?.message && 'photo' in ctx.callbackQuery.message;
        const doneMsg = `✅ فیش واریزی خریدار برای معامله #${dealId} تایید شد و پیام جهت واریز ارز به فروشنده ارسال گردید.`;
        if (hasPhoto) {
          await ctx.editMessageCaption(doneMsg).catch(() => {});
        } else {
          await ctx.editMessageText(doneMsg).catch(() => {});
        }
      } catch (err) {
        console.error(err);
        await ctx.reply('❌ خطا در تایید فیش خریدار.');
      }
      return;
    }

    if (data.startsWith('REJECT_BUYER_RECEIPT_')) {
      const dealId = parseInt(data.replace('REJECT_BUYER_RECEIPT_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(dealId)) return;

      try {
        const deal = await prisma.deal.findUnique({
          where: { id: dealId },
          include: {
            proposal: { include: { creator: true } },
            acceptor: true
          }
        });

        if (!deal || deal.status !== 'BUYER_PAID_PENDING_APPROVAL') {
          await ctx.reply(`❌ معامله در وضعیت معتبری نیست یا قبلاً بررسی شده است. (وضعیت فعلی: ${deal?.status})`);
          return;
        }

        const moved = await transitionDeal(dealId, { type: 'ADMIN_REJECT_BUYER_RECEIPT' }, from.id.toString());
        if (!moved.ok) {
          await ctx.reply(`⚠️ این معامله هم‌زمان تغییر کرد یا دیگر در این مرحله نیست (${moved.current ?? moved.reason}).`);
          return;
        }
        await refreshDealCards(ctx.telegram, dealId);

        const isProposalBuy = deal.proposal.type === 'BUY';
        const buyer = isProposalBuy ? deal.proposal.creator : deal.acceptor;

        const buyerKb = await getMainKeyboard(buyer.telegramId);
        await ctx.telegram.sendMessage(
          buyer.telegramId,
          `❌ <b>فیش واریزی شما توسط مدیریت رد شد.</b>\n\n` +
            `لطفاً مجدداً بررسی نموده و فیش معتبر را از طریق دکمه <b>«📤 ارسال فیش واریزی»</b> ارسال نمایید.`,
          {
            parse_mode: 'HTML',
            ...buyerKb
          }
        );

        const hasPhoto = ctx.callbackQuery?.message && 'photo' in ctx.callbackQuery.message;
        const doneMsg = `❌ فیش واریزی خریدار برای معامله #${dealId} رد شد.`;
        if (hasPhoto) {
          await ctx.editMessageCaption(doneMsg).catch(() => {});
        } else {
          await ctx.editMessageText(doneMsg).catch(() => {});
        }
      } catch (err) {
        console.error(err);
        await ctx.reply('❌ خطا در رد فیش خریدار.');
      }
      return;
    }

    if (data.startsWith('CONFIRM_SELLER_RECEIPT_')) {
      const dealId = parseInt(data.replace('CONFIRM_SELLER_RECEIPT_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(dealId)) return;

      try {
        const deal = await prisma.deal.findUnique({
          where: { id: dealId },
          include: {
            proposal: { include: { creator: true } },
            acceptor: true
          }
        });

        if (!deal || deal.status !== 'SELLER_PAID_PENDING_APPROVAL') {
          await ctx.reply(`❌ معامله در وضعیت معتبری نیست یا قبلاً بررسی شده است. (وضعیت فعلی: ${deal?.status})`);
          return;
        }

        const moved = await transitionDeal(dealId, { type: 'ADMIN_CONFIRM_SELLER_RECEIPT' }, from.id.toString());
        if (!moved.ok) {
          await ctx.reply(`⚠️ این معامله هم‌زمان تغییر کرد یا دیگر در این مرحله نیست (${moved.current ?? moved.reason}).`);
          return;
        }
        await refreshDealCards(ctx.telegram, dealId);

        const freshProp = await prisma.proposal.findUnique({
          where: { id: deal.proposalId }
        });

        if (freshProp && freshProp.amount <= 0 && freshProp.status !== 'COMPLETED') {
          await prisma.proposal.update({
            where: { id: deal.proposalId },
            data: { status: 'COMPLETED' }
          });
        }

        await updateGroupProposalMessage(ctx.telegram, deal.proposalId);

        const buyerKb = await getMainKeyboard(deal.proposal.creator.telegramId);
        const sellerKb = await getMainKeyboard(deal.acceptor.telegramId);

        await ctx.telegram.sendMessage(
          deal.proposal.creator.telegramId,
          `🤝 <b>معامله #${dealId} با موفقیت به پایان رسید.</b>\nبا تشکر از اعتماد شما به DanmarkFinance.`,
          { ...buyerKb }
        );

        await ctx.telegram.sendMessage(
          deal.acceptor.telegramId,
          `🤝 <b>معامله #${dealId} با موفقیت به پایان رسید.</b>\nبا تشکر از اعتماد شما به DanmarkFinance.`,
          { ...sellerKb }
        );

        const hasPhoto = ctx.callbackQuery?.message && 'photo' in ctx.callbackQuery.message;
        const doneMsg = `🤝 معامله #${dealId} با موفقیت نهایی و بسته شد.`;
        if (hasPhoto) {
          await ctx.editMessageCaption(doneMsg).catch(() => {});
        } else {
          await ctx.editMessageText(doneMsg).catch(() => {});
        }

        if (freshProp && freshProp.status === 'COMPLETED' && freshProp.groupMessageId) {
          await ctx.telegram.sendMessage(
            config.ADMIN_CHAT_ID,
            `📋 <b>آگهی شماره #${freshProp.code ?? freshProp.id} به طور کامل معامله شد.</b>\n` +
              `آیا مایل به حذف پیام این آگهی از گروه هستید؟`,
            {
              ...Markup.inlineKeyboard([
                [
                  Markup.button.callback('🗑 بله، پیام آگهی را از گروه پاک کن', `DELETE_COMPLETED_AD_MSG_${freshProp.id}`),
                  Markup.button.callback('❌ خیر، پیام در گروه باقی بماند', `KEEP_COMPLETED_AD_MSG_${freshProp.id}`)
                ]
              ])
            }
          );
        }
      } catch (err) {
        console.error(err);
        await ctx.reply('❌ خطا در تایید فیش فروشنده.');
      }
      return;
    }

    if (data.startsWith('REJECT_SELLER_RECEIPT_')) {
      const dealId = parseInt(data.replace('REJECT_SELLER_RECEIPT_', ''), 10);
      await ctx.answerCbQuery();
      if (isNaN(dealId)) return;

      try {
        const deal = await prisma.deal.findUnique({
          where: { id: dealId },
          include: {
            proposal: { include: { creator: true } },
            acceptor: true
          }
        });

        if (!deal || deal.status !== 'SELLER_PAID_PENDING_APPROVAL') {
          await ctx.reply(`❌ معامله در وضعیت معتبری نیست یا قبلاً بررسی شده است. (وضعیت فعلی: ${deal?.status})`);
          return;
        }

        const moved = await transitionDeal(dealId, { type: 'ADMIN_REJECT_SELLER_RECEIPT' }, from.id.toString());
        if (!moved.ok) {
          await ctx.reply(`⚠️ این معامله هم‌زمان تغییر کرد یا دیگر در این مرحله نیست (${moved.current ?? moved.reason}).`);
          return;
        }
        await refreshDealCards(ctx.telegram, dealId);

        const isProposalBuy = deal.proposal.type === 'BUY';
        const seller = isProposalBuy ? deal.acceptor : deal.proposal.creator;

        const sellerKb = await getMainKeyboard(seller.telegramId);
        await ctx.telegram.sendMessage(
          seller.telegramId,
          `❌ <b>فیش انتقال کرون شما توسط مدیریت رد شد.</b>\n\n` +
            `لطفاً مجدداً بررسی نموده و فیش معتبر را از طریق دکمه <b>«📤 ارسال فیش واریزی»</b> ارسال نمایید.`,
          {
            parse_mode: 'HTML',
            ...sellerKb
          }
        );

        const hasPhoto = ctx.callbackQuery?.message && 'photo' in ctx.callbackQuery.message;
        const doneMsg = `❌ فیش انتقال فروشنده برای معامله #${dealId} رد شد.`;
        if (hasPhoto) {
          await ctx.editMessageCaption(doneMsg).catch(() => {});
        } else {
          await ctx.editMessageText(doneMsg).catch(() => {});
        }
      } catch (err) {
        console.error(err);
        await ctx.reply('❌ خطا در رد فیش فروشنده.');
      }
      return;
    }

    return next();
  });
}
