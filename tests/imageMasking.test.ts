import { describe, it, expect } from 'vitest';

describe('Image Masking CPR Pattern Validation', () => {
  const cprRegex = /\b\d{6}-\d{4}\b|\b\d{10}\b/;

  it('should correctly match Danish CPR formatted with hyphen', () => {
    expect(cprRegex.test('CPR: 251290-1234')).toBe(true);
    expect(cprRegex.test('251290-1234')).toBe(true);
  });

  it('should correctly match 10-digit continuous CPR number', () => {
    expect(cprRegex.test('2512901234')).toBe(true);
  });

  it('should not match invalid non-CPR numbers', () => {
    expect(cprRegex.test('12345')).toBe(false);
    expect(cprRegex.test('abc-def')).toBe(false);
  });
});
