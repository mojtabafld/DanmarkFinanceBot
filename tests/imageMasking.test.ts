import { describe, it, expect } from 'vitest';
import {
  CPR_REGEX,
  ZIP_CODE_REGEX,
  ADDRESS_SUFFIXES,
  isSensitiveToken
} from '../src/bot/utils/imageMasking';

// These assert against the detection logic the masker actually runs, rather than a
// copy of the regex pasted into the test, which could pass while the code was wrong.

describe('CPR detection', () => {
  it('matches a hyphenated Danish CPR number', () => {
    expect(CPR_REGEX.test('CPR: 251290-1234')).toBe(true);
    expect(isSensitiveToken('251290-1234')).toBe(true);
  });

  it('matches a continuous 10-digit CPR number', () => {
    expect(isSensitiveToken('2512901234')).toBe(true);
  });

  it('ignores numbers that are not CPR-shaped', () => {
    expect(CPR_REGEX.test('12345')).toBe(false);
    expect(CPR_REGEX.test('abc-def')).toBe(false);
  });
});

describe('address detection', () => {
  it('matches four-digit Danish postal codes', () => {
    expect(ZIP_CODE_REGEX.test('2200')).toBe(true);
    expect(isSensitiveToken('8000')).toBe(true);
  });

  it('rejects postal codes starting with zero', () => {
    expect(ZIP_CODE_REGEX.test('0999')).toBe(false);
  });

  it('matches Danish street-name suffixes case-insensitively', () => {
    for (const suffix of ADDRESS_SUFFIXES) {
      expect(isSensitiveToken(`Test${suffix}`)).toBe(true);
      expect(isSensitiveToken(`Test${suffix.toUpperCase()}`)).toBe(true);
    }
  });

  it('leaves ordinary document words alone', () => {
    expect(isSensitiveToken('Navn')).toBe(false);
    expect(isSensitiveToken('Kørekort')).toBe(false);
    expect(isSensitiveToken('')).toBe(false);
  });
});
