import { Markup } from 'telegraf';

export const mainKeyboard = Markup.keyboard([
  ['ثبت | ویرایش درخواست', '⚙️ تنظیمات کاربری'],
  ['📊 لیست مبادلات فعال', '💵 نرخ لحظه‌ای ارز'],
  ['📜 شرایط تبادل ارز']
]).resize();

export const verifyStartKeyboard = Markup.keyboard([
  ['🔐 شروع احراز هویت']
]).resize();
