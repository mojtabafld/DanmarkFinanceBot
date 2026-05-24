import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

// Optional: clean up database connections on application shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});
