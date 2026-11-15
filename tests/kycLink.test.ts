import { createHmac } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const SECRET = 'test-kyc-secret';
process.env.KYC_BASE_URL = 'https://kyc.example.com/';
process.env.KYC_LINK_SECRET = SECRET;

let link: typeof import('../src/kyc/link');
beforeAll(async () => {
  link = await import('../src/kyc/link');
});

describe('face-scan KYC link', () => {
  it('signs "<id>.<expiry>" with the shared secret, as the KYC app checks it', () => {
    const now = Date.UTC(2026, 9, 17);
    const url = link.kycLink('123456', now);
    const m = url.match(/^https:\/\/kyc\.example\.com\/tg\/(\d+)\.(\d+)\.([0-9a-f]{64})$/);
    expect(m).not.toBeNull();
    const [, tid, exp, sig] = m!;
    expect(tid).toBe('123456');
    expect(Number(exp)).toBe(now / 1000 + link.LINK_TTL_SECONDS);
    expect(sig).toBe(createHmac('sha256', SECRET).update(`${tid}.${exp}`).digest('hex'));
  });

  it('accepts only results signed with the shared secret', () => {
    const body = Buffer.from('{"status":"APPROVED"}');
    const good = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(link.validResultSignature(body, good)).toBe(true);
    expect(link.validResultSignature(Buffer.from('{"status":"REJECTED"}'), good)).toBe(false);
    expect(link.validResultSignature(body, createHmac('sha256', 'other').update(body).digest('hex'))).toBe(false);
    expect(link.validResultSignature(body, undefined)).toBe(false);
    expect(link.validResultSignature(body, 'not-hex')).toBe(false);
  });

  it('parses a result and refuses malformed ones', () => {
    const ok = link.parseKycResult(
      Buffer.from(
        JSON.stringify({
          verification_id: 'v1', telegram_id: '42', status: 'MANUAL_REVIEW', reasons: ['mrz_check_digit_failed'],
          automated: true, document: null, face_match: 0.6, live_probability: 0.9
        })
      )
    );
    expect(ok?.status).toBe('MANUAL_REVIEW');
    expect(ok?.reasons).toEqual(['mrz_check_digit_failed']);
    expect(link.parseKycResult(Buffer.from('nope'))).toBeNull();
    expect(link.parseKycResult(Buffer.from('{"verification_id":"v","telegram_id":"42","status":"HACKED"}'))).toBeNull();
    expect(link.parseKycResult(Buffer.from('{"verification_id":"v","telegram_id":"x1","status":"APPROVED"}'))).toBeNull();
  });
});
