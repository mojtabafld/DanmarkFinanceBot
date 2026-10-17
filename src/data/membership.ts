import type { Telegram } from 'telegraf';
import { config } from '../config';
import { mainKeyboard } from '../bot/utils/keyboards';

/**
 * Welcome an approved user: a one-time, 24-hour invite to the trading group and the
 * main menu. Used by the admin's approve button and by an automatic face-scan approval.
 */
export async function sendGroupInvite(
  telegram: Telegram,
  user: { telegramId: string; fullName: string | null },
  headline: string
): Promise<void> {
  const inviteLink = await telegram.createChatInviteLink(config.GROUP_CHAT_ID, {
    member_limit: 1,
    name: `Invite for ${user.fullName}`.slice(0, 32),
    expire_date: Math.floor(Date.now() / 1000) + 86400
  });

  const userMsg =
    `🎉 <b>${headline}</b>\n\n` +
    `لینک عضویت یک‌بار مصرف شما در گروه معاملاتی دانمارک (دارای اعتبار ۲۴ ساعته):\n` +
    `🔗 ${inviteLink.invite_link}\n\n` +
    `پس از عضویت در گروه، می‌توانید پیشنهادهای خود را از دکمه‌های زیر ثبت و مدیریت کنید.`;

  await telegram.sendMessage(user.telegramId, userMsg, {
    parse_mode: 'HTML',
    ...mainKeyboard
  });
}
