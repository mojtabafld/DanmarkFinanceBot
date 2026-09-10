import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../../src/database/db';
import { createPrismaSessionStore, pruneStaleSessions } from '../../src/database/sessionStore';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('Prisma session store', () => {
  const store = createPrismaSessionStore<{ step: number; note?: string }>();

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.session.deleteMany();
  });

  afterAll(async () => {
    await prisma.session.deleteMany();
    await prisma.$disconnect();
  });

  it('returns undefined for a key it has never seen', async () => {
    expect(await store.get('missing')).toBeUndefined();
  });

  it('round-trips wizard state across a simulated restart', async () => {
    await store.set('user:1', { step: 3, note: 'مرحله سوم' });

    // A fresh store instance stands in for a new process after a redeploy.
    const afterRestart = createPrismaSessionStore<{ step: number; note?: string }>();
    expect(await afterRestart.get('user:1')).toEqual({ step: 3, note: 'مرحله سوم' });
  });

  it('overwrites existing state rather than erroring', async () => {
    await store.set('user:2', { step: 1 });
    await store.set('user:2', { step: 2 });
    expect(await store.get('user:2')).toEqual({ step: 2 });
  });

  it('deletes state and tolerates deleting a missing key', async () => {
    await store.set('user:3', { step: 9 });
    await store.delete('user:3');
    expect(await store.get('user:3')).toBeUndefined();
    await expect(store.delete('user:3')).resolves.toBeUndefined();
  });

  it('prunes only sessions older than the cutoff', async () => {
    await store.set('fresh', { step: 1 });
    await store.set('stale', { step: 1 });
    await prisma.session.update({
      where: { key: 'stale' },
      data: { updatedAt: new Date(Date.now() - 72 * 60 * 60 * 1000) }
    });

    const removed = await pruneStaleSessions(48);

    expect(removed).toBe(1);
    expect(await store.get('stale')).toBeUndefined();
    expect(await store.get('fresh')).toEqual({ step: 1 });
  });
});
