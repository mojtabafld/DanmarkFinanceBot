import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

/**
 * Link to the face-scan KYC app (github.com/mojtabafld/FaceRecognition).
 *
 * The bot gives each user a short-lived link signed with a secret shared with the
 * KYC app, which logs them in there as their Telegram account. The KYC app posts
 * every final result back to /kyc/result, signed with the same secret.
 */

/** How long a verification link stays valid. */
export const LINK_TTL_SECONDS = 30 * 60;

export function kycEnabled(): boolean {
  return Boolean(config.KYC_BASE_URL && config.KYC_LINK_SECRET);
}

function sign(message: string | Buffer): string {
  return createHmac('sha256', config.KYC_LINK_SECRET).update(message).digest('hex');
}

/** A link that logs `telegramId` into the KYC app for the next LINK_TTL_SECONDS. */
export function kycLink(telegramId: string, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + LINK_TTL_SECONDS;
  const payload = `${telegramId}.${exp}`;
  return `${config.KYC_BASE_URL}/tg/${payload}.${sign(payload)}`;
}

/** Whether `signature` is the KYC app's signature of exactly this request body. */
export function validResultSignature(body: Buffer, signature: string | undefined): boolean {
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(sign(body), 'hex'), Buffer.from(signature, 'hex'));
}

export type KycStatus = 'APPROVED' | 'REJECTED' | 'MANUAL_REVIEW';

export interface KycDocument {
  document_type: string | null;
  issuing_country: string | null;
  surname: string | null;
  given_names: string | null;
  document_number: string | null;
  nationality: string | null;
  birth_date: string | null;
  sex: string | null;
  expiry_date: string | null;
  checks_ok: boolean;
}

export interface KycResult {
  verification_id: string;
  telegram_id: string;
  status: KycStatus;
  reasons: string[];
  automated: boolean;
  document: KycDocument | null;
  face_match: number | null;
  live_probability: number | null;
}

const STATUSES: readonly string[] = ['APPROVED', 'REJECTED', 'MANUAL_REVIEW'];

/** The result in a request body, or null when it is not one the bot understands. */
export function parseKycResult(body: Buffer): KycResult | null {
  let r: any;
  try {
    r = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (
    !r ||
    typeof r.verification_id !== 'string' ||
    typeof r.telegram_id !== 'string' ||
    !/^\d+$/.test(r.telegram_id) ||
    !STATUSES.includes(r.status)
  ) {
    return null;
  }
  return {
    verification_id: r.verification_id,
    telegram_id: r.telegram_id,
    status: r.status,
    reasons: Array.isArray(r.reasons) ? r.reasons.filter((x: unknown) => typeof x === 'string') : [],
    automated: r.automated !== false,
    document: r.document && typeof r.document === 'object' ? r.document : null,
    face_match: typeof r.face_match === 'number' ? r.face_match : null,
    live_probability: typeof r.live_probability === 'number' ? r.live_probability : null
  };
}
