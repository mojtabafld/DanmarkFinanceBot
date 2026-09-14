import { describe, it, expect } from 'vitest';
import type { DealStatus } from '@prisma/client';
import {
  applyDealEvent,
  canApply,
  deadlineFor,
  DEAL_STATES,
  DEAL_JOURNEY,
  journeyIndex,
  type DealEvent
} from '../src/domain/dealMachine';

const ALL_STATES = Object.keys(DEAL_STATES) as DealStatus[];

const ALL_EVENTS: DealEvent[] = [
  { type: 'ADMIN_APPROVE' },
  { type: 'ADMIN_REJECT' },
  { type: 'BUYER_UPLOAD_RECEIPT' },
  { type: 'SELLER_UPLOAD_RECEIPT' },
  { type: 'ADMIN_CONFIRM_BUYER_RECEIPT' },
  { type: 'ADMIN_REJECT_BUYER_RECEIPT' },
  { type: 'ADMIN_CONFIRM_SELLER_RECEIPT' },
  { type: 'ADMIN_REJECT_SELLER_RECEIPT' },
  { type: 'DEADLINE_EXPIRED' }
];

describe('the happy path', () => {
  it('walks a trade from admin approval to completion', () => {
    const script: Array<[DealStatus, DealEvent['type'], DealStatus]> = [
      ['PENDING_ADMIN', 'ADMIN_APPROVE', 'WAITING_BUYER_PAYMENT'],
      ['WAITING_BUYER_PAYMENT', 'BUYER_UPLOAD_RECEIPT', 'BUYER_PAID_PENDING_APPROVAL'],
      ['BUYER_PAID_PENDING_APPROVAL', 'ADMIN_CONFIRM_BUYER_RECEIPT', 'WAITING_SELLER_PAYMENT'],
      ['WAITING_SELLER_PAYMENT', 'SELLER_UPLOAD_RECEIPT', 'SELLER_PAID_PENDING_APPROVAL'],
      ['SELLER_PAID_PENDING_APPROVAL', 'ADMIN_CONFIRM_SELLER_RECEIPT', 'COMPLETED']
    ];

    let state: DealStatus = 'PENDING_ADMIN';
    for (const [from, event, to] of script) {
      expect(state).toBe(from);
      const result = applyDealEvent(state, { type: event } as DealEvent);
      expect(result.ok, `${from} + ${event}`).toBe(true);
      if (result.ok) state = result.to;
      expect(state).toBe(to);
    }
    expect(DEAL_STATES[state].terminal).toBe(true);
  });
});

describe('rejected receipts return the payer to their payment step', () => {
  it('sends a rejected buyer receipt back to WAITING_BUYER_PAYMENT', () => {
    const r = applyDealEvent('BUYER_PAID_PENDING_APPROVAL', { type: 'ADMIN_REJECT_BUYER_RECEIPT' });
    expect(r.ok && r.to).toBe('WAITING_BUYER_PAYMENT');
  });

  it('sends a rejected seller receipt back to WAITING_SELLER_PAYMENT', () => {
    const r = applyDealEvent('SELLER_PAID_PENDING_APPROVAL', { type: 'ADMIN_REJECT_SELLER_RECEIPT' });
    expect(r.ok && r.to).toBe('WAITING_SELLER_PAYMENT');
  });
});

describe('refusals', () => {
  it('refuses every event once the deal is terminal', () => {
    for (const state of ['COMPLETED', 'REJECTED'] as DealStatus[]) {
      for (const event of ALL_EVENTS) {
        const r = applyDealEvent(state, event);
        expect(r.ok, `${state} + ${event.type}`).toBe(false);
        if (!r.ok) expect(r.reason).toBe('DEAL_IS_TERMINAL');
      }
    }
  });

  it('refuses a second confirmation of the same receipt', () => {
    const first = applyDealEvent('BUYER_PAID_PENDING_APPROVAL', { type: 'ADMIN_CONFIRM_BUYER_RECEIPT' });
    expect(first.ok).toBe(true);
    // The admin taps the same button again; the deal has already moved on.
    const second = applyDealEvent('WAITING_SELLER_PAYMENT', { type: 'ADMIN_CONFIRM_BUYER_RECEIPT' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('EVENT_NOT_ALLOWED_HERE');
  });

  it('refuses a buyer receipt before the admin has approved the deal', () => {
    expect(canApply('PENDING_ADMIN', { type: 'BUYER_UPLOAD_RECEIPT' })).toBe(false);
  });

  it('refuses a seller receipt before the buyer has been confirmed', () => {
    expect(canApply('WAITING_BUYER_PAYMENT', { type: 'SELLER_UPLOAD_RECEIPT' })).toBe(false);
  });

  it('will not let an admin reject a deal after the buyer has paid', () => {
    // Unwinding committed funds is a dispute, not a button.
    expect(canApply('BUYER_PAID_PENDING_APPROVAL', { type: 'ADMIN_REJECT' })).toBe(false);
    expect(canApply('WAITING_SELLER_PAYMENT', { type: 'ADMIN_REJECT' })).toBe(false);
  });
});

describe('deadlines', () => {
  it('never resolves an expiry automatically', () => {
    for (const state of ALL_STATES) {
      const r = applyDealEvent(state, { type: 'DEADLINE_EXPIRED' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(['DEAL_IS_TERMINAL', 'NEEDS_HUMAN_DECISION']).toContain(r.reason);
      }
    }
  });

  it('gives every non-terminal state a clock', () => {
    for (const state of ALL_STATES) {
      const spec = DEAL_STATES[state];
      if (spec.terminal) {
        expect(deadlineFor(state)).toBeNull();
      } else {
        expect(spec.slaHours, `${state} has no SLA`).toBeGreaterThan(0);
        expect(deadlineFor(state)).toBeInstanceOf(Date);
      }
    }
  });

  it('computes the deadline from the given instant', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const due = deadlineFor('WAITING_SELLER_PAYMENT', now)!;
    expect(due.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('the funds-committed boundary', () => {
  it('marks every state after the buyer pays as holding committed funds', () => {
    expect(DEAL_STATES.WAITING_BUYER_PAYMENT.fundsCommitted).toBe(false);
    expect(DEAL_STATES.BUYER_PAID_PENDING_APPROVAL.fundsCommitted).toBe(true);
    expect(DEAL_STATES.WAITING_SELLER_PAYMENT.fundsCommitted).toBe(true);
    expect(DEAL_STATES.SELLER_PAID_PENDING_APPROVAL.fundsCommitted).toBe(true);
  });
});

describe('journey rendering', () => {
  it('advances monotonically along the happy path', () => {
    const seen = DEAL_JOURNEY.map(journeyIndex);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(DEAL_JOURNEY.length);
  });

  it('places a rejected deal outside the journey', () => {
    expect(DEAL_JOURNEY).not.toContain('REJECTED');
    expect(journeyIndex('REJECTED')).toBe(0);
  });
});

describe('the table itself', () => {
  it('describes every status the schema defines', () => {
    // Guards against a new DealStatus being added without a spec.
    for (const state of ALL_STATES) {
      expect(DEAL_STATES[state], `${state} has no spec`).toBeDefined();
    }
  });

  it('only ever transitions to a state it also describes', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        const r = applyDealEvent(state, event);
        if (r.ok) expect(ALL_STATES).toContain(r.to);
      }
    }
  });

  it('can reach both terminal states from the start', () => {
    const reachable = new Set<DealStatus>(['PENDING_ADMIN']);
    const queue: DealStatus[] = ['PENDING_ADMIN'];
    while (queue.length) {
      const s = queue.pop()!;
      for (const event of ALL_EVENTS) {
        const r = applyDealEvent(s, event);
        if (r.ok && !reachable.has(r.to)) {
          reachable.add(r.to);
          queue.push(r.to);
        }
      }
    }
    expect(reachable.has('COMPLETED')).toBe(true);
    expect(reachable.has('REJECTED')).toBe(true);
  });
});
