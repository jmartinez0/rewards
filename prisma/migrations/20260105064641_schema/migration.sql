-- CreateEnum
CREATE TYPE "RewardsLedgerType" AS ENUM ('EARN', 'SPEND', 'ADJUST', 'EXPIRE');

-- CreateEnum
CREATE TYPE "RewardsLedgerSource" AS ENUM ('AUTO', 'MANUAL');

-- CreateTable
CREATE TABLE "RewardsConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "pointsPerDollar" INTEGER NOT NULL DEFAULT 20,
    "pointsExpirationDays" INTEGER,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardsConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardsCustomer" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "shopifyCustomerId" TEXT,
    "currentPoints" INTEGER NOT NULL DEFAULT 0,
    "lifetimePoints" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardsCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardsLedgerEntry" (
    "id" SERIAL NOT NULL,
    "rewardsCustomerId" INTEGER NOT NULL,
    "type" "RewardsLedgerType" NOT NULL,
    "pointsDelta" INTEGER NOT NULL,
    "remainingPoints" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "orderId" TEXT,
    "sourceLotId" INTEGER,
    "source" "RewardsLedgerSource" NOT NULL DEFAULT 'AUTO',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardsLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RewardsCustomer_email_key" ON "RewardsCustomer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RewardsCustomer_shopifyCustomerId_key" ON "RewardsCustomer"("shopifyCustomerId");

-- AddForeignKey
ALTER TABLE "RewardsLedgerEntry" ADD CONSTRAINT "RewardsLedgerEntry_rewardsCustomerId_fkey" FOREIGN KEY ("rewardsCustomerId") REFERENCES "RewardsCustomer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardsLedgerEntry" ADD CONSTRAINT "RewardsLedgerEntry_sourceLotId_fkey" FOREIGN KEY ("sourceLotId") REFERENCES "RewardsLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
