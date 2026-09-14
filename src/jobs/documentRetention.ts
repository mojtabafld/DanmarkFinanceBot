import type { Telegram } from 'telegraf';
import { prisma } from '../database/db';
import { config } from '../config';
import { recordAudit, SYSTEM_ACTOR } from '../data/audit';
import { notifyChatId } from '../data/admins';
import { t } from '../i18n';

/**
 * Deletes identity documents once their retention window has passed.
 *
 * Documents were previously kept forever: the file reference stayed on the user row,
 * the file itself stayed on Telegram's servers, and a forwarded copy sat in the admin
 * chat indefinitely. Closing an account dropped the reference and told the user all
 * their data had been erased, which was not true of either copy.
 *
 * The window runs from upload, not from the verification decision, so a document
 * cannot outlive it by sitting unreviewed. An admin who has not decided in time is
 * reminded at half-window; if the document still expires, the user is asked to submit
 * again rather than having their pending verification silently stall with no document
 * behind it.
 */

export interface RetentionReport {
  purged: number;
  remindedAdmins: number;
}

/** Deletes the admin chat's copies of a user's document, if they are still there. */
async function deleteAdminCopies(
  telegram: Telegram,
  user: { adminVerifyMsgId: number | null; adminVerifyPhotoId: number | null }
): Promise<void> {
  const chat = notifyChatId();
  for (const messageId of [user.adminVerifyPhotoId, user.adminVerifyMsgId]) {
    if (!messageId) continue;
    // Telegram lets a bot delete its own messages for 48 hours, comfortably longer
    // than the default window. A failure here is logged, never fatal: the row is
    // still scrubbed, and a stale chat message is better than a stuck job.
    await telegram.deleteMessage(chat, messageId).catch(err => {
      console.error(`Could not delete admin document copy ${messageId}:`, err?.description ?? err);
    });
  }
}

export async function runDocumentRetention(telegram: Telegram, now: Date = new Date()): Promise<RetentionReport> {
  const windowHours = config.DOCUMENT_RETENTION_HOURS;
  const cutoff = new Date(now.getTime() - windowHours * 3_600_000);
  const halfway = new Date(now.getTime() - (windowHours / 2) * 3_600_000);

  let purged = 0;
  let remindedAdmins = 0;

  // Remind the admins about verifications that will lose their document soon.
  const expiringSoon = await prisma.user.findMany({
    where: {
      verificationStatus: 'PENDING',
      documentFileId: { not: null },
      documentUploadedAt: { lt: halfway, gte: cutoff }
    },
    select: { id: true, telegramId: true, fullName: true, documentUploadedAt: true }
  });

  if (expiringSoon.length > 0) {
    await telegram
      .sendMessage(
        notifyChatId(),
        t('retention.admin.reminder', { count: expiringSoon.length, hours: Math.ceil(windowHours / 2) })
      )
      .then(() => { remindedAdmins = expiringSoon.length; })
      .catch(err => console.error('Could not remind admins about expiring documents:', err));
  }

  const expired = await prisma.user.findMany({
    where: { documentFileId: { not: null }, documentUploadedAt: { lt: cutoff } }
  });

  for (const user of expired) {
    try {
      await deleteAdminCopies(telegram, user);

      // A verification still awaiting a decision has nothing to decide on now, so it
      // returns to unverified rather than sitting pending against a missing document.
      const stranded = user.verificationStatus === 'PENDING';

      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            documentFileId: null,
            documentUploadedAt: null,
            adminVerifyMsgId: null,
            adminVerifyPhotoId: null,
            ...(stranded ? { verificationStatus: 'UNVERIFIED' as const } : {})
          }
        });

        await recordAudit(tx, {
          actor: SYSTEM_ACTOR,
          action: 'user.document.purge',
          subjectType: 'User',
          subjectId: user.id,
          before: { hadDocument: true, verificationStatus: user.verificationStatus },
          after: { hadDocument: false, verificationStatus: stranded ? 'UNVERIFIED' : user.verificationStatus },
          note: `retention window of ${windowHours}h elapsed`
        });
      });

      purged++;

      await telegram
        .sendMessage(user.telegramId, stranded ? t('retention.user.stranded', { hours: windowHours }) : t('retention.user.purged', { hours: windowHours }))
        .catch(err => console.error(`Could not notify ${user.telegramId} of document deletion:`, err?.description ?? err));
    } catch (err) {
      // One failure must not stop the rest of the sweep.
      console.error(`Document retention failed for user ${user.id}:`, err);
    }
  }

  return { purged, remindedAdmins };
}

/** Runs the retention job on an interval. Returns a stop function. */
export function startDocumentRetention(telegram: Telegram, everyMinutes = 30): () => void {
  const tick = async () => {
    try {
      const report = await runDocumentRetention(telegram);
      if (report.purged > 0) {
        console.log(`🪪 Document retention: purged ${report.purged} document(s).`);
      }
    } catch (err) {
      console.error('Document retention sweep failed:', err);
    }
  };

  const handle = setInterval(tick, everyMinutes * 60 * 1000);
  void tick();
  return () => clearInterval(handle);
}
