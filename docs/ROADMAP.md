# ROADMAP — 0dteTrader

## P0 — Repo & Docs ✅

Monorepo scaffold (npm workspaces — substituted for pnpm/Turbo to avoid global installs),
docs set, CI skeleton, docker-compose, `.env.example`.

## P1 — Backend Core ✅

NestJS app: Auth, Users, Credentials (AES-256-GCM), BrokerGateway,
MarketData (REST + WS), Trading (idempotency, kill switch, audit), Prisma schema/migrations,
Jest unit + e2e tests. **155/155 tests green at P1 completion (suites have since grown: api 298, desktop 129, iOS 128); live smoke test against docker Postgres passed.**

## P2 — iOS Shell ✅

XcodeGen project, DesignSystem, APIClient + Keychain, Auth screens, Profile with Webull
credential form, risk disclaimer on first launch. **Complete at `apps/ios` (50 files);
awaiting first Xcode build on a Mac (see `apps/ios/README.md`).**

## P3 — Chart & Trade UI ✅

Candlestick chart + indicators, symbol switcher, Layout A (fullscreen + floating buttons),
Layout B (split, resizable), trade panel, options chain UI, Auto-OTM selector, mid/market toggle,
order confirm, positions strip. **Code complete with XCTest suites;
simulator run pending on a Mac.**

## P3.5 — Desktop Clone ✅

React + Vite + Electron desktop app (`apps/desktop`) that mirrors the iOS UI in a fixed
phone-frame layout. Same features: auth, chart with indicators/Options Structure/TWC overlays, trade panel,
positions strip, history, profile. Useful for backend testing without Xcode.

## P3.6 — Options Analytics Snapshot Integrity Suite ✅

Tradier-backed, exact-expiration Options Structure engine: runtime-validated
quotes and metadata, local IV/Greeks, explicit USD-per-1%-move exposure units,
fact-first call/put/gross structure, independent walls, implied expiry range,
marked-OI value, liquidity, and an optional labeled call-minus-put scenario.
Snapshots include source age/coverage/warnings/version, persist at one-minute
resolution with compaction, and render as a current right-edge profile on iOS
and desktop through `GET /v1/market/options-analytics`.

## P4 — Real Webull Gateway ✅ (code complete; paper verification pending credentials)

WebullBrokerGateway against the official OpenAPI (HMAC signing validated against the official
docs test vector, token flow, snapshots, bars, order place/cancel/status-poll, 429 backoff,
error mapping per §6). Endpoint map isolated in `apps/api/src/broker/webull/webull-endpoints.ts`
with per-capability confidence flags — re-verify against live docs before real trading.
Token persistence implemented (`WebullTokenStore` + `webull_api_tokens` table, AES-256-GCM
encrypted at rest) so restarts reuse existing tokens instead of triggering SMS 2FA.
**Done when remaining:** apply for Webull OpenAPI credentials → run
`npm run smoke:webull` / paper-account order from the app end-to-end.

## P4.5 — Trade History & Realized P/L ✅

`TradeOrder` model persists every order; `OrdersService` computes average-cost realized P/L
per fill (multiplier-aware, partial-fill-safe). `GET /v1/orders/history` returns the full
ledger with per-entry P/L and net total. History view in both iOS and desktop.

## P5 — Hardening & TestFlight

Rate-limit tuning, audit review, cert pinning, FaceID lock, edge-case pass (network loss
mid-order, stale quotes, market closed), TestFlight build, live-account go-live checklist.

## P6 — Multi-Broker Abstraction (Webull + Alpaca) ✅

Per-user `tradingProvider` (webull | alpaca) selecting the active broker. `DispatchingBrokerGateway`
routes every `BrokerGateway` call to `WebullBrokerGateway` or `AlpacaBrokerGateway` by provider, so
all client endpoints stay provider-agnostic. Alpaca uses API key/secret Basic auth (no token store,
key-scoped account); OCC parity is preserved via the shared `formatOccSymbol` helper. Credentials moved
to a provider-agnostic encrypted `BrokerCredential` blob with a lazy migration shim from the legacy
`WebullCredential` rows. Mobile (iOS + desktop) gained a provider selector and an Alpaca credential form
writing through the generic `me/broker-credentials` endpoint. **Code complete: 314 API tests green,
desktop builds + lints clean; iOS awaiting an Xcode build on a Mac.** Remaining: apply for Alpaca API
keys → run an Alpaca paper-account order end-to-end from the app.

## P7 — TradeDaddy Integration

Bring **TradeDaddy**, our AI trading assistant already powered by Apple
Intelligence, into 0dteTrader. On-device AI reads the chart you're looking at —
candles, options structure, positions — and talks strategy in plain English:
setups, risk framing, and post-trade review, without your market data leaving
the phone.

## P8 — Global Chat

A real-time global chat inside the app: one shared room (plus per-symbol
threads) where traders watch the same 0DTE tape together. Built on the existing
WebSocket streaming layer with the same auth, rate-limiting, and moderation
hooks as the rest of the backend.

## P9 — Social & Sharing

Show off (or own up to) your trades without leaving the app:

- **Discord connection** — link a Discord channel and every buy and sell is
  posted there automatically.
- **Quick screenshot button** — capture the current chart/trade view with one tap.
- **Screenshot on sell** — optional automatic screenshot when a position is
  closed, stamped with the realized P/L.
- **Auto-post to social media** — optionally push those screenshots straight
  to your connected social accounts.

## Later (not v1)

Futures trading (backend has endpoint stubs but no client UI), alerts, portfolio analytics,
additional brokers (IBKR/Tastytrade), Android, App Store public release + compliance
review.
