# WEBULL INTEGRATION — 0dteTrader

## 1. Source of Truth

Official Webull OpenAPI: https://developer.webull.com/apis/docs/ (apply for developer credentials;
review typically 1–2 business days). Per-user credentials: app key, app secret, account ID.

> **Status:** P4 is implemented — `WebullBrokerGateway` + `apps/api/src/broker/webull/` (signer,
> HTTP client, token store, client provider, mappers). Request signing is verified against the
> official docs test vector; response field shapes are confirmed via the sandbox smoke test
> (`npm run smoke:webull`, see docs/RUNBOOK.md). Webull has no option-chain discovery endpoint,
> so chains are synthesized from ATM-probed snapshot queries. Every payload mapping lives in
> `webull-mappers.ts` so corrections are localized.

## 2. Capability Mapping

| 0dteTrader need | Webull OpenAPI capability |
|---|---|
| User auth to broker | App key + app secret → access token (token endpoint; cached, refreshed before expiry) |
| Quotes | Market data quote endpoint (REST snapshot) |
| Live streaming | Streaming quotes (WebSocket/MQTT per docs) — v1 polls REST at 1s in mock, upgrades to stream in P4 if entitlement allows |
| Candles | Historical bars endpoint (interval mapping: 1m/5m/15m/1h/1d) |
| Options chain | Option chain endpoint by underlying + expiration |
| Futures contracts | Futures contract list by root symbol |
| Place/cancel order | Trade endpoints: place, cancel, replace; order status query |
| Positions/account | Account endpoints: positions, balances/buying power |

## 3. Rate Limits & Quotas

- Respect the per-app and per-account rate limits in the OpenAPI docs; the backend centralizes all
  Webull calls behind `WebullClientProvider` so throttling/backoff (429 → exponential backoff)
  lives in one place.
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

- P4 targets Webull's paper/sandbox environment first via `WEBULL_API_BASE_URL`.
- Live requires: explicit user acknowledgement in the app (first-launch risk disclaimer),
  `NODE_ENV=production`, and the live base URL. There is no code path difference beyond config —
  the gateway is identical, only the environment changes.

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
HTTP client accepts both. Business errors arrive as HTTP 417 with codes like
`OPENAPI_NO_NIGHT_TRADING_TIME`; mapping is by substring match on code+message in one exported
table (`mapWebullError` in `webull-http.client.ts`).

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

Sandbox credential creation steps live in docs/RUNBOOK.md ("Getting sandbox credentials").

## 8. P4 Implementation (as built)

All Webull knowledge lives in `apps/api/src/broker/webull/` plus the gateway; nothing outside
depends on Webull payload shapes.

| File | Responsibility |
|---|---|
| `webull-signer.ts` | Per-request HMAC signing (ported from the official Python SDK). Verified against the official docs test vector (`kvlS6opdZDhEBo5jq40nHYXaLvM=`). Algorithm switches by host (§7). |
| `webull-http.client.ts` | Single choke point for all Webull HTTP: signing, 10 s timeout, 429 → exponential backoff (4 retries, honors Retry-After), one 5xx retry, error mapping (§6). Never logs headers/credentials. |
| `webull-token.store.ts` | API token lifecycle: create/refresh, cached in memory + encrypted (AES-256-GCM) in the `webull_api_tokens` table so restarts don't retrigger production SMS approval. Single-flight per user; invalidated + recreated once on 401. |
| `webull-client.provider.ts` | Per-user endpoint facade: decrypts credentials via `CredentialsService`, chunks option snapshots (≤20 symbols), paginates open orders, micro-caches (quotes ~1 s, futures instrument lists ~5 min) to fit rate limits. |
| `webull-mappers.ts` | All payload ↔ DTO translation: quotes, candles (`1m→M1 … 1d→D`), order status map, futures symbol format (`ESZ5`+`contract_month` ↔ app `ESZ25`), OCC symbols for option legs/positions. Field-shape corrections belong here only. |
| `../webull-broker.gateway.ts` | Implements `BrokerGateway`. Chain synthesis (below), order construction, post-place status polling (1 s/2 s/5 s/10 s → `OrderEventsService` → WS `orderUpdate`). |

Key decisions:

- **Option chains are synthesized** — Webull has no chain-discovery endpoint. Candidate
  expirations (today/+1d/weekly/monthly) are validated by probing ATM call snapshots; strikes are
  generated ±12 around ATM ($1 under $250 underlying, $5 above) and filtered to contracts the
  snapshot endpoint actually returns. Chains cache 45 s per underlying+expiration.
- **Broker-side idempotency**: `client_order_id` = md5 hex (32 chars) of the app's idempotency
  key; the same key can never double-place. The app-facing `orderId` IS the `client_order_id`
  because Webull cancels by it.
- **`position_intent`** is derived from side + current positions (BUY closes an existing short →
  `BUY_TO_CLOSE`, else `BUY_TO_OPEN`; mirrored for SELL).
- **previewOrder** uses the real `POST /openapi/trade/order/preview` (`estimated_cost`), falling
  back to the local `estimateBuyingPower` when preview fails; warnings mirror the mock (0DTE,
  market-order-on-option) plus a real buying-power check from `GET /openapi/assets/balance`.
- `mid` orders are rested as `LIMIT` at the computed mid; `market` maps to `MARKET`.

**Verification status:** signing, wiring, encrypted credential storage, and error mapping are
verified (unit tests + live boot against sandbox). Response field shapes in `webull-mappers.ts`
(futures year digits, order/position fields, balance fields) are best-effort from docs and
pending confirmation via the sandbox smoke test once sandbox credentials exist.

## 9. Webull Cloud MCP (auxiliary)

Webull also operates a hosted MCP server (`https://api.webull.com/mcp`, remote HTTP, OAuth — no
local install, no API keys). It is registered in this project's local Claude Code MCP config as
`webull`; authorize via `/mcp` (OAuth happens on Webull's own pages). It targets the
**production** account, so it is useful for reading real account/market data and cross-checking
mapper field shapes — but app trading goes through the gateway above, sandbox-first.
