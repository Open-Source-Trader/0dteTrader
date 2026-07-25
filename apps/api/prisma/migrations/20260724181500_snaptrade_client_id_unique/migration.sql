-- Enforce one clientId per SnapTrade credential row. Postgres treats each
-- NULL as distinct under a unique index, so this only constrains rows that
-- actually have a snaptradeClientId (SnapTrade rows) — non-SnapTrade rows
-- (snaptradeClientId IS NULL) are unaffected. Without this, the webhook
-- receiver's findFirst-by-clientId lookup could silently pick the wrong row
-- if the same clientId were ever stored twice (e.g. pasted into both the
-- live and practice fields by mistake).

DROP INDEX IF EXISTS "broker_credentials_provider_snaptrade_client_id_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "broker_credentials_provider_snaptrade_client_id_key"
  ON "broker_credentials" ("provider", "snaptradeClientId");
