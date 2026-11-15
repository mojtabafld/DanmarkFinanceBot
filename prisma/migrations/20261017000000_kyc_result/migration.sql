-- Last face-scan KYC result applied to the user (see schema.prisma).
ALTER TABLE "User" ADD COLUMN "kycResult" TEXT;
