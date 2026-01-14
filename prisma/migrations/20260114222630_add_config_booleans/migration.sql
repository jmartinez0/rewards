-- AlterTable
ALTER TABLE "Config" ADD COLUMN     "addedPointSpendBlock" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "addedPointsEarnedBanner" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "configuredDiscountRule" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "configuredPointsPerDollar" BOOLEAN NOT NULL DEFAULT false;
