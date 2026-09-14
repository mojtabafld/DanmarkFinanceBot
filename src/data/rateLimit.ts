import { prisma } from '../database/db';

/**
 * A token bucket per user per action, held in the database.
 *
 * In-process counters would reset on every redeploy and would not be shared between
 * instances, which makes them close to useless as flood control for a bot that
 * restarts on each release.
 */

export interface Bucket {
  /** Tokens the bucket holds when full; also the largest burst allowed. */
  capacity: number;
  /** Tokens added per minute. */
  refillPerMinute: number;
}

/** Named limits, so the numbers live in one place rather than at each call site. */
export const LIMITS = {
  /** Creating ads: bursty by nature, but not a flood. */
  createProposal: { capacity: 5, refillPerMinute: 0.5 },
  /** Counter-offers: the cheapest way to spam another trader. */
  counterOffer: { capacity: 10, refillPerMinute: 1 },
  /** Re-submitting identity documents. */
  verification: { capacity: 3, refillPerMinute: 0.2 },
  /** The live rate command, which makes an outbound request. */
  liveRates: { capacity: 6, refillPerMinute: 2 },
  /** Everything else, as a blanket guard on message handling. */
  general: { capacity: 30, refillPerMinute: 15 }
} satisfies Record<string, Bucket>;

export type LimitName = keyof typeof LIMITS;

export interface LimitResult {
  allowed: boolean;
  /** Seconds until one token is available again. Zero when allowed. */
  retryAfterSeconds: number;
}

/**
 * Spends one token, returning whether the caller may proceed.
 *
 * Fails open: if the bucket cannot be read or written, the action is allowed. A
 * database hiccup should slow the bot down, not lock every user out of their money.
 */
export async function consume(
  name: LimitName,
  telegramId: string | number,
  now: Date = new Date()
): Promise<LimitResult> {
  const bucket = LIMITS[name];
  const key = `${name}:${telegramId}`;

  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.rateBucket.findUnique({ where: { key } });

      const tokens = row
        ? refill(row.tokens, row.updatedAt, now, bucket)
        : bucket.capacity;

      if (tokens < 1) {
        const deficit = 1 - tokens;
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil((deficit / bucket.refillPerMinute) * 60)
        };
      }

      const remaining = tokens - 1;
      await tx.rateBucket.upsert({
        where: { key },
        update: { tokens: remaining, updatedAt: now },
        create: { key, tokens: remaining, updatedAt: now }
      });

      return { allowed: true, retryAfterSeconds: 0 };
    });
  } catch (err) {
    console.error(`Rate limit check failed for ${key}, allowing through:`, err);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** Tokens after the time that has passed since the bucket was last touched. */
export function refill(tokens: number, since: Date, now: Date, bucket: Bucket): number {
  const minutes = Math.max(0, (now.getTime() - since.getTime()) / 60_000);
  return Math.min(bucket.capacity, tokens + minutes * bucket.refillPerMinute);
}

/** Drops buckets nobody has touched for a day; they are all back at capacity anyway. */
export async function pruneIdleBuckets(olderThanHours = 24): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
  const { count } = await prisma.rateBucket.deleteMany({ where: { updatedAt: { lt: cutoff } } });
  return count;
}
