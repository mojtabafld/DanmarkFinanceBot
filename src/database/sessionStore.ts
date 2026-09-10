import { prisma } from './db';

/**
 * A Telegraf session store backed by the same PostgreSQL database as the rest of the
 * bot. The default `session()` store keeps state in process memory, so every restart
 * or redeploy silently dropped users in the middle of KYC, ad creation, or a deal,
 * and made it impossible to run more than one instance.
 */
export function createPrismaSessionStore<T>() {
  return {
    async get(key: string): Promise<T | undefined> {
      const row = await prisma.session.findUnique({ where: { key } });
      return row ? (row.data as T) : undefined;
    },

    async set(key: string, value: T): Promise<void> {
      const data = value as object;
      await prisma.session.upsert({
        where: { key },
        update: { data },
        create: { key, data }
      });
    },

    async delete(key: string): Promise<void> {
      await prisma.session.deleteMany({ where: { key } });
    }
  };
}

/**
 * Removes session rows untouched for longer than `maxAgeHours`. Abandoned wizard
 * state would otherwise accumulate forever.
 */
export async function pruneStaleSessions(maxAgeHours = 48): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
  const result = await prisma.session.deleteMany({
    where: { updatedAt: { lt: cutoff } }
  });
  return result.count;
}
