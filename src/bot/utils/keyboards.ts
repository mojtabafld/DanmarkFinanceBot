import { Markup } from 'telegraf';

export const mainKeyboard = Markup.keyboard([
  ['ثبت / ویرایش آگهی', '⚙️ تنظیمات کاربری'],
  ['📊 لیست مبادلات فعال', '💵 نرخ لحظه‌ای ارز'],
  ['📜 شرایط تبادل ارز']
]).resize();

export const verifyStartKeyboard = Markup.keyboard([
  ['🔐 شروع احراز هویت']
]).resize();

export const pendingVerificationKeyboard = Markup.keyboard([
  ['❌ لغو ارسال اطلاعات']
]).resize();

