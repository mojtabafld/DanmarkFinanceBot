import { Markup, type Telegram } from 'telegraf';
import { config } from '../config';
import { prisma } from '../database/db';
import { sendGroupInvite } from '../data/membership';
import { escapeHtml, mentionUser } from '../bot/utils/html';
import { pendingVerificationKeyboard } from '../bot/utils/keyboards';
import { kycLink, type KycResult } from './link';

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
      `🎂 <b>تولد:</b> ${escapeHtml(d.birth_date)} · <b>ملیت:</b> ${escapeHtml(d.nationality)}`,
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
    return;
  }

  const fullName = documentName(r) ?? user.fullName;
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
    await sendGroupInvite(telegram, updated, 'احراز هویت شما با موفقیت انجام و تایید شد!');
    await telegram.sendMessage(
      config.ADMIN_CHAT_ID,
      `✅ <b>احراز هویت با اسکن چهره تایید شد</b>\n\n${header}${adminSummary(r)}`,
      { parse_mode: 'HTML' }
    );
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
          [Markup.button.url('🔍 پنل بررسی KYC', `${config.KYC_BASE_URL}/admin`)]
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
