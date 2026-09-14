import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../database/db';

/** Anything that can run a query: the client, or a transaction handle. */
type Db = PrismaClient | Prisma.TransactionClient;

/** Actor for changes made by a scheduled job rather than a person. */
export const SYSTEM_ACTOR = 'system';

export interface AuditInput {
  /** Telegram id of whoever acted, or SYSTEM_ACTOR. */
  actor: string;
  /** Dotted action name, e.g. "deal.approve". */
  action: string;
  subjectType: 'Deal' | 'Proposal' | 'User' | 'CounterOffer' | 'Admin';
  subjectId: string | number;
  before?: unknown;
  after?: unknown;
  note?: string;
}

/**
 * Records an action that moved money or changed someone's standing.
 *
 * Pass the transaction handle when the change is transactional, so the record and
 * the change commit or fail together. An audit row that can survive a rolled-back
 * change, or vice versa, is worse than no audit row: it is a confident lie.
 */
export async function recordAudit(db: Db, input: AuditInput): Promise<void> {
  await db.auditEvent.create({
    data: {
      actor: input.actor,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: String(input.subjectId),
      before: toJson(input.before),
      after: toJson(input.after),
      note: input.note ?? null
    }
  });
}

/** Audit trail for one subject, newest first. */
export function auditTrail(subjectType: AuditInput['subjectType'], subjectId: string | number, take = 50) {
  return prisma.auditEvent.findMany({
    where: { subjectType, subjectId: String(subjectId) },
    orderBy: { createdAt: 'desc' },
    take
  });
}

/**
 * Narrows a record to the fields worth keeping. Audit rows are read during disputes,
 * months later, so they should carry the values that were argued about and not a
 * whole row including a document reference.
 */
export function snapshot<T extends object, K extends keyof T>(row: T | null | undefined, keys: K[]): Pick<T, K> | null {
  if (!row) return null;
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = row[k];
  return out;
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
