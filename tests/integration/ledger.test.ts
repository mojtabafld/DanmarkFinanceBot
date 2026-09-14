import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../../src/database/db';
import { closeAccount, openDealsFor } from '../../src/data/accountClosure';
import { transitionDeal } from '../../src/data/deals';
import { recordAudit, auditTrail } from '../../src/data/audit';
import { consume, refill, LIMITS } from '../../src/data/rateLimit';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

async function wipe() {
  await prisma.auditEvent.deleteMany();
  await prisma.rateBucket.deleteMany();
  await prisma.counterOffer.deleteMany();
  await prisma.deal.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.user.deleteMany();
}

async function tradeInFlight(status: 'WAITING_SELLER_PAYMENT' | 'COMPLETED' = 'WAITING_SELLER_PAYMENT') {
  const seller = await prisma.user.create({ data: { telegramId: 'seller', firstName: 'Seller', fullName: 'Real Name', phoneNumber: '+4500000000', documentFileId: 'doc-123', verificationStatus: 'APPROVED' } });
  const buyer = await prisma.user.create({ data: { telegramId: 'buyer', firstName: 'Buyer', verificationStatus: 'APPROVED' } });
  const ad = await prisma.proposal.create({ data: { creatorId: seller.id, type: 'SELL', currency: 'DKK', amount: 0, originalAmount: 1000, price: 5000, priceCurrency: 'T', status: 'LOCKED', code: '0001' } });
  const deal = await prisma.deal.create({ data: { proposalId: ad.id, acceptorId: buyer.id, amount: 1000, status } });
  return { seller, buyer, ad, deal };
}

describeDb('account closure cannot destroy a counterparty trade', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await wipe(); await prisma.$disconnect(); });
  beforeEach(wipe);

  it('refuses to close an account while a trade is unsettled', async () => {
    const { deal } = await tradeInFlight('WAITING_SELLER_PAYMENT');

    const result = await closeAccount('seller', 'seller');

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'OPEN_DEALS') {
      expect(result.dealIds).toEqual([deal.id]);
    }
    // The whole point: the buyer's paid deal is still there.
    expect(await prisma.deal.count()).toBe(1);
    expect(await prisma.user.count()).toBe(2);
  });

  it('refuses even at the database level if a handler ever tries a hard delete', async () => {
    const { seller } = await tradeInFlight('WAITING_SELLER_PAYMENT');
    // The foreign keys are RESTRICT now, so the cascade that erased the buyer's
    // record is no longer reachable, with or without the guard above.
    await expect(prisma.user.delete({ where: { id: seller.id } })).rejects.toThrow();
    expect(await prisma.deal.count()).toBe(1);
  });

  it('closes the account once trades are settled, scrubbing personal data only', async () => {
    const { seller, deal } = await tradeInFlight('COMPLETED');

    expect(await openDealsFor(seller.id)).toEqual([]);
    const result = await closeAccount('seller', 'seller');
    expect(result.ok).toBe(true);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: seller.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(after.verificationStatus).toBe('DELETED');
    expect(after.fullName).toBeNull();
    expect(after.phoneNumber).toBeNull();
    expect(after.documentFileId).toBeNull();

    // The trade itself survives, because it is also the buyer's history.
    const survivor = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(survivor).not.toBeNull();
    expect(survivor!.amount).toBe(1000);
  });

  it('records the closure in the audit trail', async () => {
    const { seller } = await tradeInFlight('COMPLETED');
    await closeAccount('seller', 'seller');

    const trail = await auditTrail('User', seller.id);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe('user.account.close');
    expect(trail[0].actor).toBe('seller');
  });
});

describeDb('deal transitions', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await wipe(); await prisma.$disconnect(); });
  beforeEach(wipe);

  it('moves a deal, sets the next deadline, and writes an audit row atomically', async () => {
    const { deal } = await tradeInFlight('PENDING_ADMIN' as any);

    const result = await transitionDeal(deal.id, { type: 'ADMIN_APPROVE' }, 'admin-1');

    expect(result.ok).toBe(true);
    const after = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
    expect(after.status).toBe('WAITING_BUYER_PAYMENT');
    expect(after.deadlineAt).toBeInstanceOf(Date);
    expect(after.deadlineAt!.getTime()).toBeGreaterThan(Date.now());

    const trail = await auditTrail('Deal', deal.id);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe('deal.admin_approve');
    expect((trail[0].after as any).status).toBe('WAITING_BUYER_PAYMENT');
  });

  it('lets only one of several concurrent taps apply the transition', async () => {
    const { deal } = await tradeInFlight('PENDING_ADMIN' as any);

    const attempts = await Promise.all(
      ['a', 'b', 'c'].map(actor => transitionDeal(deal.id, { type: 'ADMIN_APPROVE' }, actor))
    );

    expect(attempts.filter(r => r.ok)).toHaveLength(1);
    // And only one audit row, so the trail does not claim it happened three times.
    expect(await auditTrail('Deal', deal.id)).toHaveLength(1);
  });

  it('refuses a transition the lifecycle does not allow, leaving no audit row', async () => {
    const { deal } = await tradeInFlight('WAITING_SELLER_PAYMENT');

    const result = await transitionDeal(deal.id, { type: 'ADMIN_APPROVE' }, 'admin-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('EVENT_NOT_ALLOWED_HERE');
    expect(await auditTrail('Deal', deal.id)).toHaveLength(0);
  });

  it('reports a missing deal rather than throwing', async () => {
    const result = await transitionDeal(999999, { type: 'ADMIN_APPROVE' }, 'admin-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('DEAL_NOT_FOUND');
  });
});

describeDb('audit trail', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await wipe(); await prisma.$disconnect(); });
  beforeEach(wipe);

  it('rolls the audit row back with the change it describes', async () => {
    const { deal } = await tradeInFlight('PENDING_ADMIN' as any);

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.deal.update({ where: { id: deal.id }, data: { status: 'COMPLETED' } });
        await recordAudit(tx, { actor: 'admin', action: 'deal.bogus', subjectType: 'Deal', subjectId: deal.id });
        throw new Error('changed my mind');
      })
    ).rejects.toThrow('changed my mind');

    // Neither the change nor its record survives; an audit row that outlived a
    // rolled-back change would be a confident lie.
    const after = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
    expect(after.status).toBe('PENDING_ADMIN');
    expect(await auditTrail('Deal', deal.id)).toHaveLength(0);
  });
});

describeDb('rate limiting', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await wipe(); await prisma.$disconnect(); });
  beforeEach(wipe);

  it('allows a burst up to capacity then refuses with a retry hint', async () => {
    const capacity = LIMITS.createProposal.capacity;

    for (let i = 0; i < capacity; i++) {
      const r = await consume('createProposal', 'user-1');
      expect(r.allowed, `call ${i + 1} of ${capacity}`).toBe(true);
    }

    const blocked = await consume('createProposal', 'user-1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keeps one user\'s flood from affecting another', async () => {
    for (let i = 0; i < LIMITS.createProposal.capacity + 2; i++) {
      await consume('createProposal', 'noisy');
    }
    expect((await consume('createProposal', 'quiet')).allowed).toBe(true);
  });

  it('refills over time, capped at capacity', () => {
    const bucket = LIMITS.liveRates;
    const start = new Date('2026-01-01T00:00:00Z');
    const oneMinuteLater = new Date('2026-01-01T00:01:00Z');
    const muchLater = new Date('2026-01-01T01:00:00Z');

    expect(refill(0, start, oneMinuteLater, bucket)).toBeCloseTo(bucket.refillPerMinute);
    expect(refill(0, start, muchLater, bucket)).toBe(bucket.capacity);
  });
});
