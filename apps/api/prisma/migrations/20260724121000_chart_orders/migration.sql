-- Chart trading: resting order lines watched against the underlying's price.
-- The broker never sees these; a crossing fires an ordinary mid/market order.
CREATE TABLE "chart_orders" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'live',
    "underlying" TEXT NOT NULL,
    "triggerPrice" DOUBLE PRECISION NOT NULL,
    "armPrice" DOUBLE PRECISION NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "orderType" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "optionType" TEXT NOT NULL,
    "expiration" TEXT NOT NULL,
    "strike" DOUBLE PRECISION NOT NULL,
    "contractSymbol" TEXT NOT NULL,
    "ocoGroupId" UUID,
    "status" TEXT NOT NULL DEFAULT 'working',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "triggeredAt" TIMESTAMP(3),
    "brokerOrderId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chart_orders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chart_orders_userId_status_idx" ON "chart_orders"("userId", "status");

-- The watcher's sweep: every working line, grouped by what it must quote.
CREATE INDEX "chart_orders_status_environment_underlying_idx"
    ON "chart_orders"("status", "environment", "underlying");

CREATE INDEX "chart_orders_ocoGroupId_idx" ON "chart_orders"("ocoGroupId");

ALTER TABLE "chart_orders" ADD CONSTRAINT "chart_orders_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
