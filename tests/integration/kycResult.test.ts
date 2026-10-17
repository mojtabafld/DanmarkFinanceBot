import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

process.env.KYC_BASE_URL = 'https://kyc.example.com';
process.env.KYC_LINK_SECRET = 'test-kyc-secret';

import { prisma } from '../../src/database/db';
import { applyKycResult } from '../../src/kyc/result';
import type { KycResult } from '../../src/kyc/link';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

/** A stand-in for the Telegram client, recording what was sent. */
function fakeTelegram() {
  const sent: Array<{ chat: number | string; text: string; extra?: any }> = [];
  return {
    sent,
    api: {
      sendMessage: vi.fn(async (chat: number | string, text: string, extra?: any) => {
        sent.push({ chat, text, extra });
        return { message_id: 77 } as any;
      }),
      createChatInviteLink: vi.fn(async () => ({ invite_link: 'https://t.me/+invite' }))
    } as any
  };
}

const result = (over: Partial<KycResult> = {}): KycResult => ({
  verification_id: 'v-1',
  telegram_id: '5001',
  status: 'APPROVED',
  reasons: [],
  automated: true,
  document: {
    document_type: 'IR', issuing_country: 'DNK', surname: 'ERIKSSON', given_names: 'ANNA MARIA',
    document_number: 'D23145890', nationality: 'UTO', birth_date: '1974-08-12', sex: 'F',
    expiry_date: '2030-04-15', checks_ok: true
  },
  face_match: 0.63,
  live_probability: 0.94,
  ...over
});

async function wipe() {
  await prisma.auditEvent.deleteMany();
  await prisma.deal.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.user.deleteMany();
}

async function newUser() {
  return prisma.user.create({
    data: { telegramId: '5001', firstName: 'Anna', fullName: 'Anna typed', country: 'دانمارک', phoneNumber: '+45' }
  });
}

describeDb('face-scan KYC results', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await wipe(); await prisma.$disconnect(); });
  beforeEach(wipe);

  it('approves, uses the name on the document, invites to the group and tells the admin', async () => {
    await newUser();
    const tg = fakeTelegram();
    await applyKycResult(tg.api, result());

    const u = await prisma.user.findUniqueOrThrow({ where: { telegramId: '5001' } });
    expect(u.verificationStatus).toBe('APPROVED');
    expect(u.fullName).toBe('ANNA MARIA ERIKSSON');
    expect(tg.api.createChatInviteLink).toHaveBeenCalledOnce();
    expect(tg.sent.map(m => String(m.chat))).toEqual(['5001', '111111']);
    expect(tg.sent[1].text).toContain('D23145890');
  });

  it('applies a re-sent result only once', async () => {
    await newUser();
    const tg = fakeTelegram();
    await applyKycResult(tg.api, result({ status: 'MANUAL_REVIEW', reasons: ['mrz_check_digit_failed'] }));
    await applyKycResult(tg.api, result({ status: 'MANUAL_REVIEW', reasons: ['mrz_check_digit_failed'] }));
    expect(tg.sent).toHaveLength(2); // admin card + user notice, once
  });

  it('sends a manual review to the admin with the approve and reject buttons', async () => {
    const user = await newUser();
    const tg = fakeTelegram();
    await applyKycResult(tg.api, result({ status: 'MANUAL_REVIEW', reasons: ['face_match_uncertain'] }));

    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(u.verificationStatus).toBe('PENDING');
    expect(u.adminVerifyMsgId).toBe(77);
    const buttons = JSON.stringify(tg.sent[0].extra.reply_markup);
    expect(buttons).toContain(`APPROVE_USER_${user.id}`);
    expect(buttons).toContain(`REJECT_USER_${user.id}`);
  });

  it('lets the user retry an automatic rejection with a fresh link', async () => {
    await newUser();
    const tg = fakeTelegram();
    await applyKycResult(tg.api, result({ status: 'REJECTED', reasons: ['circle_incomplete'], document: null }));

    const u = await prisma.user.findUniqueOrThrow({ where: { telegramId: '5001' } });
    expect(u.verificationStatus).toBe('UNVERIFIED');
    expect(tg.sent[0].text).toContain('حرکت دایره‌ای سر کامل نشد');
    expect(JSON.stringify(tg.sent[0].extra.reply_markup)).toContain('https://kyc.example.com/tg/5001.');
  });

  it('never overrides an account already approved', async () => {
    await prisma.user.create({ data: { telegramId: '5001', firstName: 'A', verificationStatus: 'APPROVED' } });
    const tg = fakeTelegram();
    await applyKycResult(tg.api, result({ status: 'REJECTED', automated: false, reasons: ['x'] }));
    const u = await prisma.user.findUniqueOrThrow({ where: { telegramId: '5001' } });
    expect(u.verificationStatus).toBe('APPROVED');
    expect(tg.sent).toHaveLength(0);
  });
});
