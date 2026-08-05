-- Issues #58, #60 and #91-#96 share one persistence boundary. This migration
-- is intentionally hand-written: trade_orders changes primary-key domains and
-- trade_order_executions must be remapped without losing fill history.
-- PostgreSQL DDL is transactional. Keep this multi-step key/FK/data rewrite
-- atomic so a failed guard or index build leaves the pre-migration schema
-- intact for the operator to mark rolled back, fix the data, and retry.
BEGIN;

-- ---------------------------------------------------------------------------
-- Tenant-scoped trade order identity (#92)
-- ---------------------------------------------------------------------------

DO $$
DECLARE blank_ids BIGINT;
BEGIN
  SELECT COUNT(*) INTO blank_ids FROM "trade_orders" WHERE BTRIM("id") = '';
  IF blank_ids > 0 THEN
    RAISE NOTICE 'trade_orders contains % blank legacy order ids; external ids will be NULL', blank_ids;
  END IF;
END $$;

ALTER TABLE "trade_orders"
  ADD COLUMN "internalId" UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'webull',
  ADD COLUMN "accountId" TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN "brokerOrderId" TEXT,
  ADD COLUMN "clientOrderId" TEXT;

UPDATE "trade_orders" AS orders
-- The old table did not record provider or broker-account identity. A user's
-- current provider/selected account is mutable and therefore cannot truthfully
-- scope historical rows. Keep them in an explicit immutable legacy partition.
-- Preserve non-blank external ids byte-for-byte: trimming both "x" and " x "
-- into one value would make the new unique indexes fail during deployment.
SET "provider" = 'legacy',
    "accountId" = 'legacy',
    "brokerOrderId" = CASE WHEN BTRIM(orders."id") = '' THEN NULL ELSE orders."id" END,
    "clientOrderId" = CASE WHEN BTRIM(orders."id") = '' THEN NULL ELSE orders."id" END;

ALTER TABLE "trade_order_executions" ADD COLUMN "internalOrderId" UUID;
UPDATE "trade_order_executions" AS execution
SET "internalOrderId" = orders."internalId"
FROM "trade_orders" AS orders
WHERE execution."orderId" = orders."id";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "trade_order_executions" WHERE "internalOrderId" IS NULL) THEN
    RAISE EXCEPTION 'trade_order_executions contains an orphaned legacy orderId';
  END IF;
END $$;

ALTER TABLE "trade_order_executions" ALTER COLUMN "internalOrderId" SET NOT NULL;
ALTER TABLE "trade_order_executions" DROP CONSTRAINT "trade_order_executions_orderId_fkey";
DROP INDEX "trade_order_executions_orderId_cumulative_key";
DROP INDEX "trade_order_executions_orderId_idx";
ALTER TABLE "trade_order_executions" DROP COLUMN "orderId";
ALTER TABLE "trade_order_executions" RENAME COLUMN "internalOrderId" TO "orderId";

ALTER TABLE "trade_orders" DROP CONSTRAINT "trade_orders_pkey";
ALTER TABLE "trade_orders" DROP COLUMN "id";
ALTER TABLE "trade_orders" RENAME COLUMN "internalId" TO "id";
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_pkey" PRIMARY KEY ("id");

CREATE UNIQUE INDEX "trade_orders_userId_provider_environment_accountId_brokerOrderId_key"
  ON "trade_orders"("userId", "provider", "environment", "accountId", "brokerOrderId");
CREATE UNIQUE INDEX "trade_orders_userId_provider_environment_accountId_clientOrderId_key"
  ON "trade_orders"("userId", "provider", "environment", "accountId", "clientOrderId");
CREATE UNIQUE INDEX "trade_order_executions_orderId_cumulative_key"
  ON "trade_order_executions"("orderId", "cumulative");
CREATE INDEX "trade_order_executions_orderId_idx"
  ON "trade_order_executions"("orderId");
ALTER TABLE "trade_order_executions" ADD CONSTRAINT "trade_order_executions_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "trade_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Bracket group state machine (#95)
-- ---------------------------------------------------------------------------

CREATE TABLE "bracket_groups" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "contractSymbol" TEXT NOT NULL,
  "closeSide" TEXT NOT NULL,
  "protectedQuantity" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'working',
  "fireLegId" UUID,
  "leaseOwnerId" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bracket_groups_pkey" PRIMARY KEY ("id")
);

-- Pre-existing groups did not store provider/account scope. A user's current
-- selection is mutable, so inferring it could route an armed legacy leg to the
-- wrong broker. Preserve history in a non-routable legacy scope and fail every
-- group closed; users can deliberately recreate protection after deployment.
INSERT INTO "bracket_groups" (
  "id", "userId", "provider", "environment", "accountId", "contractSymbol",
  "closeSide", "protectedQuantity", "status", "lastError", "createdAt", "updatedAt"
)
SELECT
  DISTINCT ON (orders."ocoGroupId")
  orders."ocoGroupId", orders."userId", 'legacy',
  orders."environment", 'legacy', orders."contractSymbol", orders."side",
  orders."quantity", 'closed',
  'Legacy bracket cancelled during migration because broker account scope was not recorded',
  orders."createdAt", CURRENT_TIMESTAMP
FROM "chart_orders" AS orders
WHERE orders."ocoGroupId" IS NOT NULL
ORDER BY orders."ocoGroupId", orders."createdAt", orders."id";

UPDATE "chart_orders" AS orders
SET "status" = 'cancelled',
    "lastError" = COALESCE(
      orders."lastError",
      'Legacy bracket cancelled during migration because broker account scope was not recorded'
    ),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE orders."ocoGroupId" IS NOT NULL
  AND orders."status" = 'working';

-- Ungrouped legacy protective legs are equally unscoped. They cannot be
-- attached to a trustworthy account during migration, so fail them closed as
-- well; newly armed target/stop orders persist immutable scope at creation.
UPDATE "chart_orders"
SET "status" = 'cancelled',
    "lastError" = 'Legacy protective order cancelled during scope migration: broker account could not be determined safely',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "ocoGroupId" IS NULL
  AND "kind" IN ('target', 'stop')
  AND "status" = 'working';

-- A legacy client-supplied UUID must never join tenants or incompatible
-- contracts. Keep the owner's canonical scope and detach every mismatched leg.
UPDATE "chart_orders" AS orders
SET "ocoGroupId" = NULL,
    "status" = CASE WHEN orders."status" = 'working' THEN 'cancelled' ELSE orders."status" END,
    "lastError" = COALESCE(orders."lastError", 'Detached bracket scope mismatch during migration')
FROM "bracket_groups" AS groups
WHERE orders."ocoGroupId" = groups."id"
  AND (
    orders."userId" <> groups."userId" OR
    orders."environment" <> groups."environment" OR
    orders."contractSymbol" <> groups."contractSymbol" OR
    orders."side" <> groups."closeSide"
  );

-- A database invariant replaces check-then-insert duplicate-kind validation.
-- If old data already contains duplicates, detach the newer extras rather
-- than deleting order history or preventing deployment.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "ocoGroupId", "kind" ORDER BY "createdAt", "id"
  ) AS rank
  FROM "chart_orders" WHERE "ocoGroupId" IS NOT NULL
)
UPDATE "chart_orders" AS orders
SET "ocoGroupId" = NULL,
    "status" = CASE WHEN orders."status" = 'working' THEN 'cancelled' ELSE orders."status" END,
    "lastError" = COALESCE(orders."lastError", 'Detached duplicate bracket kind during migration')
FROM ranked
WHERE orders."id" = ranked."id" AND ranked.rank > 1;

-- DISTINCT ON above chooses a canonical scope row, but not necessarily a
-- working row. Recompute group liveness after mismatched/duplicate legs have
-- been detached, then converge surviving sibling quantities to the smallest
-- protected amount so migrated brackets cannot over-close.
UPDATE "bracket_groups" AS groups
SET "status" = CASE WHEN EXISTS (
      SELECT 1 FROM "chart_orders" AS orders
      WHERE orders."ocoGroupId" = groups."id" AND orders."status" = 'working'
    ) THEN 'working' ELSE 'closed' END,
    "protectedQuantity" = COALESCE((
      SELECT MIN(orders."quantity")::INTEGER
      FROM "chart_orders" AS orders
      WHERE orders."ocoGroupId" = groups."id" AND orders."status" = 'working'
    ), groups."protectedQuantity");

UPDATE "chart_orders" AS orders
SET "quantity" = groups."protectedQuantity"
FROM "bracket_groups" AS groups
WHERE orders."ocoGroupId" = groups."id"
  AND orders."status" = 'working'
  AND orders."quantity" <> groups."protectedQuantity";

CREATE INDEX "bracket_groups_status_leaseExpiresAt_idx"
  ON "bracket_groups"("status", "leaseExpiresAt");
CREATE INDEX "bracket_groups_userId_environment_status_idx"
  ON "bracket_groups"("userId", "environment", "status");
CREATE UNIQUE INDEX "chart_orders_ocoGroupId_kind_key" ON "chart_orders"("ocoGroupId", "kind");
ALTER TABLE "bracket_groups" ADD CONSTRAINT "bracket_groups_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chart_orders" ADD CONSTRAINT "chart_orders_ocoGroupId_fkey"
  FOREIGN KEY ("ocoGroupId") REFERENCES "bracket_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Per-device push outbox and retention (#93, #96)
-- ---------------------------------------------------------------------------

-- Preserve aggregate claims as terminal tombstones. Deleting them would make
-- a provider redelivery repeat an alert that the old service already sent.
-- The application recognizes environment='legacy' when bridging old keys;
-- normal retention removes these rows after the same seven-day dedupe window.
DROP INDEX "push_deliveries_userId_key_key";
ALTER TABLE "push_deliveries"
  ADD COLUMN "deviceToken" TEXT,
  ADD COLUMN "environment" TEXT,
  ADD COLUMN "title" TEXT,
  ADD COLUMN "body" TEXT,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "leaseOwnerId" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "push_deliveries"
SET "deviceToken" = 'legacy:' || "id"::TEXT,
    "environment" = 'legacy',
    "title" = '',
    "body" = '',
    "status" = 'delivered',
    "deliveredAt" = "createdAt";

ALTER TABLE "push_deliveries"
  ALTER COLUMN "deviceToken" SET NOT NULL,
  ALTER COLUMN "environment" SET NOT NULL,
  ALTER COLUMN "title" SET NOT NULL,
  ALTER COLUMN "body" SET NOT NULL;
CREATE UNIQUE INDEX "push_deliveries_userId_key_deviceToken_key"
  ON "push_deliveries"("userId", "key", "deviceToken");
CREATE INDEX "push_deliveries_status_nextAttemptAt_leaseExpiresAt_idx"
  ON "push_deliveries"("status", "nextAttemptAt", "leaseExpiresAt");
CREATE INDEX "push_deliveries_createdAt_idx" ON "push_deliveries"("createdAt");

-- ---------------------------------------------------------------------------
-- Durable webhook inbox (#91)
-- ---------------------------------------------------------------------------

CREATE TABLE "webhook_inbox" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "webhookId" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "accountId" TEXT,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwnerId" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastError" TEXT,
  "failureStage" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "webhook_inbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "webhook_inbox_provider_webhookId_key"
  ON "webhook_inbox"("provider", "webhookId");
CREATE INDEX "webhook_inbox_status_nextAttemptAt_leaseExpiresAt_idx"
  ON "webhook_inbox"("status", "nextAttemptAt", "leaseExpiresAt");
ALTER TABLE "webhook_inbox" ADD CONSTRAINT "webhook_inbox_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Durable cross-instance event stream (#94)
-- ---------------------------------------------------------------------------

CREATE TABLE "user_events" (
  "ordinal" BIGINT NOT NULL,
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "dedupeKey" TEXT,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_events_pkey" PRIMARY KEY ("ordinal")
);
CREATE UNIQUE INDEX "user_events_id_key" ON "user_events"("id");
CREATE UNIQUE INDEX "user_events_userId_sequence_key" ON "user_events"("userId", "sequence");
CREATE UNIQUE INDEX "user_events_userId_dedupeKey_key" ON "user_events"("userId", "dedupeKey");
CREATE INDEX "user_events_userId_sequence_idx" ON "user_events"("userId", "sequence");
ALTER TABLE "user_events" ADD CONSTRAINT "user_events_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A single locked allocator row makes event ordinals follow transaction commit
-- order across API instances. Pollers may therefore advance monotonically
-- without skipping an earlier ordinal that is still waiting to commit.
CREATE TABLE "event_transport_state" (
  "name" TEXT NOT NULL,
  "nextOrdinal" BIGINT NOT NULL,
  CONSTRAINT "event_transport_state_pkey" PRIMARY KEY ("name")
);
INSERT INTO "event_transport_state" ("name", "nextOrdinal") VALUES ('global', 1);

-- ---------------------------------------------------------------------------
-- Discord notifications (#58)
-- ---------------------------------------------------------------------------

CREATE TABLE "discord_notification_settings" (
  "userId" UUID NOT NULL,
  "encWebhookUrl" BYTEA,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "includePnl" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "discord_notification_settings_pkey" PRIMARY KEY ("userId")
);
CREATE TABLE "discord_deliveries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "discord_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "discord_deliveries_userId_key_key" ON "discord_deliveries"("userId", "key");
CREATE INDEX "discord_deliveries_createdAt_idx" ON "discord_deliveries"("createdAt");
ALTER TABLE "discord_notification_settings" ADD CONSTRAINT "discord_notification_settings_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "discord_deliveries" ADD CONSTRAINT "discord_deliveries_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Versioned legal acceptance (#60)
-- ---------------------------------------------------------------------------

CREATE TABLE "legal_acceptances" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "document" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "legal_acceptances_userId_document_version_key"
  ON "legal_acceptances"("userId", "document", "version");
CREATE INDEX "legal_acceptances_userId_document_idx" ON "legal_acceptances"("userId", "document");
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
