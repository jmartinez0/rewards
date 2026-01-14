-- Add shop scoping to Config, Customer, LedgerEntry, DiscountRule.
-- Backfills existing rows using the first Session.shop when available.

-- 1) Config: add shop + make id autoincrement
ALTER TABLE "Config" ADD COLUMN "shop" TEXT;

UPDATE "Config"
SET "shop" = COALESCE((SELECT "shop" FROM "Session" ORDER BY "shop" LIMIT 1), 'unknown')
WHERE "shop" IS NULL;

ALTER TABLE "Config" ALTER COLUMN "shop" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Config_id_seq') THEN
    CREATE SEQUENCE "Config_id_seq";
  END IF;
END $$;

ALTER TABLE "Config" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "Config" ALTER COLUMN "id" SET DEFAULT nextval('"Config_id_seq"');
DO $$
DECLARE
  max_id BIGINT;
BEGIN
  SELECT MAX("id") INTO max_id FROM "Config";
  IF max_id IS NULL OR max_id < 1 THEN
    PERFORM setval('"Config_id_seq"', 1, false);
  ELSE
    PERFORM setval('"Config_id_seq"', max_id, true);
  END IF;
END $$;

CREATE UNIQUE INDEX "Config_shop_key" ON "Config"("shop");

-- 2) Customer: add shop + switch uniqueness to (shop, email) and (shop, shopifyCustomerId)
ALTER TABLE "Customer" ADD COLUMN "shop" TEXT;

UPDATE "Customer"
SET "shop" = COALESCE((SELECT "shop" FROM "Session" ORDER BY "shop" LIMIT 1), 'unknown')
WHERE "shop" IS NULL;

ALTER TABLE "Customer" ALTER COLUMN "shop" SET NOT NULL;

DROP INDEX IF EXISTS "Customer_email_key";
DROP INDEX IF EXISTS "Customer_shopifyCustomerId_key";

CREATE UNIQUE INDEX "Customer_shop_email_key" ON "Customer"("shop", "email");
CREATE UNIQUE INDEX "Customer_shop_shopifyCustomerId_key" ON "Customer"("shop", "shopifyCustomerId");

-- 3) LedgerEntry: add shop, backfill from Customer, index by shop
ALTER TABLE "LedgerEntry" ADD COLUMN "shop" TEXT;

UPDATE "LedgerEntry" le
SET "shop" = c."shop"
FROM "Customer" c
WHERE le."customerId" = c."id"
  AND le."shop" IS NULL;

UPDATE "LedgerEntry"
SET "shop" = COALESCE((SELECT "shop" FROM "Session" ORDER BY "shop" LIMIT 1), 'unknown')
WHERE "shop" IS NULL;

ALTER TABLE "LedgerEntry" ALTER COLUMN "shop" SET NOT NULL;

CREATE INDEX "LedgerEntry_shop_idx" ON "LedgerEntry"("shop");

-- 4) DiscountRule: add shop + switch uniqueness to (shop, minPoints)
ALTER TABLE "DiscountRule" ADD COLUMN "shop" TEXT;

UPDATE "DiscountRule"
SET "shop" = COALESCE((SELECT "shop" FROM "Session" ORDER BY "shop" LIMIT 1), 'unknown')
WHERE "shop" IS NULL;

ALTER TABLE "DiscountRule" ALTER COLUMN "shop" SET NOT NULL;

DROP INDEX IF EXISTS "DiscountRule_minPoints_key";
CREATE UNIQUE INDEX "DiscountRule_shop_minPoints_key" ON "DiscountRule"("shop", "minPoints");
