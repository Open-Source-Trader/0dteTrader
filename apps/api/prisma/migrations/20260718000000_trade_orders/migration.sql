-- CreateTable
CREATE TABLE "trade_orders" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "contractSymbol" TEXT NOT NULL,
    "assetClass" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "orderType" TEXT NOT NULL,
    "limitPrice" DOUBLE PRECISION,
    "filledPrice" DOUBLE PRECISION,
    "status" TEXT NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trade_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trade_orders_userId_placedAt_idx" ON "trade_orders"("userId", "placedAt");

-- AddForeignKey
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
