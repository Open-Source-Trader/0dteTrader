-- BrokerConnection becomes environment-scoped: a user can have an
-- independent live and practice connection instead of exactly one
-- connection total. Existing rows are assumed 'live' — that was the
-- implicit behavior before this migration (the connection service always
-- operated on the user's global tradingMode with no per-environment
-- distinction), so this preserves current state for existing users rather
-- than guessing which environment they meant.

ALTER TABLE "broker_connections"
  ADD COLUMN IF NOT EXISTS "environment" TEXT NOT NULL DEFAULT 'live';

DROP INDEX IF EXISTS "broker_connections_user_id_provider_key";

CREATE UNIQUE INDEX IF NOT EXISTS "broker_connections_user_id_provider_environment_key"
  ON "broker_connections" ("userId", "provider", "environment");
