import { Markup } from 'telegraf';
import { prisma } from '../../database/db';

export const mainKeyboard = Markup.keyboard([
  ['💵 نرخ لحظه‌ای ارز', '⚙️ تنظیمات کاربری'],
  ['🤝 مدیریت پیشنهادات', '📋 مدیریت آگهی‌ها'],
  ['📊 لیست مبادلات فعال', '📜 شرایط تبادل ارز']
]).resize();

export async function getMainKeyboard(telegramId: string) {
  try {
    const dbUser = await prisma.user.findUnique({
      where: { telegramId }
    });
    if (!dbUser) return mainKeyboard;

    const activeDeal = await prisma.deal.findFirst({
      where: {
        OR: [
          {
            status: 'WAITING_BUYER_PAYMENT',
            OR: [
              { acceptorId: dbUser.id, proposal: { type: 'SELL' } },
              { proposal: { creatorId: dbUser.id, type: 'BUY' } }
            ]
          },
          {
            status: 'WAITING_SELLER_PAYMENT',
            OR: [
              { acceptorId: dbUser.id, proposal: { type: 'BUY' } },
              { proposal: { creatorId: dbUser.id, type: 'SELL' } }
            ]
          }
        ]
      }
    });

    if (activeDeal) {
      return Markup.keyboard([
        ['💵 نرخ لحظه‌ای ارز', '⚙️ تنظیمات کاربری'],
        ['🤝 مدیریت پیشنهادات', '📋 مدیریت آگهی‌ها'],
        ['📊 لیست مبادلات فعال', '📜 شرایط تبادل ارز'],
        ['📤 ارسال فیش واریزی']
      ]).resize();
    }
  } catch (err) {
    console.error('Error in getMainKeyboard:', err);
  }

  return mainKeyboard;
}

export const verifyStartKeyboard = Markup.keyboard([
  ['🔐 شروع احراز هویت']
]).resize();

export const pendingVerificationKeyboard = Markup.keyboard([
  ['❌ لغو ارسال اطلاعات']
]).resize();

