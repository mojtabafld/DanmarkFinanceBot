import type { DealStatus } from '@prisma/client';
import { prisma } from '../database/db';
import { recordAudit } from './audit';
import { applyDealEvent, deadlineFor, type DealEvent, type RefusalReason } from '../domain/dealMachine';

/**
 * The only supported way to move a deal.
 *
 * Handlers used to load a deal, compare its status by hand, and write the next status
 * themselves, in four different files. That let a deal be moved from a state the
 * lifecycle never allowed, and it left no record of who moved it.
 *
 * This asks the state machine what is legal, writes the change conditionally on the
 * status not having moved underneath, sets the new deadline, and records the audit
 * row in the same transaction.
 */

export type TransitionOutcome =
  | { ok: true; from: DealStatus; to: DealStatus }
  | { ok: false; reason: RefusalReason | 'DEAL_NOT_FOUND' | 'RACED'; current?: DealStatus };

export async function transitionDeal(
  dealId: number,
  event: DealEvent,
  actor: string,
  note?: string
): Promise<TransitionOutcome> {
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal) return { ok: false, reason: 'DEAL_NOT_FOUND' };

  const verdict = applyDealEvent(deal.status, event);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, current: deal.status };

  const now = new Date();
  const deadline = deadlineFor(verdict.to, now);

  return prisma.$transaction(async (tx) => {
    // Conditional on the status we decided from. If a second tap of the same button
    // got here first, this matches nothing and we report the race instead of
    // applying the transition twice.
    const claimed = await tx.deal.updateMany({
      where: { id: dealId, status: verdict.from },
      data: {
        status: verdict.to,
        deadlineAt: deadline,
        remindedAt: null,
        updatedAt: now
      }
    });

    if (claimed.count !== 1) {
      const current = await tx.deal.findUnique({ where: { id: dealId }, select: { status: true } });
      return { ok: false as const, reason: 'RACED' as const, current: current?.status };
    }

    await recordAudit(tx, {
      actor,
      action: `deal.${event.type.toLowerCase()}`,
      subjectType: 'Deal',
      subjectId: dealId,
      before: { status: verdict.from, deadlineAt: deal.deadlineAt },
      after: { status: verdict.to, deadlineAt: deadline },
      note
    });

    return { ok: true as const, from: verdict.from, to: verdict.to };
  });
}
