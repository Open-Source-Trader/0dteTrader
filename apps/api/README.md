# @0dtetrader/api — 0dteTrader backend

NestJS 10 + TypeScript 5 backend for 0dteTrader. Proxies the Webull OpenAPI for
the iOS app: JWT auth, encrypted Webull credential storage, market data
(REST + WebSocket), and order flow with server-side re-validation,
idempotency, kill switch, and audit logging.

Docs: `../../docs/ARCHITECTURE.md`, `../../docs/API-SPEC.md`,
`../../docs/SECURITY.md`, `../../docs/WEBULL-INTEGRATION.md`.

## Layout

```
src/
  main.ts                  bootstrap: helmet, CORS, /v1 prefix, WsAdapter, AppLogger
  app.module.ts            module wiring + global guards/pipe/filter
  config/                  env configuration + fail-fast validation
  common/                  ApiException, BrokerError, global exception filter
                           ({ error: { code, message } }), AppThrottlerGuard,
                           Public/CurrentUser decorators, logger + redaction
  prisma/                  PrismaModule / PrismaService (global)
  auth/                    register/login/refresh/logout; Argon2id passwords;
                           JWT access (15 min) + rotating refresh tokens with
                           reuse detection; JwtAuthGuard (global, @Public() opts out)
  users/                   GET/PATCH /v1/me
  credentials/             PUT/DELETE /v1/me/webull-credentials; AES-256-GCM
                           (12-byte random IV per field per write, blob =
                           iv‖authTag‖ciphertext); plaintext never logged
  broker/                  BrokerGateway interface + BROKER_GATEWAY token;
                           WebullBrokerGateway (the only implementation — no
                           mock/demo data; see broker/webull/); OrderEventsService
                           (orderUpdate bus); contract-resolution.ts
                           (auto-OTM / mid / OCC symbols); expiration-calendar.ts
  broker/webull/           P4 Webull OpenAPI stack: webull-endpoints.ts
                           (single path/payload mapping file), webull-signer.ts
                           (HMAC signing, official docs test vector),
                           webull-client.ts (per-user HTTP + token lifecycle +
                           429 backoff), webull-mappers.ts (response → DTO)
  market-data/             REST: quote, candles, options-chain; WS gateway at
                           /v1/stream (1s quote ticks per symbol, orderUpdate
                           fan-out); crypto-data.service (Coinbase public API)
  gex/                     GET /v1/market/gex — dealer GEX/DEX levels + premium
                           heat map; tradier.client.ts (chain fetch with the
                           static-OI day baseline), gex.engine.ts (pure math)
  trading/                 preview / place (Idempotency-Key) / cancel / open
                           orders / positions / history; kill switch;
                           idempotency claims via OrderAudit; audit log
prisma/
  schema.prisma            User, WebullCredential, RefreshToken, OrderAudit, TradeOrder
  migrations/              generated SQL (prisma migrate dev)
test/
  jest.setup.ts            test env vars (loaded via jest setupFiles)
  in-memory-prisma.service.ts  PrismaService fake (unique constraints, P2002s)
  app.e2e-spec.ts          supertest e2e of the whole app
```

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | `tsc -p tsconfig.build.json` → `dist/` |
| `npm run dev` | build + run with `node --watch` (restarts on dist changes; run `npm run build:watch` in a second terminal for recompiles) |
| `npm test` | jest (unit + e2e), `--runInBand` |
| `npm run lint` | eslint over `src/` and `test/` |
| `npm run db:migrate` | `prisma migrate deploy` (needs `DATABASE_URL`) |
| `npm run db:generate` | `prisma generate` (also runs on `postinstall`) |
| `npm run smoke:webull` | Live sandbox smoke test (`src/scripts/webull-smoke.ts`, needs `WEBULL_SMOKE_APP_KEY/SECRET`; `-- --trade` also places+cancels a far-OTM order) |

From the repo root, `npm install && npm run build && npm test` builds
`packages/shared-types` first, then this package, then runs the whole suite.

## Configuration

All via environment (see `../../.env.example`). Non-production boots work with
built-in development defaults (a loud warning is logged when
`CRED_ENCRYPTION_KEY` falls back to the dev key). Production
(`NODE_ENV=production`) refuses to boot without strong `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, and a valid base64 32-byte `CRED_ENCRYPTION_KEY`.

The broker gateway is always the real Webull OpenAPI gateway (per-user clients
from the encrypted credentials; sandbox hosts in practice mode, live hosts in
live mode — see `../../docs/WEBULL-INTEGRATION.md` §7–§8). There is no
mock/demo data path; without credentials, broker calls fail fast with
`BROKER_AUTH_FAILED`.

## Database

PostgreSQL 16 via Prisma (`docker compose up -d postgres` from the repo root,
then `npm run db:migrate`). The migration in `prisma/migrations/` was generated
with `prisma migrate dev` against the compose Postgres.

Schema deviations from `docs/ARCHITECTURE.md` §5, both deliberate:

1. **`User.email` is `TEXT UNIQUE`, not `citext`.** Case-insensitivity is
   enforced in the app layer (emails are lowercased before every read/write),
   so no Postgres extension is required.
2. **`WebullCredential` has no shared `iv`/`auth_tag` columns.** The doc schema
   has one `iv` and one `auth_tag` column for three encrypted fields, which
   cannot hold per-field GCM parameters without reusing nonces. Instead each
   `enc_*` bytea column stores a self-contained blob
   `iv (12B) ‖ authTag (16B) ‖ ciphertext`, with a fresh random IV per field
   per write. This still satisfies "random 12-byte IV per write, store
   iv+authTag+ciphertext" — and is nonce-reuse-safe.

`OrderAudit.idempotencyKey` is nullable and unique together with `userId`
(Postgres treats NULLs as distinct). Placement claims the key with a pending
row *before* the broker call: concurrent duplicates get `ORDER_IN_FLIGHT`,
failed executions free the key, and stale claims expire after 2 minutes.
Previews, cancels, blocked and failed attempts are audited without one.

## Test strategy

**`npm test` runs without Postgres, Redis, or any network service.** It runs
unit + e2e together (`jest --runInBand`):

- **Unit suites** (`src/**/*.spec.ts`) instantiate services directly against
  the in-memory Prisma fake:
  - `auth/password.service` — Argon2id hash/verify, wrong password, salt
    uniqueness, malformed hashes.
  - `credentials/crypto.service` — AES-256-GCM round-trip, blob layout,
    per-write IV randomness, ciphertext/tag tamper detection, wrong key.
  - `auth/auth.service` — register/login, duplicate 409, refresh rotation,
    reuse detection revoking the whole token family, logout idempotency.
  - `broker/contract-resolution` — auto-OTM edge cases (price exactly on a
    strike → strictly above for calls / strictly below for puts), expiration
    defaulting/validation, mid-price calc incl. crossed-spread rejection, OCC
    symbol round-trip, buying-power math.
  - `trading/trading.service` — server-side auto-OTM normalization, mid limit
    price, idempotent replay + in-flight claim + key freed on failure, kill
    switch 403 + blocked audit row, audit coverage (in-spec stub gateway).
  - `trading/orders.service` — average-cost realized P/L incl. partial fills
    at the broker-reported filled quantity.
  - `gex/gex.engine` — Black-Scholes sanity, exposure signs/magnitudes, walls,
    0DTE magnet, premium ordering, gamma-flip bracketing.
  - `broker/webull/webull-signer` — HMAC signing against the official docs
    test vector, host→algorithm classification, percent-encoding.
  - `broker/webull/webull-mappers` — string-number tolerance, order status
    map, OCC symbols from legs, position filtering.
  - `broker/webull/webull-client` — token create/cache/refresh/clear-on-401,
    429 backoff (Retry-After + jitter) and exhaustion, 5xx retry, network
    failure → BROKER_UNAVAILABLE, §6 error mapping table.
  - `broker/webull-broker.gateway` — full gateway through a fake `fetchImpl`
    router: quote routing, chain snapshot-probe synthesis (±12 strikes),
    preview (broker estimate + local fallback), place payloads (user-scoped
    MD5 client_order_id, position_intent), status-poll fill emission (fake
    timers), cancel, positions/open-orders filtering. No live Webull calls.
- **E2E** (`test/app.e2e-spec.ts`) boots the entire Nest app (real guards,
  pipes, filters, throttler module, WS adapter) with `PrismaService`
  overridden by the in-memory fake and `BROKER_GATEWAY` overridden by the
  deterministic `test/stub-broker.gateway.ts` double, then drives supertest
  through register → login → /me → save/delete credentials → market data →
  preview → place → replay → positions → mid-order fill → cancel → kill
  switch → refresh rotation/reuse → logout.

Test-only affordances: `NODE_ENV=test` skips request throttling (the strict
10 req/min order limit would otherwise trip long e2e flows) and
`test/jest.setup.ts` pins deterministic JWT/encryption secrets.
`InMemoryPrismaService` emulates the exact Prisma delegate surface the app
uses, including unique-constraint `P2002` errors and NULL-key semantics.

The `InMemoryPrismaService` fake is also why the app code deliberately uses a
small Prisma surface (no raw SQL, no interactive transactions) — documented on
`src/prisma/prisma.service.ts`.

## Security notes

- Passwords: Argon2id (64 MiB / t=3 / p=4). If the native `argon2` module
  cannot load, `PasswordService` falls back to scrypt (N=2^15, r=8, p=1) with a
  self-describing hash format — logged as a warning at boot.
- Refresh tokens are JWTs; only their SHA-256 hash is stored. Rotation on
  every use; presenting a revoked token revokes the user's whole family.
- Webull credentials: AES-256-GCM, key from `CRED_ENCRYPTION_KEY`, random IV
  per field per write, decrypted only in memory when a broker call needs them.
  The logger redacts `appKey`/`appSecret`/`accountId`/tokens/passwords.
- Errors are always `{ error: { code, message } }`; order endpoints are
  limited to 10 req/min (reads 100 req/min); every preview/place/cancel
  attempt (including blocked ones) lands in `OrderAudit`.
