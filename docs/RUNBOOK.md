# RUNBOOK — 0dteTrader Local Dev

## Prerequisites

- Node.js >= 18.17, npm
- Docker + docker compose (Postgres, Redis)
- For iOS: macOS with Xcode 15+, XcodeGen (`brew install xcodegen`)

## First-time setup

Run the automated setup script:

```bash
npm run setup
```

This verifies Node.js and Docker, creates `.env` from `.env.example`, generates a real `CRED_ENCRYPTION_KEY`, installs dependencies, starts Postgres and Redis, and applies Prisma migrations. It is idempotent, so you can re-run it safely.

If you prefer to do it manually, see `package.json` and `.env.example` for the equivalent commands.

## Run the API

```bash
npm run dev            # http://localhost:3000 — Webull gateway (paper or live per user)
```

The API always talks to Webull — there is no mock/demo data. Without stored
Webull credentials, market-data and trading calls fail with `AUTH_FAILED`;
add practice credentials first (see "Switching to real Webull" below).
The Options Structure endpoint needs a `TRADIER_API_TOKEN` in `.env`; the
trading chain continues to come from Webull.

> **Note:** `CRED_ENCRYPTION_KEY` is generated automatically by `npm run setup`. You do not need to generate it by hand unless you are setting up production manually.

Smoke test:

```bash
curl -X POST localhost:3000/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com","password":"password123"}'
```

## Run the iOS app

```bash
cd apps/ios
xcodegen             # generates 0dteTrader.xcodeproj from project.yml
open 0dteTrader.xcodeproj
```

Run on the iOS 17 simulator. The app targets the Railway production backend by
default (configurable in `AppConfig.swift`). For local dev, swap to
`http://localhost:3000`.

## Tests & checks

```bash
npm run lint
npm run build
npm run test           # Jest unit + e2e
```

iOS: `xcodebuild test -scheme 0dteTrader -destination 'platform=iOS Simulator,name=iPhone 15'`
(or Cmd+U in Xcode).

## Brokers and data sources

Today the app uses a **hybrid broker/data model**:

| Function                                                    | Provider           | Why                                                                                                                                            |
| ----------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Order execution                                             | **Webull OpenAPI** | Sends real or paper trades.                                                                                                                    |
| Candlestick / chart data                                    | **Webull OpenAPI** | OHLCV bars and stock snapshots.                                                                                                                |
| Options Structure quotes, OI, volume, and provider metadata | **Tradier API**    | The backend derives local IV/Greeks and chart analytics from validated quotes because provider Greek timestamps can be much older than quotes. |

So the typical flow is: Webull for placing/cancelling orders, the trading
chain, and chart candles; Tradier for the separate Options Structure snapshot.

### Required credentials today

- **Webull OpenAPI** app key + app secret + account ID (paper or live). Entered per-user in the app under Profile → Webull API and stored encrypted server-side.
- **Tradier API token** (brokerage or paper). Set once in `.env` as `TRADIER_API_TOKEN`; desktop and iOS call only `GET /v1/market/options-analytics` on the backend. Get a token from Tradier → Settings → API Access.

### Future plans

- A **Tradier-only mode** so you can trade and get market data from a single broker.
- Additional broker integrations that offer free API access and the required options data (Greeks, chain, etc.).

If you only want chart/trading without options analytics, no Tradier token is
needed.

## Webull setup (paper & live)

1. Apply for Webull OpenAPI developer credentials (see docs/WEBULL-INTEGRATION.md).
2. Set the correct `WEBULL_API_BASE_URL` in `.env`
   (`https://api.sandbox.webull.com` for paper, `https://api.webull.com` for live).
3. In the app: Profile → Webull API → enter app key / app secret / account ID.
   The account ID comes from the sandbox smoke test's `account/list` output (below).
4. Production only: the first API call triggers an SMS-verified token approval
   inside your Webull app (Menu → Messages → OpenAPI Notifications, within 5 min);
   the API returns `BROKER_AUTH_FAILED` with instructions until it is approved.

### Getting sandbox (paper) credentials

Sandbox and production are fully isolated — production App Keys do NOT work in
sandbox. To create sandbox credentials (auto-approved within minutes):

1. Log in at webull.com → avatar menu (upper right) → **Developer Tool**.
2. **My Application** → click **"Using OpenAPI service in Paper Trading"** —
   this redirects to the Sandbox portal (portal.sandbox.webull.com/center).
3. In the sandbox portal: **API Management → My Application** → apply
   (approved automatically, typically a few minutes).
4. Then **API Management → API Keys Management** → enter an application name,
   accept the agreement, **Generate Key** → sandbox App Key + App Secret.

### Sandbox smoke test

Verifies signing, token creation, market data, and (optionally) order flow
against the real sandbox. Credentials come from the shell env or the gitignored
`.env` — never commit them.

```bash
WEBULL_SMOKE_APP_KEY=<app key> WEBULL_SMOKE_APP_SECRET=<app secret> \
  npm run smoke:webull             # read-only: token, accounts, balance, quotes
WEBULL_SMOKE_APP_KEY=<app key> WEBULL_SMOKE_APP_SECRET=<app secret> \
  npm run smoke:webull -- --trade  # also preview/place/cancel a far-OTM SPY order
```

Use its output to confirm the response field shapes assumed in
`src/broker/webull/webull-mappers.ts` (futures symbol year digits, order/position
fields) — corrections belong in that one file.

## Tradier setup

To populate the options chain and Options Structure snapshot:

1. Get a Tradier brokerage or paper account.
2. Go to Tradier → **Settings → API Access** and create an API token.
3. Set the token in `.env`:

   ```bash
   TRADIER_API_TOKEN=your_token_here
   ```

4. Optionally change `TRADIER_BASE_URL`:
   - Paper: `https://sandbox.tradier.com`
   - Live: `https://api.tradier.com` (default)

The token stays server-side; iOS and desktop never see it. The backend exposes a quality-aware result only through `GET /v1/market/options-analytics`. If the token is missing, options analytics fail while chart and order functionality still work.

The response reports `feedMode`, quote/Greek/OI timestamps, coverage, cache
state, warnings, and calculation version. Sandbox/delayed feeds are never
labeled real-time. The required expiration is exact-match only. The configured
annual risk-free rate is disclosed in every snapshot because it is a model
input, not a live timestamped yield curve.

### Snapshot capture and retention

By default the API captures SPY, QQQ, IWM, and SPX once per minute during the
regular New York cash session, plus successfully viewed symbol/expiration
pairs. Repeated work in the same bucket is deduplicated. One-minute records
retain 30 days; a representative quality-preserving five-minute record retains
one year. Capture, compaction, cleanup, and failures are logged. Disable or
override scheduled capture with the documented `OPTIONS_ANALYTICS_*`
environment variables when provider capacity is limited. Any future replay
must filter by source observation time, not the minute bucket alone, to prevent
look-ahead.

## Webull Cloud MCP (optional, for Claude Code)

Webull's hosted MCP server gives Claude read access to real account/market data (70+ endpoints).
It is remote — nothing to install — and already registered in this repo's local Claude Code
config:

```bash
claude mcp add --transport http webull https://api.webull.com/mcp   # already done
```

Run `/mcp` inside Claude Code to complete OAuth (Webull's own login page; you pick which
accounts/capabilities to authorize — prefer read-only scopes: account info, order query, market
data). Note it targets the **production** account; app trading still goes through the sandbox
gateway until verified.

## Railway (production)

The API, Postgres, and Redis run on Railway:

- **Project:** `0dtetrader-api`
- **API URL:** `https://caring-prosperity-production.up.railway.app`
- **Health:** `GET /v1/health`
- **Services:** caring-prosperity (API), Postgres, Redis-75yS

Redeploy from the repo root:

```bash
railway service caring-prosperity
railway up
```

Prisma migrations run automatically on container startup.

Environment variables are set via `railway variables` / the Railway dashboard.
Secrets (JWT keys, Webull credentials, Tradier token) mirror `.env` — update
both when rotating.

## Troubleshooting

- **Prisma can't reach Postgres** — `docker compose ps`; `npm run db:up` again.
- **409 on register** — email exists; use login or a new email.
- **iOS can't reach the API** — production uses Railway
  (`https://caring-prosperity-production.up.railway.app`). For local dev on a
  physical device, set your machine's LAN IP in `AppConfig.swift`.
