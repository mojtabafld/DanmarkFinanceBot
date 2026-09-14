import type { Prisma } from '@prisma/client';
import { prisma } from '../database/db';
import { recordAudit } from './audit';
import { DEAL_STATES } from '../domain/dealMachine';
import type { DealStatus } from '@prisma/client';

/**
 * Closing an account without destroying anyone else's trade history.
 *
 * Deleting the row used to cascade through the user's ads into the deals attached to
 * them, including deals belonging to the counterparty. A seller holding a deal the
 * buyer had already paid for could erase the buyer's record of it. The foreign keys
 * are now RESTRICT, so the database refuses that outright; this module is the
 * supported way to leave.
 */

/** Deal states that must be settled before someone can close their account. */
const OPEN_STATES = (Object.keys(DEAL_STATES) as DealStatus[]).filter(s => !DEAL_STATES[s].terminal);

export type ClosureResult =
  | { ok: true; scrubbed: true }
  | { ok: false; reason: 'NOT_FOUND' }
  | { ok: false; reason: 'OPEN_DEALS'; dealIds: number[] };

/** Deals still in flight for this user, on either side of the trade. */
export async function openDealsFor(userId: number) {
  return prisma.deal.findMany({
    where: {
      status: { in: OPEN_STATES },
      OR: [{ acceptorId: userId }, { proposal: { creatorId: userId } }]
    },
    select: { id: true, status: true }
  });
}

/**
 * Closes an account: refuses while any trade is unsettled, otherwise scrubs the
 * personal columns and marks the row deleted, keeping the trades themselves intact.
 *
 * What survives is deliberate. The user's name, contact details and identity document
 * go; the fact that trade #482 happened, and between which two account ids, stays,
 * because the counterparty's history is not this user's to erase.
 */
export async function closeAccount(telegramId: string, actor: string): Promise<ClosureResult> {
  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user || user.deletedAt) return { ok: false, reason: 'NOT_FOUND' };

  const open = await openDealsFor(user.id);
  if (open.length > 0) {
    return { ok: false, reason: 'OPEN_DEALS', dealIds: open.map(d => d.id) };
  }

  await prisma.$transaction(async (tx) => {
    const scrubbed: Prisma.UserUpdateInput = {
      deletedAt: new Date(),
      verificationStatus: 'DELETED',
      username: null,
      firstName: 'حساب حذف‌شده',
      lastName: null,
      fullName: null,
      country: null,
      phoneNumber: null,
      documentFileId: null,
      rejectReason: null,
      adminVerifyMsgId: null,
      adminVerifyPhotoId: null,
      hasPendingLimitRequest: false
    };

    await tx.user.update({ where: { id: user.id }, data: scrubbed });

    // Their open ads come down with them; settled trades do not.
    await tx.proposal.updateMany({
      where: { creatorId: user.id, status: { in: ['PENDING', 'PENDING_APPROVAL'] } },
      data: { status: 'CANCELLED' }
    });

    await recordAudit(tx, {
      actor,
      action: 'user.account.close',
      subjectType: 'User',
      subjectId: user.id,
      before: { telegramId: user.telegramId, verificationStatus: user.verificationStatus },
      after: { deletedAt: new Date().toISOString(), verificationStatus: 'DELETED' },
      note: 'personal fields scrubbed; trade history retained'
    });
  });

  return { ok: true, scrubbed: true };
}
