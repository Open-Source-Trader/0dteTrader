# WEBULL INTEGRATION — 0dteTrader

## 1. Source of Truth

Official Webull OpenAPI: https://developer.webull.com/apis/docs/ (apply for developer credentials;
review typically 1–2 business days). Per-user credentials: app key, app secret, account ID.

> **Status:** P4 is implemented — `WebullBrokerGateway` + `apps/api/src/broker/webull/` (signer,
> client, endpoints, mappers). Request signing is verified against the official docs test vector;
> response field shapes are marked per-entry as verified (seen in official SDK source or docs) or
> best-effort (see §8). Webull has **no option-chain discovery endpoint**, so chains are
> synthesized from snapshot probes of a strike grid. All endpoint paths and order payloads live in
> `webull-endpoints.ts` (single mapping file) so corrections are localized; response→DTO
> translation lives in `webull-mappers.ts`. The sandbox smoke script
> (`npm run smoke:webull`, see docs/RUNBOOK.md) is the live-verification vehicle.

## 2. Capability Mapping

| 0dteTrader need | Webull OpenAPI capability | Confidence |
|---|---|---|
| User auth to broker | `POST /openapi/auth/token/create` (+ `/refresh`, `/check`), app key/secret signed; token cached, refreshed before expiry | verified (SDK + docs) |
| Quotes | Snapshot endpoints: `GET /openapi/market-data/{stock,option,futures}/snapshot` | verified (SDK); option snapshot by OCC symbol |
| Live streaming | MQTT/gRPC per docs — v1 polls REST at 1s; streaming upgrade is future work | verified it exists, not implemented |
| Candles | Bars endpoints: `GET /openapi/market-data/{stock,option,futures}/bars` (timespan M1/M5/M15/M60/D) | verified (SDK) |
| Options chain | **Does not exist in the official API** — chains synthesized by probing option snapshots (§8) | best-effort |
| Futures contracts | `GET /openapi/instrument/futures/by-code` (code + contract_type=MONTHLY) | verified path (SDK); response fields best-effort |
| Place/cancel order | Unified endpoints: `POST /openapi/trade/order/{preview,place,replace,cancel}` + `GET /openapi/trade/order/{open,detail}` | verified (changelog + SDK + trade-api guides) |
| Positions/account | `GET /openapi/assets/{positions,balance}`, `GET /openapi/account/list` | verified (SDK + docs); response fields per mappers |

## 3. Rate Limits & Quotas

- Respect the per-app and per-account rate limits in the OpenAPI docs; the backend centralizes all
  Webull calls behind `WebullClient` so throttling/backoff (429 → exponential backoff with jitter,
  honoring `Retry-After`) lives in one place.
- Published limits seen so far: `token/create` 10 req/30 s; `positions` 2 req/2 s; bars 60 req/min.
  Others are unpublished — treat as ~60 req/min.
- Quote fan-out: the WS gateway subscribes once per symbol per process, not once per client.

## 4. MockBrokerGateway Contract

`MockBrokerGateway` implements the same `BrokerGateway` interface with deterministic behavior:

- Price model: random walk seeded per symbol (stable within a process run), 1-second tick.
- Chains: synthetic strikes at standard increments around the underlying price ($1-wide for
  underlyings < $250, $5-wide above), expirations: today (0DTE), +1d, weekly +7d, monthly.
- Futures: synthetic front/deferred months for ES/MES/NQ/MNQ/CL/GC roots.
- Orders: `market` fills immediately at last; `mid` fills at mid after a 200 ms delay;
  cancel transitions to `cancelled`. Positions update accordingly.
- Buying power: fixed $25,000 per mock user.

This keeps the entire app demoable and all tests deterministic without any Webull account.

## 5. Paper vs Live

Trading mode is a **per-user server-side setting** (`users.tradingMode`,
`'live'` | `'practice'`, default `'live'`), switched via `PATCH /v1/me`. The
broker gateway reads it from the DB on every client resolution — there are no
per-request headers and no JWT changes.

- **Dual credential sets.** Each user can store one Webull credential set per
  environment (`webull_credentials` is keyed on `(userId, environment)`), both
  AES-256-GCM encrypted at rest. Practice mode uses the stored practice set;
  if none exists it falls back to the server's built-in practice app
  credentials (`WEBULL_PRACTICE_APP_KEY` / `WEBULL_PRACTICE_APP_SECRET` /
  `WEBULL_PRACTICE_ACCOUNT_ID`). Live mode has no fallback — live credentials
  must be stored per user.
- **Hosts per mode.** Practice targets the sandbox hosts
  (`https://api.sandbox.webull.com` / `https://data-api.sandbox.webull.com`),
  overridable via `WEBULL_API_BASE_URL` / `WEBULL_MARKET_DATA_BASE_URL`. Live
  targets the production hosts (`https://api.webull.com` /
  `https://data-api.webull.com`), overridable via
  `WEBULL_LIVE_API_BASE_URL` / `WEBULL_LIVE_MARKET_DATA_BASE_URL`. Sandbox and
  production are fully isolated (§7): separate app keys, separate accounts.
  The HMAC signer keys its algorithm off the request host, so it stays
  correct in both modes without changes.
- **Clients are cached per `(userId, mode)`** and rebuilt when the relevant
  credential set changes, so switching modes never crosses accounts.
- **Orders are stamped** with the environment in effect when recorded
  (`trade_orders.environment`), keeping paper and real fills separable in
  trade history.
- The mock gateway (`BROKER_GATEWAY=mock`) is mode-agnostic and unchanged.

## 6. Error Mapping

| Webull condition | API error code |
|---|---|
| Invalid/expired app credentials | `BROKER_AUTH_FAILED` (401 to app prompts re-entry of creds) |
| Insufficient buying power | `INSUFFICIENT_BUYING_POWER` (400) |
| Rejected order | `ORDER_REJECTED` (400, message passthrough sanitized) |
| Rate limited | `BROKER_RATE_LIMITED` (503, retry-after) |
| Market closed / halts | `MARKET_CLOSED` (400) |
| Timeout / network failure | `BROKER_UNAVAILABLE` (503) |

Observed live: sandbox error bodies use `error_code` (e.g. `UNAUTHORIZED`), not `code`; the
client accepts both (`message`/`msg` likewise). Business errors arrive as HTTP 417 with codes like
`OPENAPI_NO_NIGHT_TRADING_TIME`; mapping is by substring match on code+message in one place
(`WebullClient.mapError` in `webull-client.ts`), with message passthrough sanitized
(single line, ≤ 200 chars).

## 7. Environments

Sandbox and production are **fully isolated** — separate portals, separate App Keys, separate
accounts; production keys get 401 `UNAUTHORIZED` on sandbox hosts.

| | Production | Sandbox (paper) |
|---|---|---|
| Trading/account API | `https://api.webull.com` | `https://api.sandbox.webull.com` |
| Market data streaming | `data-api.webull.com` | `data-api.sandbox.webull.com` |
| Portal | webull.com → Developer Tool | `portal.sandbox.webull.com/center` |
| App approval | manual review, 1–2 business days | automatic, minutes |
| Signature algorithm | HMAC-SHA1 + MD5 body hash (legacy host) | HMAC-SHA256 + SHA-256 body hash |
| First token creation | SMS approval in the Webull app | `NORMAL` immediately, no 2FA |

**Verified against live (2026-07-18):**
- `data-api.webull.com` can hang (connection never completes); `api.webull.com` serves the
  same `/openapi/market-data/*` paths. Set `WEBULL_MARKET_DATA_BASE_URL=https://api.webull.com`
  in that case — the signer keys its algorithm off the request host, so it stays correct.
- Option and futures **bars** endpoints require `symbols` (plural); singular `symbol` returns
  400 "Parameters not valid". Stock bars accept `symbol`.
- Quote access is an app-level entitlement: stock / `US_OPTION` / `US_FUTURES` quotes each
  need a subscription in the OpenAPI console, else 401 "Insufficient permission, please
  subscribe to … quotes" (surfaced by the API as `BROKER_PERMISSION_DENIED`, HTTP 403).
- New access tokens start `PENDING` (approval in the Webull app) but still serve API calls.

Sandbox credential creation steps live in docs/RUNBOOK.md ("Getting sandbox credentials").

## 8. P4 Implementation (as built)

All Webull knowledge lives in `apps/api/src/broker/webull/` plus the gateway; nothing outside
depends on Webull payload shapes.

| File | Responsibility |
|---|---|
| `webull-signer.ts` | Per-request HMAC signing (ported from the official Python SDK). Verified against the official docs test vector (`kvlS6opdZDhEBo5jq40nHYXaLvM=`). Algorithm switches by host (§7) using the SDK's upgrade-host list (`api.webull.com` → HMAC-SHA1 + MD5 body hash; everything else, incl. `data-api.*` and sandbox hosts → HMAC-SHA256 + SHA-256 body hash). |
| `webull-endpoints.ts` | **The single mapping file**: hosts, endpoint paths + versions, query params, order payload builders (`buildOptionOrder` / `buildFuturesOrder`), `toClientOrderId` (md5 hex of the idempotency key, 32 chars), `position_intent` derivation, and the small parsers not covered by the mappers (balance, place/preview results, futures instruments, error bodies). Header comment tracks per-entry verification status — corrections belong here only. |
| `webull-client.ts` | `WebullClient` — per-user HTTP client: request signing, 10 s timeout, 429 → exponential backoff with jitter (4 retries, honors `Retry-After`), one 5xx retry, error mapping (§6), and the API-token lifecycle (create/refresh, in-memory cache, single-flight, refresh ~2 days before the ~15-day expiry, cleared on 401). Never logs headers/credentials. |
| `webull-mappers.ts` | All response payload → DTO translation: quotes, candles (`1m→M1 … 1d→D`), order status map, futures symbol format (`ESZ6`+`contract_month` ↔ app `ESZ26`), OCC symbols for option legs/positions. Verified against the official MCP server's field usage. |
| `../webull-broker.gateway.ts` | Implements `BrokerGateway`. Per-user client factory keyed on a credentials fingerprint, chain synthesis (below), contract resolution, order construction, post-place status polling (1 s × up to 60 → `OrderEventsService` → WS `orderUpdate`). |

Key decisions:

- **Option chains are synthesized** — Webull has no chain-discovery endpoint. Expirations are the
  standard calendar (today/+1d/weekly/monthly, same shape as the mock); strikes are generated
  ±12 around ATM ($1 under $250 underlying, $5 above) as candidate OCC symbols and filtered to
  contracts the option-snapshot endpoint actually returns (batched ≤ 20 symbols per call).
  [best-effort — the only official way to discover contracts]
- **Unified order endpoints** — place/preview/cancel go to `POST /openapi/trade/order/*` for
  both options and futures (since 2025-12-13 "a single order place API enables trading across
  stocks, options, futures, and crypto"; matches `scripts/webull-smoke.ts`). The asset-specific
  `/openapi/trade/option/order/*` paths remain in `webull-endpoints.ts` as documented fallbacks.
- **Broker-side idempotency**: `client_order_id` = md5 hex (32 chars) of the app's idempotency
  key; the same key can never double-place. The app-facing `orderId` IS the `client_order_id`
  because Webull cancels by it.
- **`position_intent`** is derived from side + current positions (BUY closes an existing short →
  `BUY_TO_CLOSE`, else `BUY_TO_OPEN`; mirrored for SELL).
- **previewOrder** uses the real `POST /openapi/trade/order/preview` (`estimated_cost`), falling
  back to the local `estimateBuyingPower` when preview fails; warnings mirror the mock (0DTE,
  market-order-on-option) plus a real buying-power check from `GET /openapi/assets/balance`.
- `mid` orders are rested as `LIMIT` at the computed mid; `market` maps to `MARKET`.
- **Fills**: Webull streams order events over gRPC (not implemented in P4). The gateway emits
  `submitted` immediately, then polls `GET /openapi/trade/order/detail` once per second (max 60)
  until a terminal status and emits the final `orderUpdate` (incl. `filledPrice`).
- **Token cache is in-memory.** A production restart re-creates tokens, which may require the user
  to re-approve in the Webull app (SMS). Persisting tokens (encrypted) across restarts is a
  planned follow-up — the `webull_api_tokens` table already exists in the schema for this.

**Verification status:** request signing (official docs test vector), module wiring, encrypted
credential storage, order payload shapes, and error mapping are verified (unit tests with a
mocked HTTP layer + the SDK/docs sources cited in `webull-endpoints.ts`). Response field shapes
in `webull-mappers.ts` come from the official MCP server source; futures instrument fields and
option-snapshot fields are best-effort pending a live sandbox run of `npm run smoke:webull`.

## 9. Webull Cloud MCP (auxiliary)

Webull also operates a hosted MCP server (`https://api.webull.com/mcp`, remote HTTP, OAuth — no
local install, no API keys). It is registered in this project's local Claude Code MCP config as
`webull`; authorize via `/mcp` (OAuth happens on Webull's own pages). It targets the
**production** account, so it is useful for reading real account/market data and cross-checking
mapper field shapes — but app trading goes through the gateway above, sandbox-first.
