import { describe, it, expect } from 'vitest';
import { escapeHtml, mentionUser } from '../src/bot/utils/html';

describe('escapeHtml', () => {
  it('escapes every character Telegram treats as HTML markup', () => {
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;');
    expect(escapeHtml("O'Brien")).toBe('O&#39;Brien');
  });

  it('escapes ampersands before the entities it introduces', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('neutralises a payment note that would otherwise break out of a code tag', () => {
    // The real failure: unescaped user text made Telegram reject the whole
    // message with a 400, so the admin never received the payment receipt.
    const hostile = '</code><b>IBAN DK99 & co</b>';
    const escaped = escapeHtml(hostile);
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(`<code>${escaped}</code>`.match(/<code>/g)).toHaveLength(1);
  });

  it('renders null and undefined as an empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('leaves ordinary Persian and Danish text untouched', () => {
    expect(escapeHtml('علی رضایی')).toBe('علی رضایی');
    expect(escapeHtml('Nørrebrogade 42')).toBe('Nørrebrogade 42');
  });
});

describe('mentionUser', () => {
  it('prefers an escaped @username', () => {
    expect(mentionUser({ username: 'ali_x', firstName: 'Ali', telegramId: '1' }))
      .toBe('@ali_x');
  });

  it('falls back to a tg:// link with an escaped display name', () => {
    expect(mentionUser({ username: null, firstName: '<script>', telegramId: '42' }))
      .toBe('<a href="tg://user?id=42">&lt;script&gt;</a>');
  });

  it('uses a placeholder when there is no name at all', () => {
    expect(mentionUser({ username: null, firstName: null, telegramId: '7' }))
      .toBe('<a href="tg://user?id=7">کاربر</a>');
  });
});
