import { describe, it, expect } from 'vitest';
import { formatToShamsi } from '../src/bot/utils/groupMessage';

describe('groupMessage utils', () => {
  it('should format a valid Date into Persian Shamsi date string', () => {
    const testDate = new Date('2024-03-20T12:00:00Z');
    const formatted = formatToShamsi(testDate);
    expect(formatted).toBeDefined();
    expect(typeof formatted).toBe('string');
    expect(formatted.length).toBeGreaterThan(0);
  });
});
