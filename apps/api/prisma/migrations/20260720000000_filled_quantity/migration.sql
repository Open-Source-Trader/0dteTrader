-- Broker-reported filled quantity for partial-fill accounting in trade history.
ALTER TABLE "trade_orders" ADD COLUMN "filledQuantity" DOUBLE PRECISION;
