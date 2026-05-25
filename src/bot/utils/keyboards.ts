import { Markup } from 'telegraf';

export const mainKeyboard = Markup.keyboard([
  ['📝 ثبت پیشنهاد جدید'],
  ['📋 پیشنهادهای فعال من', '❓ راهنما']
]).resize();

export const verifyStartKeyboard = Markup.keyboard([
  ['🔐 شروع احراز هویت']
]).resize();
