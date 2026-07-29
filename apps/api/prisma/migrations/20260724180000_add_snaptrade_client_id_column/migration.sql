-- Additive: plaintext SnapTrade client ID column on broker_credentials.
-- Not a secret on its own (the consumerKey is) — lets the SnapTrade webhook
-- receiver resolve which app user a `clientId` in an inbound webhook
-- payload belongs to via an indexed lookup, instead of decrypting every
-- stored SnapTrade credential row on every webhook.

ALTER TABLE "broker_credentials"
  ADD COLUMN IF NOT EXISTS "snaptradeClientId" TEXT;

CREATE INDEX IF NOT EXISTS "broker_credentials_provider_snaptrade_client_id_idx"
  ON "broker_credentials" ("provider", "snaptradeClientId");
