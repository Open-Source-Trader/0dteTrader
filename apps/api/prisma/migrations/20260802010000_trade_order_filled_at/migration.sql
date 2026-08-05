-- First-execution timestamp: the broker's execution time when reported; else
-- when the fill was observed. Position.openedAt anchors here instead of the
-- placement time. Rows predating the column stay NULL — readers fall back to
-- "placedAt".
ALTER TABLE "trade_orders" ADD COLUMN "filledAt" TIMESTAMP(3);
