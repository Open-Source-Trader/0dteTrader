# ROADMAP — 0dteTrader

## P0 — Repo & Docs ✅
Monorepo scaffold (npm workspaces — substituted for pnpm/Turbo to avoid global installs),
docs set, CI skeleton, docker-compose, `.env.example`.

## P1 — Backend Core
NestJS app: Auth, Users, Credentials (AES-256-GCM), BrokerGateway + MockBrokerGateway,
MarketData (REST + WS), Trading (idempotency, kill switch, audit), Prisma schema/migrations,
Jest unit + e2e tests.
**Done when:** `npm run test` green; register → save creds → preview/place mock order works via curl.

## P2 — iOS Shell
XcodeGen project, DesignSystem, APIClient + Keychain, Auth screens, Profile with Webull
credential form, risk disclaimer on first launch.
**Done when:** register/login/save-creds flow works against the local API on simulator.

## P3 — Chart & Trade UI
Candlestick chart + indicators, symbol switcher, Layout A (fullscreen + floating buttons),
Layout B (split, resizable), trade panel, options chain UI, Auto-OTM selector, mid/market toggle,
order confirm, positions strip, futures selector.
**Done when:** full tap → confirm → mock fill → position visible, on simulator, both layouts;
XCTest green (AutoContractSelector, mid-price, indicator math).

## P4 — Real Webull Gateway
WebullBrokerGateway against official OpenAPI (auth, quotes, chains, orders, positions),
429 backoff, error mapping, verified on paper account.
**Done when:** paper-account order placed/cancelled from the app end-to-end.

## P5 — Hardening & TestFlight
Rate-limit tuning, audit review, cert pinning, FaceID lock, edge-case pass (network loss
mid-order, stale quotes, market closed), TestFlight build, live-account go-live checklist.

## Later (not v1)
Alerts, portfolio analytics, multi-broker abstraction (IBKR/Tastytrade), Android,
App Store public release + compliance review.
