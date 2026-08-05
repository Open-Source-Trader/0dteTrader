-- Individual broker executions (fill increments) per order. The order row
-- keeps only cumulative fill state, which loses how partial fills interleave
-- across orders; the position replay orders by these instead. Rows predating
-- the table are replayed from the order's cumulative state.
CREATE TABLE "trade_order_executions" (
    "id" UUID NOT NULL,
    "orderId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "executedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_order_executions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "trade_order_executions_orderId_idx" ON "trade_order_executions"("orderId");

ALTER TABLE "trade_order_executions" ADD CONSTRAINT "trade_order_executions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "trade_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
