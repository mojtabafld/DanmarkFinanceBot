import { createHmac } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const SECRET = 'test-kyc-secret';
process.env.KYC_BASE_URL = 'https://kyc.example.com/';
process.env.KYC_LINK_SECRET = SECRET;

let media: typeof import('../src/kyc/media');
beforeAll(async () => {
  media = await import('../src/kyc/media');
});

function fakeTelegram() {
  const calls: { method: string; args: any[] }[] = [];
  const record = (method: string) => async (...args: any[]) => {
    calls.push({ method, args });
    return {};
  };
  const api = {
    sendPhoto: record('sendPhoto'),
    sendMediaGroup: record('sendMediaGroup'),
    sendVideo: record('sendVideo'),
    sendDocument: record('sendDocument')
  } as any;
  return { api, calls };
}

const jpeg = { data: Buffer.from('jpeg'), contentType: 'image/jpeg' };

describe('KYC media for admins', () => {
  it('signs "media.<id>.<kind>.<expiry>" with the shared secret, as the KYC app checks it', () => {
    const now = Date.UTC(2026, 9, 17);
    const h = media.mediaHeaders('v1', 'doc', now);
    expect(Number(h['X-KYC-Expires'])).toBe(now / 1000 + media.MEDIA_SIGNATURE_TTL_SECONDS);
    expect(h['X-KYC-Signature']).toBe(
      createHmac('sha256', SECRET).update(`media.v1.doc.${h['X-KYC-Expires']}`).digest('hex')
    );
  });

  it('reads the verification id out of the stored result key', () => {
    expect(media.verificationIdOf('abc-123:APPROVED')).toBe('abc-123');
    expect(media.verificationIdOf(null)).toBeNull();
    expect(media.verificationIdOf('')).toBeNull();
  });

  it('sends the photos as one album and an iPhone video inline', async () => {
    const tg = fakeTelegram();
    const files: Record<string, typeof jpeg> = {
      doc: jpeg,
      doc_back: jpeg,
      best_frame: jpeg,
      video: { data: Buffer.from('mp4'), contentType: 'video/mp4' }
    };
    const sent = await media.sendKycMedia(tg.api, 1, 'v1', async (_id, kind) => files[kind] ?? null);
    expect(sent).toBe(4);
    expect(tg.calls.map(c => c.method)).toEqual(['sendMediaGroup', 'sendVideo']);
    expect(tg.calls[0].args[1]).toHaveLength(3);
  });

  it('sends a lone photo and a webm video as a file', async () => {
    const tg = fakeTelegram();
    const files: Record<string, typeof jpeg> = { doc: jpeg, video: { data: Buffer.from('w'), contentType: 'video/webm' } };
    expect(await media.sendKycMedia(tg.api, 1, 'v1', async (_id, kind) => files[kind] ?? null)).toBe(2);
    expect(tg.calls.map(c => c.method)).toEqual(['sendPhoto', 'sendDocument']);
  });

  it('sends nothing once the files are deleted', async () => {
    const tg = fakeTelegram();
    expect(await media.sendKycMedia(tg.api, 1, 'v1', async () => null)).toBe(0);
    expect(tg.calls).toEqual([]);
  });
});
