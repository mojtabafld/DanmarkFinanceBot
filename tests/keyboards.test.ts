import { describe, it, expect } from 'vitest';
import { mainKeyboard, verifyStartKeyboard, pendingVerificationKeyboard } from '../src/bot/utils/keyboards';

describe('Keyboards utility', () => {
  it('should define mainKeyboard with expected layout buttons', () => {
    expect(mainKeyboard).toBeDefined();
    expect(mainKeyboard.reply_markup).toBeDefined();
    expect(mainKeyboard.reply_markup.keyboard).toBeDefined();
    expect(mainKeyboard.reply_markup.keyboard.length).toBeGreaterThan(0);
  });

  it('should define verifyStartKeyboard and pendingVerificationKeyboard', () => {
    const raw1 = verifyStartKeyboard.reply_markup.keyboard[0][0];
    const raw2 = pendingVerificationKeyboard.reply_markup.keyboard[0][0];
    const text1 = typeof raw1 === 'string' ? raw1 : (raw1 as any).text;
    const text2 = typeof raw2 === 'string' ? raw2 : (raw2 as any).text;
    expect(text1).toContain('شروع احراز هویت');
    expect(text2).toContain('لغو ارسال اطلاعات');
  });
});
