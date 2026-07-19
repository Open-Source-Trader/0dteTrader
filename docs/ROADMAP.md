# ROADMAP — 0dteTrader

## P0 — Repo & Docs ✅
Monorepo scaffold (npm workspaces — substituted for pnpm/Turbo to avoid global installs),
docs set, CI skeleton, docker-compose, `.env.example`.

## P1 — Backend Core ✅
NestJS app: Auth, Users, Credentials (AES-256-GCM), BrokerGateway,
MarketData (REST + WS), Trading (idempotency, kill switch, audit), Prisma schema/migrations,
Jest unit + e2e tests. **155/155 tests green; live smoke test against docker Postgres passed.**

## P2 — iOS Shell ✅
XcodeGen project, DesignSystem, APIClient + Keychain, Auth screens, Profile with Webull
credential form, risk disclaimer on first launch. **Complete at `apps/ios` (50 files);
awaiting first Xcode build on a Mac (see `apps/ios/README.md`).**

## P3 — Chart & Trade UI ✅
Candlestick chart + indicators, symbol switcher, Layout A (fullscreen + floating buttons),
Layout B (split, resizable), trade panel, options chain UI, Auto-OTM selector, mid/market toggle,
order confirm, positions strip, futures selector. **Code complete with XCTest suites;
simulator run pending on a Mac.**

## P4 — Real Webull Gateway ✅ (code complete; paper verification pending credentials)
WebullBrokerGateway against the official OpenAPI (HMAC signing validated against the official
docs test vector, token flow, snapshots, bars, order place/cancel/status-poll, 429 backoff,
error mapping per §6). Endpoint map isolated in `apps/api/src/broker/webull/webull-endpoints.ts`
with per-capability confidence flags — re-verify against live docs before real trading.
**Done when remaining:** apply for Webull OpenAPI credentials → run
`npm run webull:smoke` / paper-account order from the app end-to-end.

## P5 — Hardening & TestFlight
Rate-limit tuning, audit review, cert pinning, FaceID lock, edge-case pass (network loss
mid-order, stale quotes, market closed), TestFlight build, live-account go-live checklist.

## Later (not v1)
Alerts, portfolio analytics, multi-broker abstraction (IBKR/Tastytrade), Android,
App Store public release + compliance review.
