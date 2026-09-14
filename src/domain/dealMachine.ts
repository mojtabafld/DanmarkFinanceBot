import type { DealStatus } from '@prisma/client';

/**
 * The deal lifecycle, in one place.
 *
 * Before this module the status column was written from four different files, each
 * with its own hand-copied guard, which is how a renamed button could strand every
 * paid trade without anything noticing. Handlers no longer decide what a deal may do
 * next; they report an event and apply whatever comes back.
 *
 * Nothing here imports Telegram or Prisma, so the whole lifecycle is testable
 * without a network or a database.
 */

/** Something that happened, which may or may not move the deal. */
export type DealEvent =
  | { type: 'ADMIN_APPROVE' }
  | { type: 'ADMIN_REJECT' }
  | { type: 'BUYER_UPLOAD_RECEIPT' }
  | { type: 'SELLER_UPLOAD_RECEIPT' }
  | { type: 'ADMIN_CONFIRM_BUYER_RECEIPT' }
  | { type: 'ADMIN_REJECT_BUYER_RECEIPT' }
  | { type: 'ADMIN_CONFIRM_SELLER_RECEIPT' }
  | { type: 'ADMIN_REJECT_SELLER_RECEIPT' }
  | { type: 'DEADLINE_EXPIRED' };

export type DealEventType = DealEvent['type'];

/** Who the system is waiting on while a deal sits in a given state. */
export type Awaiting = 'admin' | 'buyer' | 'seller' | 'nobody';

export interface StateSpec {
  /** True when no further transition is possible. */
  terminal: boolean;
  /** Whose turn it is. Drives which side gets an action button on the deal card. */
  awaiting: Awaiting;
  /**
   * How long this state may last before the sweep escalates, in hours.
   * `null` means the state is terminal, or waiting on an admin who is already paged.
   */
  slaHours: number | null;
  /** True once the buyer's funds are committed, so cancelling needs a human. */
  fundsCommitted: boolean;
}

export const DEAL_STATES: Record<DealStatus, StateSpec> = {
  PENDING: { terminal: false, awaiting: 'admin', slaHours: 24, fundsCommitted: false },
  PENDING_ADMIN: { terminal: false, awaiting: 'admin', slaHours: 24, fundsCommitted: false },
  WAITING_BUYER_PAYMENT: { terminal: false, awaiting: 'buyer', slaHours: 24, fundsCommitted: false },
  BUYER_PAID_PENDING_APPROVAL: { terminal: false, awaiting: 'admin', slaHours: 12, fundsCommitted: true },
  WAITING_SELLER_PAYMENT: { terminal: false, awaiting: 'seller', slaHours: 24, fundsCommitted: true },
  SELLER_PAID_PENDING_APPROVAL: { terminal: false, awaiting: 'admin', slaHours: 12, fundsCommitted: true },
  COMPLETED: { terminal: true, awaiting: 'nobody', slaHours: null, fundsCommitted: false },
  REJECTED: { terminal: true, awaiting: 'nobody', slaHours: null, fundsCommitted: false }
};

/**
 * The only legal transitions. Read this table to answer "can X happen now?" instead
 * of searching four files for a status assignment.
 */
const TRANSITIONS: Partial<Record<DealStatus, Partial<Record<DealEventType, DealStatus>>>> = {
  PENDING: {
    ADMIN_APPROVE: 'WAITING_BUYER_PAYMENT',
    ADMIN_REJECT: 'REJECTED'
  },
  PENDING_ADMIN: {
    ADMIN_APPROVE: 'WAITING_BUYER_PAYMENT',
    ADMIN_REJECT: 'REJECTED'
  },
  WAITING_BUYER_PAYMENT: {
    BUYER_UPLOAD_RECEIPT: 'BUYER_PAID_PENDING_APPROVAL',
    ADMIN_REJECT: 'REJECTED'
  },
  BUYER_PAID_PENDING_APPROVAL: {
    ADMIN_CONFIRM_BUYER_RECEIPT: 'WAITING_SELLER_PAYMENT',
    ADMIN_REJECT_BUYER_RECEIPT: 'WAITING_BUYER_PAYMENT'
  },
  WAITING_SELLER_PAYMENT: {
    SELLER_UPLOAD_RECEIPT: 'SELLER_PAID_PENDING_APPROVAL'
  },
  SELLER_PAID_PENDING_APPROVAL: {
    ADMIN_CONFIRM_SELLER_RECEIPT: 'COMPLETED',
    ADMIN_REJECT_SELLER_RECEIPT: 'WAITING_SELLER_PAYMENT'
  }
};

export type RefusalReason =
  /** The deal already finished; nothing can move it. */
  | 'DEAL_IS_TERMINAL'
  /** The event is real but not legal from this state. */
  | 'EVENT_NOT_ALLOWED_HERE'
  /** Deadlines escalate to a human rather than cancelling committed funds. */
  | 'NEEDS_HUMAN_DECISION';

export type TransitionResult =
  | { ok: true; from: DealStatus; to: DealStatus; spec: StateSpec }
  | { ok: false; from: DealStatus; reason: RefusalReason };

/**
 * Applies an event to a state. Pure: it computes, it does not write.
 *
 * A refusal is a normal outcome, not an exception. Two people tapping the same
 * approve button is ordinary, and the second tap should get a clear "already
 * handled" rather than a thrown error or a duplicated side effect.
 */
export function applyDealEvent(from: DealStatus, event: DealEvent): TransitionResult {
  const spec = DEAL_STATES[from];

  if (spec.terminal) {
    return { ok: false, from, reason: 'DEAL_IS_TERMINAL' };
  }

  if (event.type === 'DEADLINE_EXPIRED') {
    // Expiry never moves a deal on its own. Once the buyer has paid, only a human
    // may decide who is owed what; before that, an admin still has to cancel.
    return { ok: false, from, reason: 'NEEDS_HUMAN_DECISION' };
  }

  const to = TRANSITIONS[from]?.[event.type];
  if (!to) {
    return { ok: false, from, reason: 'EVENT_NOT_ALLOWED_HERE' };
  }

  return { ok: true, from, to, spec: DEAL_STATES[to] };
}

/** Convenience for guards that only need a yes or no. */
export function canApply(from: DealStatus, event: DealEvent): boolean {
  return applyDealEvent(from, event).ok;
}

/**
 * The deadline a deal entering `state` should carry, or null when the state needs
 * no clock. Callers persist this on the row so the sweep can find it.
 */
export function deadlineFor(state: DealStatus, now: Date = new Date()): Date | null {
  const hours = DEAL_STATES[state].slaHours;
  if (hours === null) return null;
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

/** Ordered states a deal passes through, for rendering progress to a trader. */
export const DEAL_JOURNEY: DealStatus[] = [
  'PENDING_ADMIN',
  'WAITING_BUYER_PAYMENT',
  'BUYER_PAID_PENDING_APPROVAL',
  'WAITING_SELLER_PAYMENT',
  'SELLER_PAID_PENDING_APPROVAL',
  'COMPLETED'
];

/**
 * How far along a deal is, as a step index into DEAL_JOURNEY.
 * A rejected deal reports the step it died on rather than a position in the journey.
 */
export function journeyIndex(state: DealStatus): number {
  const i = DEAL_JOURNEY.indexOf(state);
  return i === -1 ? 0 : i;
}
