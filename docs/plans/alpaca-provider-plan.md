# Plan: Multi-broker support — Webull ↔ Alpaca provider toggle

Status: **Phases 1–4 implemented** (multi-broker Webull + Alpaca; `DispatchingBrokerGateway` routes by `tradingProvider`; mobile selector + Alpaca forms done on iOS + desktop). Remaining: paper-account smoke test + iOS Xcode build on a Mac. Last updated: 2026-07-20

## Confirmed decisions

1. **Per-user provider.** Add `tradingProvider: 'webull' | 'alpaca'` to the `User`
   record. Each user selects their broker in Profile. Matches the existing
   per-user `credentials` + `tradingMode` pattern and the ROADMAP's
   multi-broker goal (IBKR/Tastytrade later).
2. **Encrypted JSON-blob credentials.** One generic
   `BrokerCredential { userId, provider, environment, encSecrets(Bytes) }`
   where `encSecrets` is a single AES-256-GCM blob of provider-specific fields.
   Webull → `{appKey, appSecret, accountId?}`; Alpaca → `{apiKey, apiSecret}`.
   Only Webull keeps a token row (Alpaca keys are long-lived → no token store).
3. **Phase 1 is implemented (2026-07-20).** Non-breaking: Webull remains the only
   active broker; `tradingProvider` defaults to `'webull'` for every existing user.

   What landed:
   - `User.tradingProvider` column (default `'webull'`); `BrokerCredential` /
     `BrokerApiToken` models (provider-scoped, encrypted JSON-blob secrets for
     credentials, token persistence for Webull only). Legacy `WebullCredential` /
     `WebullApiToken` tables are retained this phase as a fallback source.
   - Migration `20260720054312_phase1_broker_credential` (additive: new column +
     two tables, no drops).
   - `CredentialsService` is now provider-aware and stores
     `{provider, ...secrets}` in one AES-256-GCM blob. A `ensureMigrated` shim
     lazily copies any legacy `webull_credentials` row into `broker_credentials`
     on first read, so the change is non-breaking without a separate backfill
     run. Remove the shim once all environments are confirmed backfilled.
   - `UsersService.getMe` and `WebullTokenStore` read the provider-agnostic
     tables (with legacy fallback). The gateway passes `provider: 'webull'` to
     `getDecrypted` / `saveDiscoveredAccountId` / token `scopedTo`.
   - shared-types gained `BrokerProvider`, `BrokerSecrets`, `WebullSecrets`,
     `AlpacaSecrets`, `AlpacaCredentialsInput`, `BrokerCredentialsInput`
     (discriminated union); `WebullCredentialsInput` now carries an optional
     `provider`.
   - API tests (298) + lint pass after Phase 1.

   ### Phases 2–4 implemented (2026-07-20)
   - **Phase 2 — Alpaca gateway + dispatcher.** `AlpacaBrokerGateway` implements
     `BrokerGateway` (Basic auth, real `/v2/options/chains`, OCC parity via the
     shared `formatOccSymbol`, deterministic `client_order_id` = md5). `DispatchingBrokerGateway`
     routes every call to Webull or Alpaca by `user.tradingProvider`; registered under
     the same `BROKER_GATEWAY` token so all client endpoints stay provider-agnostic.
     `alpaca` config block added; `reauthenticate` is a no-op for Alpaca.
   - **Phase 3 — Mobile (iOS + desktop as a pair).** Provider selector (Webull | Alpaca)
     bound to `Me.tradingProvider`; Alpaca credential form writing through the generic
     `me/broker-credentials` endpoint. `PATCH /v1/me` now accepts `tradingProvider`.
   - **Phase 4 — Tests + docs.** `alpaca-broker.gateway.spec.ts`,
     `dispatching-broker.gateway.spec.ts`, `users.service` `setTradingProvider` + Alpaca
     `Me` flags; `docs/ALPACA-INTEGRATION.md` added; `openapi.yaml`, `ARCHITECTURE.md`,
     `ROADMAP.md` updated. API suite is **314 tests green**, desktop builds + lints clean.
     iOS is code-complete and **pending an Xcode build on a Mac**.

   ### Remaining before live use
   - Apply for Alpaca API keys; run a paper-account order end-to-end from the app
     (`npm run smoke:alpaca` analog to `smoke:webull`).
   - Remove the `ensureMigrated` Webull→`broker_credential` shim + drop legacy
     `webull_credential` / `webull_api_token` tables in a later cleanup migration.

## Why this is tractable

The backend already has the key seam (`BrokerGateway` interface +
`BROKER_GATEWAY` injection token). `trading/trading.service.ts`,
`market-data/*`, and `broker/webull-session.controller.ts` depend only on the
interface. Provider-agnostic math (`contract-resolution`, `expiration-calendar`,
`order-events.service`, `candle-aggregation`) is reused as-is. Alpaca is
_simpler_ than Webull: no HMAC signer, no token lifecycle/SMS-2FA, no
account-id discovery, and a **real options-chain endpoint** (kills the
strike-grid probe hack).

## Target shape

```ts
// broker-gateway.interface.ts (unchanged signature, 9 methods)
interface BrokerGateway { /* getQuote, getCandles, getOptionsChain,
  previewOrder, placeOrder, cancelOrder, getPositions, getOpenOrders,
  reauthenticate */ }

// broker.module.ts — factory resolves (provider, mode) from the user
gatewayFor(userId): BrokerGateway  // webull | alpaca

// prisma
model User { /* ... */ tradingProvider String @default("webull") }
model BrokerCredential {
  userId String; provider String; environment String;
  encSecrets Bytes;            // AES-256-GCM of {appKey,appSecret,...}
  @@unique([userId, provider, environment])
}
model BrokerApiToken {        // Webull only (token persistence)
  userId String; provider String; environment String;
  encToken Bytes; expiresAt DateTime; status String;
  @@unique([userId, provider, environment])
}
```

## Phase 1 — Provider abstraction (non-breaking; Webull still the only active impl)

Goal: introduce the provider field + generic credential store + factory
dispatch. Webull keeps working with zero behavior change.

- `prisma/schema.prisma`
  - Add `tradingProvider String @default("webull")` to `User`.
  - Add `BrokerCredential` + `BrokerApiToken` models (above).
  - Keep `WebullCredential` / `WebullApiToken` for the backfill migration (or
    rename in the same migration).
- New migration
  - Add `tradingProvider` column default `'webull'` on `users`.
  - Create `broker_credential` / `broker_api_token`.
  - Backfill: for each `webull_credential` row, encrypt
    `{appKey, appSecret, accountId}` → `encSecrets` and insert a
    `broker_credential` (`provider='webull'`); copy tokens to
    `broker_api_token` (`provider='webull'`).
  - Drop `webull_credential` / `webull_api_token` (after backfill). Zero data loss.
- `packages/shared-types/src/index.ts`
  - Add `export type BrokerProvider = 'webull' | 'alpaca'`.
  - Add discriminated `BrokerCredentialsInput` (e.g.
    `{ provider: 'webull'; appKey; appSecret; accountId?; environment? } |
 { provider: 'alpaca'; apiKey; apiSecret; environment? }`).
  - Make `Me` provider-aware: `brokerConfigured: Record<BrokerProvider,
{ live: boolean; practice: boolean; accountId: string | null }>`.
  - Keep `Webull*` types as `@deprecated` aliases during the transition.
- `credentials/credentials.service.ts` → provider-aware API
  - `getDecrypted(userId, provider, environment)`,
    `save(userId, provider, secrets, environment)`,
    `saveDiscoveredAccountId(userId, provider, environment, accountId)` (Webull only),
    `remove(userId, provider, environment)`. Keep `CryptoService` (encrypt/decrypt
    the JSON blob).
- `broker/broker.module.ts`
  - Factory reads `tradingProvider` + `tradingMode` from the user, then builds
    the matching gateway. In Phase 1 only Webull is registered; Alpaca added in
    Phase 2.
- `users/users.service.ts`
  - Read `tradingProvider`; compute `brokerConfigured` map from `broker_credential`.
- `test/in-memory-prisma.service.ts`
  - Add `brokerCredential` / `brokerApiToken` mock collections.

## Phase 2 — AlpacaBrokerGateway

- `broker/alpaca/alpaca-broker.gateway.ts` — implements `BrokerGateway`.
- `broker/alpaca/alpaca-client.ts` — HTTP client, Basic `key:secret` auth,
  10s timeout, 429→backoff (no signer, no token refresh).
- `broker/alpaca/alpaca-endpoints.ts` — hosts, paths, order builder
  (`client_order_id` = md5 of idempotency key, mirroring Webull), parsers.
  Confirm exact shapes against Alpaca docs/live:
  - Trading: `https://api.alpaca.markets` (live) /
    `https://paper-api.alpaca.markets` (practice);
    `/v2/orders`, `/v2/positions`, `/v2/account`.
  - Market data: `/v2/stocks/.../bars`, `/v2/stocks/snapshots`,
    `/v2/options/chains?symbol=…`, `/v2/options/.../snapshots`
    (note paper vs live data host separation).
  - Options chain: real `/v2/options/chains` — replace Webull's probe.
- `broker/alpaca/alpaca-mappers.ts` — response → DTO (OCC symbol parity with
  Webull mappers).
- `config/configuration.ts` — add `alpaca` block (base urls: live/paper trading
  - data; no server key — keys are per-user). `reauthenticate` is a no-op for
    Alpaca (keys never expire) but must still satisfy the interface.
- `broker.module.ts` — register both gateway factories; dispatch on
  `tradingProvider`.
- `broker/webull-session.controller.ts` → generic `POST /me/broker-session/refresh`
  (rename `WebullSessionController` → `BrokerSessionController`; `reauthenticate`
  delegates to the user's provider gateway).

## Phase 3 — Mobile UI (iOS + desktop built as a pair per AGENTS.md)

- iOS: `ProfileView` gets a provider selector (Webull/Alpaca); `WebullCredentialsForm`
  → provider-aware form (Webull: appKey/appSecret; Alpaca: apiKey/apiSecret);
  `ProfileViewModel` + `APIClient` methods become generic
  (`putBrokerCredentials(provider, …)`, `deleteBrokerCredentials(provider, …)`,
  `refreshBrokerSession()`); DTOs updated.
- Desktop: `ProfileStore` + `ApiClient` mirror the same changes.
- Build iOS (XcodeGen + xcodebuild) and Electron together; keep parity.

## Phase 4 — Tests + docs

- Specs: Alpaca gateway mapping (mocked fetch), factory dispatch by provider,
  credentials round-trip (encrypt→decrypt blob), `users.service` `Me` map.
- `docs/openapi.yaml`: generic `/me/broker-credentials` (PUT/DELETE with
  `provider`) + `/me/broker-session/refresh`; deprecate `webull-*` paths.
- `docs/ARCHITECTURE.md`: update module table + data model (BrokerCredential).
- New `docs/ALPACA-INTEGRATION.md` (capability map, hosts, auth, gotchas)
  mirroring `docs/WEBULL-INTEGRATION.md`.
- `docs/ROADMAP.md`: mark multi-broker abstraction in progress.

## Risks / gotchas

- **Alpaca data host split**: paper data (`paper-data.alpaca.markets`) vs live
  (`data.alpaca.markets`); confirm with the user's key which applies.
- **Options data subscription**: Alpaca may require an options data entitlement
  for option bars/snapshots — verify in the paper account.
- **OCC symbol parity**: ensure Alpaca OCC formatting matches `webull-mappers`
  so `OrderRequest`/chains translate cleanly.
- **Order semantics**: `mid`→`LIMIT` at mid, `market`→`MARKET`; 0DTE supported;
  idempotency via `client_order_id` (md5 of key) — mirror Webull exactly.
- **Migration safety**: keep Webull fully working during backfill; verify
  `getMe`/`getDecrypted` return identical data post-migration before dropping
  old tables.

## Verification

- `npm run test` (API Jest + desktop Vitest) and `npm run lint` per workspace.
- Unit: gateway mapping (mocked HTTP), factory dispatch, credentials round-trip.
- `xcodebuild test` for iOS.
- Add `npm run smoke:alpaca` (paper-account e2e) analogous to `smoke:webull`;
  run end-to-end order from the app on paper before any live use.
