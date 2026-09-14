import type { AdminRole } from '@prisma/client';
import { prisma } from '../database/db';
import { config } from '../config';

/**
 * Admin identity, separated from the admin notification destination.
 *
 * These used to be the same environment variable. Because the identity check compared
 * the sender against that id, pointing it at a group chat, which the setup docs
 * suggested, made every admin button reject every admin forever while notifications
 * kept arriving. They are different things and now have different homes.
 */

const ROLE_RANK: Record<AdminRole, number> = { VIEWER: 0, OPERATOR: 1, OWNER: 2 };

/** Where admin notifications are sent. May be a group. */
export function notifyChatId(): number {
  return config.ADMIN_NOTIFY_CHAT_ID;
}

/**
 * The admin record for a Telegram id, or null.
 *
 * The bootstrap owner from configuration is always recognised, so a fresh deployment
 * has someone who can add the rest and an emptied table cannot lock everyone out.
 */
export async function findAdmin(telegramId: string | number) {
  const id = String(telegramId);

  if (config.BOOTSTRAP_ADMIN_ID && id === String(config.BOOTSTRAP_ADMIN_ID)) {
    return { id: 0, telegramId: id, label: 'bootstrap owner', role: 'OWNER' as AdminRole, createdAt: new Date(), revokedAt: null };
  }

  return prisma.admin.findFirst({ where: { telegramId: id, revokedAt: null } });
}

/** True when this user holds at least `minimum`. */
export async function hasRole(telegramId: string | number, minimum: AdminRole): Promise<boolean> {
  const admin = await findAdmin(telegramId);
  if (!admin) return false;
  return ROLE_RANK[admin.role] >= ROLE_RANK[minimum];
}

/** True for anyone who may act on the admin panel at all. */
export function isAdmin(telegramId: string | number): Promise<boolean> {
  return hasRole(telegramId, 'VIEWER');
}

/** True for anyone who may approve trades, verifications and receipts. */
export function canOperate(telegramId: string | number): Promise<boolean> {
  return hasRole(telegramId, 'OPERATOR');
}

/** Every admin who may act, for escalations and second-approver checks. */
export function activeOperators() {
  return prisma.admin.findMany({
    where: { revokedAt: null, role: { in: ['OPERATOR', 'OWNER'] } },
    orderBy: { createdAt: 'asc' }
  });
}
