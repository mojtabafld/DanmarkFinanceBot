import type { Telegram } from 'telegraf';
import type { DealStatus } from '@prisma/client';
import { prisma } from '../database/db';
import { recordAudit, SYSTEM_ACTOR } from '../data/audit';
import { notifyChatId } from '../data/admins';
import { DEAL_STATES } from '../domain/dealMachine';
import { t } from '../i18n';
import { awaitingLabel } from '../ui/dealCard';
import { getTimezoneByCountry, formatToShamsi } from '../bot/utils/groupMessage';

/**
 * Moves stalled trades back into someone's attention.
 *
 * A deal used to be able to sit in WAITING_SELLER_PAYMENT forever: the buyer had
 * paid, the seller owed currency, and nothing in the system would ever mention it
 * again. The sweep reminds the responsible party at half time and escalates to the
 * admins at the deadline.
 *
 * It never changes a deal's state. Expiry is not a decision the machine can make once
 * money has moved, so the sweep's job is to page a human, not to resolve anything.
 */

export interface SweepReport {
  reminded: number;
  escalated: number;
}

const HALF_TIME = 0.5;

export async function runDeadlineSweep(telegram: Telegram, now: Date = new Date()): Promise<SweepReport> {
  const openStates = (Object.keys(DEAL_STATES) as DealStatus[]).filter(s => !DEAL_STATES[s].terminal);

  const candidates = await prisma.deal.findMany({
    where: { status: { in: openStates }, deadlineAt: { not: null } },
    include: { proposal: { include: { creator: true } }, acceptor: true }
  });

  let reminded = 0;
  let escalated = 0;

  for (const deal of candidates) {
    const deadline = deal.deadlineAt!;
    const spec = DEAL_STATES[deal.status];
    const code = deal.proposal.code ?? String(deal.proposalId);

    try {
      if (now >= deadline) {
        await escalate(telegram, deal, code, now);
        escalated++;
        continue;
      }

      // Half time: one nudge to whoever we are waiting on, and only once per state.
      const started = deal.updatedAt ?? deal.createdAt;
      const elapsed = now.getTime() - started.getTime();
      const window = deadline.getTime() - started.getTime();
      const pastHalfway = window > 0 && elapsed / window >= HALF_TIME;
      const alreadyReminded = deal.remindedAt !== null && deal.remindedAt >= started;

      if (pastHalfway && !alreadyReminded && spec.awaiting !== 'admin') {
        await remind(telegram, deal, code, deadline);
        await prisma.deal.update({ where: { id: deal.id }, data: { remindedAt: now } });
        reminded++;
      }
    } catch (err) {
      // One unreachable user must not stop the sweep for everyone else.
      console.error(`Deadline sweep failed for deal ${deal.id}:`, err);
    }
  }

  return { reminded, escalated };
}

type DealWithParties = Awaited<ReturnType<typeof loadShape>>;
async function loadShape() {
  return prisma.deal.findFirstOrThrow({
    include: { proposal: { include: { creator: true } }, acceptor: true }
  });
}

/** The two sides of a trade, resolved from the ad's direction. */
function parties(deal: DealWithParties) {
  const creatorIsBuyer = deal.proposal.type === 'BUY';
  return {
    buyer: creatorIsBuyer ? deal.proposal.creator : deal.acceptor,
    seller: creatorIsBuyer ? deal.acceptor : deal.proposal.creator
  };
}

async function remind(telegram: Telegram, deal: DealWithParties, code: string, deadline: Date) {
  const { buyer, seller } = parties(deal);
  const spec = DEAL_STATES[deal.status];
  const target = spec.awaiting === 'buyer' ? buyer : seller;
  const key = spec.awaiting === 'buyer' ? 'sla.remind.buyer' : 'sla.remind.seller';

  await telegram.sendMessage(
    target.telegramId,
    t(key, { code, deadline: formatToShamsi(deadline, getTimezoneByCountry(target.country)) })
  );
}

async function escalate(telegram: Telegram, deal: DealWithParties, code: string, now: Date) {
  const spec = DEAL_STATES[deal.status];
  const { buyer, seller } = parties(deal);
  const hours = Math.floor((now.getTime() - deal.deadlineAt!.getTime()) / 3_600_000);

  await prisma.$transaction(async (tx) => {
    // Clearing the deadline is what makes escalation happen once rather than on every
    // sweep; the deal keeps its state and waits for a human.
    await tx.deal.update({ where: { id: deal.id }, data: { deadlineAt: null } });

    await recordAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'deal.deadline.escalate',
      subjectType: 'Deal',
      subjectId: deal.id,
      before: { status: deal.status, deadlineAt: deal.deadlineAt },
      after: { status: deal.status, deadlineAt: null },
      note: `overdue by ${hours}h while awaiting ${spec.awaiting}`
    });
  });

  await telegram.sendMessage(
    notifyChatId(),
    t('sla.escalated.admin', {
      dealId: deal.id,
      code,
      hours,
      status: deal.status,
      awaiting: awaitingLabel(deal.status),
      funds: spec.fundsCommitted ? t('sla.funds.committed') : t('sla.funds.pending')
    })
  );

  // Tell whoever was waiting that it is no longer on them.
  for (const party of [buyer, seller]) {
    await telegram
      .sendMessage(party.telegramId, t('sla.escalated.user', { code }))
      .catch(err => console.error(`Could not notify ${party.telegramId} of escalation:`, err));
  }
}

/** Starts the sweep on an interval. Returns a stop function for graceful shutdown. */
export function startDeadlineSweep(telegram: Telegram, everyMinutes = 15): () => void {
  const tick = async () => {
    try {
      const report = await runDeadlineSweep(telegram);
      if (report.reminded || report.escalated) {
        console.log(`⏰ Deadline sweep: ${report.reminded} reminded, ${report.escalated} escalated.`);
      }
    } catch (err) {
      console.error('Deadline sweep failed:', err);
    }
  };

  const handle = setInterval(tick, everyMinutes * 60 * 1000);
  void tick();
  return () => clearInterval(handle);
}
