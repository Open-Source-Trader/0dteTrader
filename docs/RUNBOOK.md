# RUNBOOK — 0dteTrader Local Dev

## Prerequisites

- Node.js >= 18.17, npm
- Docker + docker compose (Postgres, Redis)
- For iOS: macOS with Xcode 15+, XcodeGen (`brew install xcodegen`)

## First-time setup

```bash
cp .env.example .env
# Generate a real encryption key and put it in .env:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

npm install
npm run db:up          # postgres + redis
npm run db:migrate     # prisma migrate
```

## Run the API

```bash
npm run dev            # http://localhost:3000 — Webull gateway (paper or live per user)
```

The API always talks to Webull — there is no mock/demo data. Without stored
Webull credentials, market-data and trading calls fail with `AUTH_FAILED`;
add practice credentials first (see "Switching to real Webull" below).

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

Run on the iOS 17 simulator. The app targets `http://localhost:3000` in Debug builds
(configurable in `AppConfig.swift`).

## Tests & checks

```bash
npm run lint
npm run build
npm run test           # Jest unit + e2e
```

iOS: `xcodebuild test -scheme 0dteTrader -destination 'platform=iOS Simulator,name=iPhone 15'`
(or Cmd+U in Xcode).

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
cd apps/api
WEBULL_SMOKE_APP_KEY=<app key> WEBULL_SMOKE_APP_SECRET=<app secret> \
  npm run smoke:webull             # read-only: token, accounts, balance, quotes
  npm run smoke:webull -- --trade  # also preview/place/cancel a far-OTM SPY order
```

Use its output to confirm the response field shapes assumed in
`src/broker/webull/webull-mappers.ts` (futures symbol year digits, order/position
fields) — corrections belong in that one file.

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

## Troubleshooting

- **Prisma can't reach Postgres** — `docker compose ps`; `npm run db:up` again.
- **409 on register** — email exists; use login or a new email.
- **iOS can't reach localhost API on a physical device** — use your machine's LAN IP in
  `AppConfig.swift` and allow it through the firewall; Debug builds only.
