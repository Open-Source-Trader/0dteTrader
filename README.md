# 0dteTrader

Rapid options quick-trade iOS (and desktop) app backed by the official Webull OpenAPI for order execution and candlestick data, with options analytics (Greeks, open interest, etc.) sourced from Tradier.

- `apps/ios` — SwiftUI iPhone app (iOS 17+)
- `apps/desktop` — React + Electron desktop clone for local development on Linux/macOS/Windows
- `apps/api` — NestJS + TypeScript backend (auth, encrypted credential vault, market data, trading proxy)
- `packages/shared-types` — shared TypeScript contracts
- `docs` — architecture, API spec, security model, Webull integration guide, runbook

> **Risk warning:** Trading involves substantial risk of loss. This software places real orders when connected to a live brokerage account. Always validate against a paper (practice) account first.

## Quick start

```bash
git clone https://github.com/TradeWithCash2025/0dteTrader.git
cd 0dteTrader
npm run setup
npm run dev
```

`npm run setup` checks your environment, creates `.env` from `.env.example`, generates a credential-encryption key, installs dependencies, starts Postgres and Redis, and applies Prisma migrations.

## Prerequisites

- **Node.js >= 18.17** and **npm**
- **Docker + Docker Compose** (Postgres 16 and Redis 7 run in containers)
- **macOS + Xcode 15+** if you want to build the iOS app
- **XcodeGen** (`brew install xcodegen`) for generating the iOS `.xcodeproj`

## Data sources and broker support

Today the app uses a **hybrid broker/data model**:

| Function                                   | Provider           | Why                                                                                                                                     |
| ------------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Order execution                            | **Webull OpenAPI** | Sends real or paper trades.                                                                                                             |
| Candlestick / chart data                   | **Webull OpenAPI** | OHLCV bars and stock snapshots.                                                                                                         |
| Options chain + Greeks (GEX/DEX, OI, etc.) | **Tradier API**    | Webull OpenAPI does not expose option Greeks, implied volatility, open interest, or full chain detail beyond contract price and volume. |

So a typical flow looks like: Webull for placing/cancelling orders and chart candles, Tradier for picking strikes and viewing Greeks.

### Required credentials today

- **Webull OpenAPI** app key + app secret + account ID (paper or live). Entered per-user in the app under Profile → Webull API and stored encrypted server-side.
- **Tradier API token** (brokerage or paper). Set once in `.env` as `TRADIER_API_TOKEN`; the desktop/iOS app only calls `GET /v1/market/gex` on the backend.

### Future plans

- A **Tradier-only mode** so you can trade and get market data from a single broker.
- Additional broker integrations that offer free API access and the required options data (Greeks, chain, etc.).

If you only want the chart/trading pieces without options analytics, the Tradier token is only needed for the GEX/DEX and options-chain views.

## What the setup script does

Running `npm run setup`:

1. Verifies Node.js >= 18.17 and that Docker is running.
2. Copies `.env.example` → `.env` (if `.env` does not already exist).
3. Generates a real `CRED_ENCRYPTION_KEY` in `.env` if it is still a placeholder.
4. Runs `npm install`.
5. Starts Postgres and Redis with `npm run db:up`.
6. Waits for Postgres, then runs `npm run db:migrate`.

The script is idempotent — you can run it again safely.

## Run the API

```bash
npm run dev
```

The API starts at `http://localhost:3000`. It always talks to the real Webull OpenAPI; there is no mock data. Without stored Webull credentials, market-data and trading calls return `AUTH_FAILED` until you add practice credentials. The options chain and GEX/DEX endpoints also need a `TRADIER_API_TOKEN` in `.env`.

Register a dev account:

```bash
curl -X POST http://localhost:3000/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com","password":"password123"}'
```

## Run the iOS app

```bash
cd apps/ios
xcodegen
open 0dteTrader.xcodeproj
```

Run on the iOS simulator (⌘+R). The Debug build targets `http://localhost:3000` (configurable in `apps/ios/0dteTrader/App/AppConfig.swift`). Register the dev account you created above, then add Webull credentials under Profile → Webull API.

## Run the desktop app

The desktop app is a web/Electron clone of the iOS UI, useful for testing the backend without Xcode.

```bash
npm run dev:desktop
```

Then open the printed local URL (usually `http://localhost:5173`).

## All npm scripts

| Command                | What it does                                         |
| ---------------------- | ---------------------------------------------------- |
| `npm run setup`        | One-time env setup (deps, Docker, migrations)        |
| `npm run dev`          | Start the API only (`localhost:3000`)                |
| `npm run dev:desktop`  | Start the desktop Vite dev server (`localhost:5173`) |
| `npm run dev:all`      | Start API + desktop concurrently                     |
| `npm run build`        | Build shared-types, API, and desktop                 |
| `npm run test`         | Run all workspace tests                              |
| `npm run lint`         | Lint all workspaces                                  |
| `npm run format`       | Format all files with Prettier                       |
| `npm run format:check` | Check formatting (CI)                                |
| `npm run db:up`        | Start Postgres + Redis containers                    |
| `npm run db:down`      | Stop and remove containers                           |
| `npm run db:migrate`   | Apply Prisma migrations                              |
| `npm run smoke:webull` | Run Webull connectivity smoke test                   |

Desktop-only (run from `apps/desktop`):

| Command            | What it does                                |
| ------------------ | ------------------------------------------- |
| `npm run electron` | Launch in Electron (requires `dev` running) |
| `npm run preview`  | Vite production preview                     |

iOS tests:

```bash
cd apps/ios
xcodebuild test -scheme 0dteTrader -destination 'platform=iOS Simulator,name=iPhone 16'
```

## Connect to Webull and Tradier

### Webull (order execution + chart data)

The app needs a Webull OpenAPI developer account. High-level steps:

1. Apply for Webull OpenAPI credentials at the Webull developer portal.
2. Set `WEBULL_API_BASE_URL` in `.env`:
   - Paper: `https://api.sandbox.webull.com`
   - Live: `https://api.webull.com`
3. In the app: Profile → Webull API → enter app key, app secret, and account ID.
4. For live trading, the first API call triggers an SMS-verified approval in the Webull app.

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for the full walkthrough, including how to get sandbox credentials and run the Webull smoke test:

```bash
npm run smoke:webull
```

### Tradier (options chain + Greeks)

To populate the options chain, GEX/DEX levels, and Greeks, set a Tradier token in `.env`:

```bash
TRADIER_API_TOKEN=your_token_here
```

Get a token from [Tradier](https://tradier.com) → Settings → API Access (a paper/brokerage account is required). The token is only used server-side; the mobile/desktop apps never see it.

## Project secrets

Real secrets live only in `.env`, which is gitignored. Never commit credentials. The repo contains only development/CI placeholders and a hardcoded dev-only encryption fallback that is rejected in production.

## Documentation

- [`docs/PRD.md`](docs/PRD.md) — product requirements document
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design and module overview
- [`docs/API-SPEC.md`](docs/API-SPEC.md) and [`docs/openapi.yaml`](docs/openapi.yaml) — backend API contract
- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model, encryption, auth, operational security
- [`docs/WEBULL-INTEGRATION.md`](docs/WEBULL-INTEGRATION.md) — Webull OpenAPI integration details
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — local development, Webull setup, smoke tests, troubleshooting
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — future plans and priorities

## License

MIT License — see [LICENSE](LICENSE).
