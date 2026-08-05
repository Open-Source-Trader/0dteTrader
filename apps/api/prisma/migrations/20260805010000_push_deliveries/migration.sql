-- Push dedupe: one row per (user, notifiable event), inserted BEFORE the APNs
-- send. The unique index is the entire atomicity story — the insert either
-- wins or raises 23505 (P2002), and only the winner sends. No transaction is
-- involved, consistent with the rest of this schema.
--
-- Needed because the in-process event buses do not cross processes and the
-- same terminal outcome legitimately reaches more than one of them: a
-- SnapTrade fill arrives as two webhook kinds load-balanced across instances,
-- and a cancel served by any instance emits a synthetic terminal status while
-- the placing instance's poll emits its own.
CREATE TABLE "push_deliveries" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_deliveries_pkey" PRIMARY KEY ("id")
);

-- userId leads the unique index, so it also serves the FK cascade — no
-- separate index on it.
CREATE UNIQUE INDEX "push_deliveries_userId_key_key" ON "push_deliveries"("userId", "key");

ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
