import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '../../src/database/db';
import { runDocumentRetention } from '../../src/jobs/documentRetention';
import { auditTrail } from '../../src/data/audit';
import { closeAccount } from '../../src/data/accountClosure';
import { config } from '../../src/config';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

/** A stand-in for the Telegram client, recording what the job asked it to do. */
function fakeTelegram() {
  const deleted: Array<{ chat: number | string; messageId: number }> = [];
  const sent: Array<{ chat: number | string; text: string }> = [];
  return {
    calls: { deleted, sent },
    api: {
      deleteMessage: vi.fn(async (chat: number | string, messageId: number) => {
        deleted.push({ chat, messageId });
        return true;
      }),
      sendMessage: vi.fn(async (chat: number | string, text: string) => {
        sent.push({ chat, text });
        return { message_id: 1 } as any;
      })
    } as any
  };
}

const HOURS = () => config.DOCUMENT_RETENTION_HOURS;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

async function userWithDocument(opts: {
  telegramId: string;
  uploadedHoursAgo: number;
  status?: 'PENDING' | 'APPROVED';
}) {
  return prisma.user.create({
    data: {
      telegramId: opts.telegramId,
      firstName: 'U',
      verificationStatus: opts.status ?? 'PENDING',
      documentFileId: `file-${opts.telegramId}`,
      documentUploadedAt: hoursAgo(opts.uploadedHoursAgo),
      adminVerifyPhotoId: 555,
      adminVerifyMsgId: 556
    }
  });
}

async function wipe() {
  await prisma.auditEvent.deleteMany();
  await prisma.deal.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.user.deleteMany();
}

describeDb('identity document retention', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await wipe(); await prisma.$disconnect(); });
  beforeEach(wipe);

  it('defaults to a 24 hour window', () => {
    expect(HOURS()).toBe(24);
  });

  it('keeps a document that is still inside the window', async () => {
    await userWithDocument({ telegramId: 'fresh', uploadedHoursAgo: HOURS() - 2 });
    const tg = fakeTelegram();

    const report = await runDocumentRetention(tg.api);

    expect(report.purged).toBe(0);
    const after = await prisma.user.findUniqueOrThrow({ where: { telegramId: 'fresh' } });
    expect(after.documentFileId).not.toBeNull();
  });

  it('deletes the document and both admin-chat copies once the window passes', async () => {
    await userWithDocument({ telegramId: 'stale', uploadedHoursAgo: HOURS() + 1, status: 'APPROVED' });
    const tg = fakeTelegram();

    const report = await runDocumentRetention(tg.api);

    expect(report.purged).toBe(1);

    const after = await prisma.user.findUniqueOrThrow({ where: { telegramId: 'stale' } });
    expect(after.documentFileId).toBeNull();
    expect(after.documentUploadedAt).toBeNull();
    expect(after.adminVerifyPhotoId).toBeNull();
    expect(after.adminVerifyMsgId).toBeNull();

    // Both the forwarded photo and its caption message are removed from the admin chat.
    expect(tg.calls.deleted.map(d => d.messageId).sort()).toEqual([555, 556]);
  });

  it('leaves an approved user verified after their document is deleted', async () => {
    await userWithDocument({ telegramId: 'approved', uploadedHoursAgo: HOURS() + 1, status: 'APPROVED' });

    await runDocumentRetention(fakeTelegram().api);

    const after = await prisma.user.findUniqueOrThrow({ where: { telegramId: 'approved' } });
    expect(after.verificationStatus).toBe('APPROVED');
  });

  it('returns an unreviewed verification to unverified rather than stalling it', async () => {
    await userWithDocument({ telegramId: 'stranded', uploadedHoursAgo: HOURS() + 1, status: 'PENDING' });
    const tg = fakeTelegram();

    await runDocumentRetention(tg.api);

    const after = await prisma.user.findUniqueOrThrow({ where: { telegramId: 'stranded' } });
    // Leaving it PENDING would mean an admin queue entry with no document behind it.
    expect(after.verificationStatus).toBe('UNVERIFIED');
    expect(tg.calls.sent.some(m => m.chat === 'stranded' && m.text.includes('دوباره'))).toBe(true);
  });

  it('records every purge in the audit trail', async () => {
    const user = await userWithDocument({ telegramId: 'audited', uploadedHoursAgo: HOURS() + 1, status: 'APPROVED' });

    await runDocumentRetention(fakeTelegram().api);

    const trail = await auditTrail('User', user.id);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe('user.document.purge');
    expect(trail[0].actor).toBe('system');
    expect((trail[0].after as any).hadDocument).toBe(false);
  });

  it('reminds admins about verifications whose documents are about to expire', async () => {
    await userWithDocument({ telegramId: 'halfway', uploadedHoursAgo: HOURS() / 2 + 1, status: 'PENDING' });
    const tg = fakeTelegram();

    const report = await runDocumentRetention(tg.api);

    expect(report.remindedAdmins).toBe(1);
    expect(tg.calls.sent.some(m => m.text.includes('یادآوری بررسی مدارک'))).toBe(true);
  });

  it('is safe to run repeatedly', async () => {
    await userWithDocument({ telegramId: 'twice', uploadedHoursAgo: HOURS() + 1, status: 'APPROVED' });

    const first = await runDocumentRetention(fakeTelegram().api);
    const second = await runDocumentRetention(fakeTelegram().api);

    expect(first.purged).toBe(1);
    expect(second.purged).toBe(0);
    const user = await prisma.user.findUniqueOrThrow({ where: { telegramId: 'twice' } });
    expect(await auditTrail('User', user.id)).toHaveLength(1);
  });

  it('carries on when one user\'s admin copy cannot be deleted', async () => {
    await userWithDocument({ telegramId: 'broken', uploadedHoursAgo: HOURS() + 1, status: 'APPROVED' });
    await userWithDocument({ telegramId: 'fine', uploadedHoursAgo: HOURS() + 1, status: 'APPROVED' });

    const tg = fakeTelegram();
    tg.api.deleteMessage = vi.fn(async () => { throw new Error('message to delete not found'); });

    const report = await runDocumentRetention(tg.api);

    // A stale chat message is better than a job that stops scrubbing rows.
    expect(report.purged).toBe(2);
  });
});

describeDb('closing an account removes the document too', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await wipe(); await prisma.$disconnect(); });
  beforeEach(wipe);

  it('clears the document and hands back the admin copies to delete', async () => {
    await userWithDocument({ telegramId: 'leaver', uploadedHoursAgo: 1, status: 'APPROVED' });

    const result = await closeAccount('leaver', 'leaver');

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Without these the document would outlive the account in the admin chat.
      expect(result.adminCopyMessageIds.sort()).toEqual([555, 556]);
    }

    const after = await prisma.user.findUniqueOrThrow({ where: { telegramId: 'leaver' } });
    expect(after.documentFileId).toBeNull();
    expect(after.documentUploadedAt).toBeNull();
  });
});
