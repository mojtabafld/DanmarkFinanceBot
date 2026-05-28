import { Markup } from 'telegraf';

export const mainKeyboard = Markup.keyboard([
  ['📋 مدیریت آگهی‌ها', '🤝 مدیریت پیشنهادات'],
  ['⚙️ تنظیمات کاربری', '💵 نرخ لحظه‌ای ارز'],
  ['📊 لیست مبادلات فعال', '📜 شرایط تبادل ارز']
]).resize();

export const verifyStartKeyboard = Markup.keyboard([
  ['🔐 شروع احراز هویت']
]).resize();

export const pendingVerificationKeyboard = Markup.keyboard([
  ['❌ لغو ارسال اطلاعات']
]).resize();
