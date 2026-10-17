import { createHmac } from 'crypto';
import { Input, type Telegram } from 'telegraf';
import { config } from '../config';

/**
 * A verification's document photos and face video, fetched from the KYC app for
 * an admin to look at in the bot. Each request is signed with the shared secret
 * for that one file and expires within minutes.
 */

export const MEDIA_SIGNATURE_TTL_SECONDS = 120;

/** Photos sent as one album, in this order, then the video. */
const PHOTOS: readonly { kind: string; label: string }[] = [
  { kind: 'doc', label: 'روی مدرک' },
  { kind: 'doc_back', label: 'پشت مدرک' },
  { kind: 'best_frame', label: 'چهرهٔ اسکن‌شده' }
];

/** Where the bot reaches the KYC app: its internal address when set, else the public one. */
function kycUrl(): string {
  return config.KYC_INTERNAL_URL || config.KYC_BASE_URL;
}

export function mediaHeaders(verificationId: string, kind: string, nowMs = Date.now()): Record<string, string> {
  const exp = String(Math.floor(nowMs / 1000) + MEDIA_SIGNATURE_TTL_SECONDS);
  const signature = createHmac('sha256', config.KYC_LINK_SECRET)
    .update(`media.${verificationId}.${kind}.${exp}`)
    .digest('hex');
  return { 'X-KYC-Expires': exp, 'X-KYC-Signature': signature };
}

export interface KycFile {
  data: Buffer;
  contentType: string;
}

/** One file of a verification, or null when the KYC app has none (never stored, or already deleted). */
export async function fetchKycMedia(verificationId: string, kind: string): Promise<KycFile | null> {
  const url = `${kycUrl()}/api/bot/verifications/${encodeURIComponent(verificationId)}/media/${kind}`;
  const res = await fetch(url, { headers: mediaHeaders(verificationId, kind), signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KYC media ${kind} answered ${res.status}`);
  return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
}

/** The verification id in a user's `kycResult` ("<verification id>:<status>"). */
export function verificationIdOf(kycResult: string | null): string | null {
  const id = kycResult?.split(':')[0];
  return id ? id : null;
}

/**
 * Sends `chatId` the verification's photos as one album and its video. Returns
 * how many files were sent; 0 means the KYC app had nothing left to show.
 */
export async function sendKycMedia(
  telegram: Telegram,
  chatId: number,
  verificationId: string,
  fetchFile: typeof fetchKycMedia = fetchKycMedia
): Promise<number> {
  const photos: { label: string; file: KycFile }[] = [];
  for (const p of PHOTOS) {
    const file = await fetchFile(verificationId, p.kind);
    if (file) photos.push({ label: p.label, file });
  }
  if (photos.length === 1) {
    await telegram.sendPhoto(chatId, Input.fromBuffer(photos[0].file.data, 'photo.jpg'), { caption: photos[0].label });
  } else if (photos.length > 1) {
    await telegram.sendMediaGroup(
      chatId,
      photos.map((p, i) => ({
        type: 'photo' as const,
        media: Input.fromBuffer(p.file.data, `photo${i}.jpg`),
        caption: p.label
      }))
    );
  }

  const video = await fetchFile(verificationId, 'video');
  if (video) {
    // Telegram plays mp4 inline; anything else (Chrome records webm) goes as a file.
    if (video.contentType.includes('mp4')) {
      await telegram.sendVideo(chatId, Input.fromBuffer(video.data, 'face-scan.mp4'), { caption: 'ویدیوی اسکن چهره' });
    } else {
      await telegram.sendDocument(chatId, Input.fromBuffer(video.data, 'face-scan.webm'), { caption: 'ویدیوی اسکن چهره' });
    }
  }
  return photos.length + (video ? 1 : 0);
}
