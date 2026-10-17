import { Markup, type Telegram } from 'telegraf';
import { config } from '../config';
import { prisma } from '../database/db';
import { sendGroupInvite } from '../data/membership';
import { escapeHtml, mentionUser } from '../bot/utils/html';
import { pendingVerificationKeyboard } from '../bot/utils/keyboards';
import { kycLink, type KycResult } from './link';

/** Buttons that show an admin the verification's documents and video, in the bot or on the web. */
function mediaButtons(userId: number, panelUrl: string) {
  return [
    [Markup.button.callback('🔍 مشاهدهٔ مدارک و ویدیو', `ADMIN_USER_KYC_${userId}`)],
    [Markup.button.url('🌐 پنل وب احراز هویت', panelUrl)]
  ];
}

/** Why a scan was refused, in the user's words. Unknown codes are shown as-is. */
const REASONS_FA: Record<string, string> = {
  circle_incomplete: 'حرکت دایره‌ای سر کامل نشد.',
  wrong_direction: 'سر در جهت اشتباه چرخانده شد.',
  head_movement_too_small: 'حرکت سر خیلی کم بود.',
  too_few_face_frames: 'چهره در ویدیو به‌خوبی دیده نشد.',
  face_not_visible_in_video: 'چهره در ویدیو به‌خوبی دیده نشد.',
  multiple_people_in_video: 'بیش از یک نفر در تصویر بود.',
  presentation_attack_suspected: 'ویدیو از یک فرد زنده به نظر نمی‌رسید.',
  face_changed_during_video: 'چهره در طول ویدیو تغییر کرد.',
  face_does_not_match_document: 'چهره با عکس روی مدرک مطابقت نداشت.',
  no_face_on_document: 'چهره‌ای روی مدرک پیدا نشد.',
  processing_error: 'خطای پردازش رخ داد.'
};

const pct = (x: number | null) => (x == null ? '–' : `${Math.round(x * 100)}%`);

function documentName(r: KycResult): string | null {
  const d = r.document;
  const name = [d?.given_names, d?.surname].filter(Boolean).join(' ').trim();
  return name || null;
}

/** The scan results an admin sees, as HTML. */
export function adminSummary(r: KycResult): string {
  const d = r.document;
  const lines = [
    `🪪 <b>مدرک:</b> ${
      d
        ? `${escapeHtml(d.document_type)} ${escapeHtml(d.issuing_country)} · ${escapeHtml(d.document_number)}`
        : 'خوانده نشد'
    }`
  ];
  if (d) {
    lines.push(
      `📝 <b>نام روی مدرک:</b> ${escapeHtml(documentName(r))}`,
      `🎂 <b>تولد:</b> ${escapeHtml(d.birth_date)} · <b>ملیت:</b> ${escapeHtml(d.nationality)} · <b>جنسیت:</b> ${escapeHtml(d.sex)}`,
      `📅 <b>انقضا:</b> ${escapeHtml(d.expiry_date)} · <b>ارقام کنترلی:</b> ${d.checks_ok ? '✅' : '❌'}`
    );
  }
  lines.push(
    `🙂 <b>تطبیق چهره با مدرک:</b> ${pct(r.face_match)}`,
    `🫀 <b>زنده بودن:</b> ${pct(r.live_probability)}`
  );
  if (r.reasons.length) lines.push(`⚠️ <b>دلایل:</b> ${escapeHtml(r.reasons.join(', '))}`);
  return lines.join('\n');
}

/** What the scan read from the user's document, shown to them after approval. */
export function userSummary(r: KycResult): string {
  const d = r.document;
  if (!d) return '';
  const rows: [string, string | null][] = [
    ['👤 نام', documentName(r)],
    ['🪪 مدرک', [d.document_type, d.issuing_country, d.document_number].filter(Boolean).join(' · ') || null],
    ['🌍 ملیت', d.nationality],
    ['🎂 تاریخ تولد', d.birth_date],
    ['📅 تاریخ انقضا', d.expiry_date]
  ];
  return rows
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: <b>${escapeHtml(v)}</b>`)
    .join('\n');
}

/**
 * Apply a face-scan result to the user it belongs to. Safe to call twice with the
 * same result: the KYC app retries until the bot answers, so a result can arrive again.
 */
export async function applyKycResult(telegram: Telegram, r: KycResult): Promise<void> {
  const user = await prisma.user.findUnique({ where: { telegramId: r.telegram_id } });
  if (!user) {
    console.warn(`KYC result ${r.verification_id} for unknown Telegram user; ignored.`);
    return;
  }
  const key = `${r.verification_id}:${r.status}`;
  if (user.kycResult === key) return;
  // A scan never overrides a decision already made about the account.
  if (['APPROVED', 'DEACTIVATED', 'DELETED'].includes(user.verificationStatus)) {
    console.log(`KYC result ${r.verification_id} (${r.status}) not applied: account is ${user.verificationStatus}.`);
    await prisma.user.update({ where: { id: user.id }, data: { kycResult: key } });
    if (user.verificationStatus === 'DELETED') {
      // An old link used after closing the account: their details are gone, so
      // they must sign up again before a scan can count.
      await telegram.sendMessage(
        user.telegramId,
        'ℹ️ حساب شما قبلاً حذف شده است و این احراز هویت روی آن اعمال نشد.\n' +
          'برای ثبت‌نام دوباره /start را بزنید و مراحل را از ابتدا انجام دهید.'
      );
    }
    return;
  }

  const fullName = documentName(r) ?? user.fullName;
  // The document photos and video stay in the KYC app; admins open them from here.
  const panelUrl = `${config.KYC_BASE_URL}/admin#${encodeURIComponent(r.verification_id)}`;
  const mention = mentionUser({ username: user.username, firstName: user.firstName, telegramId: user.telegramId });
  const header =
    `👤 <b>کاربر:</b> ${mention}\n` +
    `📝 <b>نام وارد‌شده:</b> ${escapeHtml(user.fullName)}\n` +
    `🌍 <b>کشور اقامت:</b> ${escapeHtml(user.country)}\n` +
    `📱 <b>تلفن:</b> ${escapeHtml(user.phoneNumber)}\n` +
    `🆔 <code>${user.telegramId}</code>\n\n`;

  if (r.status === 'APPROVED') {
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { verificationStatus: 'APPROVED', fullName, rejectReason: null, kycResult: key }
    });
    // The admin hears first, so a failed invite cannot hide a new member from them.
    await telegram.sendMessage(
      config.ADMIN_CHAT_ID,
      `🆕 <b>ثبت‌نام کاربر جدید</b>\n✅ احراز هویت با اسکن چهره و مدرک تایید شد\n\n${header}${adminSummary(r)}`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard(mediaButtons(user.id, panelUrl)) }
    );
    const info = userSummary(r);
    if (info) {
      await telegram.sendMessage(
        user.telegramId,
        `✅ <b>اطلاعات تاییدشدهٔ شما</b>\n\n${info}\n\nاگر موردی اشتباه است، به پشتیبانی اطلاع دهید.`,
        { parse_mode: 'HTML' }
      );
    }
    try {
      await sendGroupInvite(telegram, updated, 'احراز هویت شما با موفقیت انجام و تایید شد!');
    } catch (err) {
      console.error('Group invite after KYC approval failed:', err);
      await telegram.sendMessage(
        config.ADMIN_CHAT_ID,
        `⚠️ ساخت لینک عضویت گروه برای ${mention} ناموفق بود. لطفاً دستی دعوت کنید.`,
        { parse_mode: 'HTML' }
      );
    }
    return;
  }

  if (r.status === 'MANUAL_REVIEW') {
    await prisma.user.update({
      where: { id: user.id },
      data: { verificationStatus: 'PENDING', kycResult: key }
    });
    const sent = await telegram.sendMessage(
      config.ADMIN_CHAT_ID,
      `🔔 <b>احراز هویت نیازمند بررسی دستی</b>\n\n${header}${adminSummary(r)}\n\n` +
        `تصاویر در پنل بررسی KYC قابل مشاهده است.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ تایید احراز هویت', `APPROVE_USER_${user.id}`),
            Markup.button.callback('❌ رد احراز هویت', `REJECT_USER_${user.id}`)
          ],
          ...mediaButtons(user.id, panelUrl)
        ])
      }
    );
    await prisma.user.update({ where: { id: user.id }, data: { adminVerifyMsgId: sent.message_id } });
    await telegram.sendMessage(
      user.telegramId,
      '⏳ اسکن چهره و مدرک شما انجام شد و برای بررسی نهایی به مدیریت ارسال گردید.\n' +
        'نتیجه از همین‌جا به شما اطلاع داده می‌شود.',
      pendingVerificationKeyboard
    );
    return;
  }

  // REJECTED. An automatic rejection is a failed attempt the user can simply
  // repeat; a reviewer's rejection in the KYC panel is final like the admin's.
  const reasons = r.reasons.map(c => `• ${escapeHtml(REASONS_FA[c] ?? c)}`).join('\n');
  if (!r.automated) {
    await prisma.user.update({
      where: { id: user.id },
      data: { verificationStatus: 'REJECTED', rejectReason: r.reasons.join(', ') || 'KYC review', kycResult: key }
    });
    await telegram.sendMessage(user.telegramId, `❌ <b>احراز هویت شما رد شد.</b>\n\n${reasons}`, { parse_mode: 'HTML' });
    return;
  }
  await prisma.user.update({ where: { id: user.id }, data: { kycResult: key } });
  const link = kycLink(user.telegramId);
  await telegram.sendMessage(
    user.telegramId,
    `⚠️ <b>احراز هویت این بار انجام نشد.</b>\n\n${reasons}\n\nلطفاً دوباره تلاش کنید:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.webApp('📸 تلاش دوباره', link)],
        [Markup.button.url('🌐 باز کردن در مرورگر', link)]
      ])
    }
  );
}
