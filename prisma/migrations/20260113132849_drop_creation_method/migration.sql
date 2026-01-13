/*
  Warnings:

  - You are about to drop the column `creationMethod` on the `RewardsLedgerEntry` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "RewardsLedgerEntry" DROP COLUMN "creationMethod";

-- DropEnum
DROP TYPE "CreationMethod";
