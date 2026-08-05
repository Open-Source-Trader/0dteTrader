-- Cumulative execution watermark, advanced only by compare-and-set so that
-- concurrent recorders (webhook + poller, across API instances) each claim a
-- disjoint fill increment. Independent of `status`: deriving the watermark
-- from status let a stale status regression double-record fills.
ALTER TABLE "trade_orders" ADD COLUMN "executedQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Backfill: a row whose fill state carries a price has genuinely executed its
-- reported quantity. Price-gated deliberately: a priceless partially_filled
-- row (SnapTrade can report quantity without price) must keep watermark 0 so
-- its later PRICED re-report still advances and records the increment.
UPDATE "trade_orders"
SET "executedQuantity" = CASE
  WHEN "filledPrice" IS NOT NULL THEN COALESCE("filledQuantity", "quantity")
  ELSE 0
END;

-- The cumulative snapshot each recorded increment claimed (the watermark
-- value AFTER the increment). Nullable: rows predating the column — and
-- inserts from not-yet-upgraded instances during a rolling deploy — carry
-- NULL, which Postgres treats as distinct under a unique index.
ALTER TABLE "trade_order_executions" ADD COLUMN "cumulative" DOUBLE PRECISION;

-- Backfill as the per-order running sum in replay order. Strictly increasing
-- within an order (every recorded delta is positive), so the unique index
-- below can be created over the backfilled values.
UPDATE "trade_order_executions" AS e
SET "cumulative" = s.running
FROM (
  SELECT "id",
         SUM("quantity") OVER (
           PARTITION BY "orderId"
           ORDER BY "executedAt", "createdAt", "id"
         ) AS running
  FROM "trade_order_executions"
) AS s
WHERE e."id" = s."id";

-- Idempotency belt for the execution insert: at most one recorded increment
-- per (order, cumulative-snapshot).
CREATE UNIQUE INDEX "trade_order_executions_orderId_cumulative_key"
  ON "trade_order_executions"("orderId", "cumulative");
