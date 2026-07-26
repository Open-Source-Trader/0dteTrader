-- Underlying price at placement time, so the chart can draw a position's entry
-- line on the underlying's price scale.
ALTER TABLE "trade_orders" ADD COLUMN "underlyingPrice" DOUBLE PRECISION;
