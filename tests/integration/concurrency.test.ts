import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

/**
 * These exercise real database behaviour and are skipped unless DATABASE_URL points
 * at a disposable PostgreSQL instance:
 *
 *   DATABASE_URL=postgresql://... npx prisma migrate deploy && npm test
 */
const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const prisma = new PrismaClient();

describeDb('proposal amount claiming', () => {
  let creatorId: number;
  let acceptorIds: number[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.counterOffer.deleteMany();
    await prisma.deal.deleteMany();
    await prisma.proposal.deleteMany();
    await prisma.user.deleteMany();

    const creator = await prisma.user.create({
      data: { telegramId: 'creator', firstName: 'Creator', verificationStatus: 'APPROVED' }
    });
    creatorId = creator.id;

    acceptorIds = [];
    for (let i = 0; i < 5; i++) {
      const u = await prisma.user.create({
        data: { telegramId: `acceptor-${i}`, firstName: `A${i}`, verificationStatus: 'APPROVED' }
      });
      acceptorIds.push(u.id);
    }
  });

  /** Mirrors the conditional decrement the deal paths now run. */
  async function claim(proposalId: number, amount: number): Promise<boolean> {
    const result = await prisma.proposal.updateMany({
      where: { id: proposalId, status: 'PENDING', amount: { gte: amount } },
      data: { amount: { decrement: amount } }
    });
    return result.count === 1;
  }

  it('never lets concurrent acceptances oversell an ad', async () => {
    const proposal = await prisma.proposal.create({
      data: {
        creatorId,
        type: 'SELL',
        currency: 'DKK',
        amount: 100,
        originalAmount: 100,
        price: 5000,
        priceCurrency: 'تومان',
        status: 'PENDING'
      }
    });

    // Five racers each want 30 of the 100 available. At most three can win.
    const results = await Promise.all(
      acceptorIds.map(() => claim(proposal.id, 30))
    );

    const winners = results.filter(Boolean).length;
    const after = await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } });

    expect(winners).toBe(3);
    expect(after.amount).toBe(100 - winners * 30);
    expect(after.amount).toBeGreaterThanOrEqual(0);
  });

  it('refuses a claim larger than the remaining amount', async () => {
    const proposal = await prisma.proposal.create({
      data: {
        creatorId,
        type: 'BUY',
        currency: 'EUR',
        amount: 10,
        originalAmount: 10,
        price: 60000,
        priceCurrency: 'تومان',
        status: 'PENDING'
      }
    });

    expect(await claim(proposal.id, 11)).toBe(false);
    const after = await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(after.amount).toBe(10);
  });

  it('refuses any claim once the ad is no longer PENDING', async () => {
    const proposal = await prisma.proposal.create({
      data: {
        creatorId,
        type: 'SELL',
        currency: 'USD',
        amount: 50,
        originalAmount: 50,
        price: 70000,
        priceCurrency: 'تومان',
        status: 'LOCKED'
      }
    });

    expect(await claim(proposal.id, 1)).toBe(false);
  });

  it('lets only one racer accept a given counter offer', async () => {
    const proposal = await prisma.proposal.create({
      data: {
        creatorId,
        type: 'SELL',
        currency: 'DKK',
        amount: 100,
        originalAmount: 100,
        price: 5000,
        priceCurrency: 'تومان',
        status: 'PENDING'
      }
    });

    const offer = await prisma.counterOffer.create({
      data: { proposalId: proposal.id, proposerId: acceptorIds[0], price: 4900, amount: 10 }
    });

    const attempts = await Promise.all(
      [0, 1, 2].map(async () => {
        const r = await prisma.counterOffer.updateMany({
          where: { id: offer.id, status: 'PENDING' },
          data: { status: 'ACCEPTED' }
        });
        return r.count === 1;
      })
    );

    expect(attempts.filter(Boolean)).toHaveLength(1);
  });
});
