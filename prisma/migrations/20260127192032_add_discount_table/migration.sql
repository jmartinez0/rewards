-- CreateTable
CREATE TABLE "Discount" (
    "id" SERIAL NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "automaticDiscountNodeId" TEXT NOT NULL,
    "discountTitle" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Discount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Discount_shopifyCustomerId_key" ON "Discount"("shopifyCustomerId");
