-- Additive: broker_connections table for SnapTrade OAuth connections
-- (and future providers). No existing rows are touched.

CREATE TABLE IF NOT EXISTS "broker_connections" (
  "id"            TEXT    NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"        UUID    NOT NULL,
  "provider"      TEXT    NOT NULL DEFAULT 'snaptrade',
  "connectionId"  TEXT    NOT NULL,
  "accountIds"    TEXT[]  NOT NULL DEFAULT '{}',
  "selectedAccountId" TEXT,
  "status"        TEXT    NOT NULL DEFAULT 'active',
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "broker_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "broker_connections_user_id_provider_key"
  ON "broker_connections" ("userId", "provider");

CREATE INDEX IF NOT EXISTS "broker_connections_user_id_idx"
  ON "broker_connections" ("userId");

ALTER TABLE "broker_connections"
  ADD CONSTRAINT "broker_connections_user_id_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Trigger to auto-update updatedAt (mirrors the Prisma @updatedAt behavior
-- for raw SQL inserts/updates that bypass the ORM).
CREATE OR REPLACE FUNCTION set_broker_connections_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS broker_connections_updated_at ON "broker_connections";
CREATE TRIGGER broker_connections_updated_at
  BEFORE UPDATE ON "broker_connections"
  FOR EACH ROW EXECUTE FUNCTION set_broker_connections_updated_at();
