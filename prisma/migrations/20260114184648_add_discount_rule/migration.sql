/*
  Warnings:

  - You are about to drop the `RewardsConfig` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `RewardsCustomer` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `RewardsLedgerEntry` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "RewardsLedgerEntry" DROP CONSTRAINT "RewardsLedgerEntry_rewardsCustomerId_fkey";

-- DropForeignKey
ALTER TABLE "RewardsLedgerEntry" DROP CONSTRAINT "RewardsLedgerEntry_sourceLotId_fkey";

-- DropTable
DROP TABLE "RewardsConfig";

-- DropTable
DROP TABLE "RewardsCustomer";

-- DropTable
DROP TABLE "RewardsLedgerEntry";

-- CreateTable
CREATE TABLE "Config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "pointsPerDollar" INTEGER NOT NULL DEFAULT 20,
    "pointsExpirationDays" INTEGER,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shopifyCustomerId" TEXT,
    "currentPoints" INTEGER NOT NULL DEFAULT 0,
    "lifetimePoints" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "type" "LedgerType" NOT NULL,
    "pointsDelta" INTEGER NOT NULL,
    "remainingPoints" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "orderId" TEXT,
    "sourceLotId" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountRule" (
    "id" SERIAL NOT NULL,
    "minPoints" INTEGER NOT NULL,
    "percentOff" INTEGER NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_shopifyCustomerId_key" ON "Customer"("shopifyCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountRule_minPoints_key" ON "DiscountRule"("minPoints");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_sourceLotId_fkey" FOREIGN KEY ("sourceLotId") REFERENCES "LedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
