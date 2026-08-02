import { describe, it, expect } from 'vitest';
import { formatToShamsi, getTimezoneByCountry } from '../src/bot/utils/groupMessage';

describe('groupMessage utils', () => {
  it('should format a valid Date into Persian Shamsi date string', () => {
    const testDate = new Date('2024-03-20T12:00:00Z');
    const formatted = formatToShamsi(testDate, 'Europe/Copenhagen');
    expect(formatted).toBeDefined();
    expect(typeof formatted).toBe('string');
    expect(formatted.length).toBeGreaterThan(0);
  });

  it('should map countries to their respective local timezones', () => {
    expect(getTimezoneByCountry('ایران')).toBe('Asia/Tehran');
    expect(getTimezoneByCountry('Iran')).toBe('Asia/Tehran');
    expect(getTimezoneByCountry('دانمارک')).toBe('Europe/Copenhagen');
    expect(getTimezoneByCountry('Denmark')).toBe('Europe/Copenhagen');
    expect(getTimezoneByCountry('آلمان')).toBe('Europe/Berlin');
    expect(getTimezoneByCountry(null)).toBe('Europe/Copenhagen');
  });
});
