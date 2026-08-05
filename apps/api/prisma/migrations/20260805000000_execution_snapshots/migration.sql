-- Execution rows become OBSERVATIONS of the order's cumulative fill state
-- (cumulative quantity + the broker's cumulative average price) rather than
-- pre-derived increments. At write time only the observation is
-- knowable-correct: a LOWER cumulative can still arrive later (a delayed
-- webhook, an out-of-order poll), and an increment derived against the wrong
-- neighbour stays wrong forever. Increments are now derived at read time from
-- consecutive observations.
ALTER TABLE "trade_order_executions" ADD COLUMN "avgPrice" DOUBLE PRECISION;

-- The pre-derived increment columns stay for the rows that already carry them
-- and stop being written for new ones. Deliberately NOT backfilling avgPrice:
-- the running prefix a backfill would compute is exactly what the replay
-- reconstructs for those rows anyway, and computing it here would bake in a
-- wrong value for any order whose increments are incomplete (an insert that
-- failed after the watermark advanced) with no way to tell afterwards.
ALTER TABLE "trade_order_executions" ALTER COLUMN "quantity" DROP NOT NULL;
ALTER TABLE "trade_order_executions" ALTER COLUMN "price" DROP NOT NULL;
