# ARCHITECTURE — 0dteTrader

## 1. System Overview

```
┌────────────────────┐                     ┌────────────────────┐
│  iOS App (SwiftUI) │ ◄──────────────┐    │  Webull OpenAPI    │
└────────────────────┘  HTTPS + WSS   │    │  (orders, candles) │
                        (REST, JWT)   │    └──────▲─────────────┘
┌────────────────────┐                │           │ HTTPS/WS (user creds)
│  Desktop App       │ ◄────────► ┌───┴───────────┴──┐
│  React + Electron  │            │  Backend API      │
└────────────────────┘            │  NestJS + TS      ├──────────► ┌──────────────────┐
                                  └──┬────────────────┘            │  Tradier API     │
                                     │          HTTPS (API token)  │  (chains, Greeks)│
                              ┌──────▼─────────┐                   └──────────────────┘
                              │  PostgreSQL     │
                              │  users, creds,  │
                              │  tokens, orders │
                              └────────────────┘
```

**Why a backend exists:** Webull OpenAPI app key/secret cannot ship in the app bundle — an
extracted secret means account takeover. Both client apps (iOS and desktop) authenticate to our
backend (JWT) and the backend brokers every Webull call using the user's encrypted, server-side
credentials. Options quotes and open interest come from Tradier. The backend validates
those inputs and derives local IV, Greeks, fact-first exposure structure, implied range,
marked-OI value, and liquidity with visible source quality.

## 2. Backend Modules (apps/api, NestJS)

| Module                   | Responsibility                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthModule`             | Register/login/refresh/logout; Argon2id hashing; JWT access (15 min) + rotating refresh tokens                                                                                        |
| `UsersModule`            | Profile read/update; kill-switch flag                                                                                                                                                 |
| `CredentialsModule`      | Store/rotate/delete Webull creds; AES-256-GCM encrypt before persist; decrypt in-memory only                                                                                          |
| `BrokerModule`           | `BrokerGateway` interface; `WebullBrokerGateway` (the only implementation — no mock/demo data); per-user client factory with token caching                                            |
| `MarketDataModule`       | REST: candles, quote, options chain; WS gateway streaming subscribed quotes                                                                                                           |
| `TradingModule`          | Order preview/place/cancel/replace; positions; trade history with realized P/L; idempotency; server-side re-validation of Auto-OTM + mid price; audit log                             |
| `OptionsAnalyticsModule` | Exact-expiration Tradier normalization; local IV/Greek engine; call/put/gross structure; explicit positioning scenarios; implied range; bounded cache; snapshot capture and retention |
| `HealthModule`           | `GET /v1/health` — DB connectivity check, uptime (public, no auth)                                                                                                                    |

### BrokerGateway interface (the key seam)

```ts
interface BrokerGateway {
  getQuote(userId: string, symbol: string): Promise<Quote>;
  getCandles(userId: string, symbol: string, req: CandleRequest): Promise<Candle[]>;
  getOptionsChain(userId: string, symbol: string, expiration?: string): Promise<OptionsChain>;
  previewOrder(userId: string, order: OrderRequest): Promise<OrderPreview>;
  placeOrder(userId: string, order: OrderRequest, idempotencyKey: string): Promise<OrderResult>;
  cancelOrder(userId: string, orderId: string): Promise<void>;
  getPositions(userId: string): Promise<Position[]>;
  getOpenOrders(userId: string): Promise<OrderResult[]>;
  reauthenticate(userId: string): Promise<TradingMode>;
}
```

Implemented by `WebullBrokerGateway`. All client-facing endpoints depend only on the interface. General market data comes from Webull; options analytics use Tradier through `OptionsAnalyticsModule`. Live vs practice selects the live vs paper-trading Webull hosts per user. `reauthenticate` drops the cached Webull client/token and mints a fresh one — the "Reconnect" escape hatch when a token goes stale.

## 3. Order Flow (tap → fill)

1. User taps **Buy** → app builds `OrderRequest` (symbol, side, qty, mode: auto-otm | explicit,
   orderType: mid | market, expiration?) + idempotency key (UUID generated when the ticket
   is armed — double taps reuse the same key).
2. `POST /v1/orders` with JWT.
3. TradingModule: rate limit → kill-switch check → idempotency lookup (return prior result if key
   seen) → decrypt creds → gateway resolves contract server-side (auto-otm re-computed from the
   live quote/chain, not trusted from client) → mid price recomputed from live bid/ask →
   `placeOrder` → audit log → result.
4. Result pushed to app over the existing WS connection (and returned in the HTTP response).

## 4. Client Apps

### 4a. iOS (apps/ios) — SwiftUI, MVVM

```
App/                  entry point, DI container, coordinators
Core/
  Networking/         APIClient (REST), QuoteSocketClient (WS, reconnect+backoff)
  Storage/            KeychainStore (JWT), SettingsStore (UserDefaults)
  Models/             DTOs + domain models
DesignSystem/         colors, typography, buttons, haptics
Features/
  Auth/               LoginView, RegisterView, AuthViewModel, RiskDisclaimerView
  Profile/            ProfileView, WebullCredentialsForm, AppLockManager (FaceID)
  Chart/              ChartView (candles + indicator overlays), IndicatorEngine, SymbolSearch,
                      OptionsAnalytics/ (Options Structure overlay), Twc/ (TWC heatmap indicator)
  Trade/              TradePanelView, FloatingTradeButtons, OptionsChainViewModel,
                      AutoContractSelector, OrderConfirmSheet, PositionsStripView,
                      HistoryView, ToastView
```

**Charting:** DanielGindi/Charts (SwiftPM, v5 as `DGCharts`) for candlesticks + indicator overlays.

**Indicators:** pure functions over `[Candle]` in `IndicatorEngine` — unit-testable, no UI deps.

**Options Structure:** enabled by default with implied range, gross call/put
gamma profile, and independent call/put walls in a right-edge snapshot rail.
Marked OI/liquidity and the explicitly assumed dealer gamma-flip proxy remain
opt-in. Closed-market snapshots can use only the final 30 minutes of the latest
completed regular session and carry a visible warning.

### 4b. Desktop (apps/desktop) — React + Vite + Electron

Faithful web clone of the iOS UI for development/testing without Xcode. Fixed 430×932 phone frame with `--app-scale` CSS variable. Same feature structure: auth, chart (with Options Structure/TWC overlays), profile, trade. Shared indicator behavior is tested for parity between TypeScript and Swift.

## 5. Data Model (PostgreSQL)

- `User(id uuid pk, email unique, password_hash, trading_disabled bool, trading_mode 'live'|'practice', created_at, updated_at)`
- `WebullCredential(id uuid pk, user_id fk, environment 'live'|'practice', enc_app_key bytea, enc_app_secret bytea, enc_account_id bytea?, created_at, updated_at)` — unique on `(user_id, environment)`. Each `enc_*` column is a self-contained blob (`iv ‖ authTag ‖ ciphertext`), not a shared IV/tag pair.
- `WebullApiToken(id uuid pk, user_id fk, environment, enc_token bytea, expires_at, status, created_at, updated_at)` — encrypted-at-rest persistence of Webull access tokens so restarts reuse them instead of re-creating (avoiding SMS 2FA); unique on `(user_id, environment)`.
- `RefreshToken(id uuid pk, user_id fk, token_hash unique, expires_at, revoked_at, created_at)`
- `TradeOrder(id pk, user_id fk, contract_symbol, asset_class, environment, side, quantity, filled_quantity?, order_type, limit_price?, filled_price?, status, placed_at, updated_at)` — one row per broker order, kept current as order-update events arrive; feeds trade history with realized P/L.
- `OrderAudit(id uuid pk, user_id fk, idempotency_key?, request jsonb, response jsonb, status, created_at)` — unique on `(user_id, idempotency_key)`.
- `OptionsAnalyticsSnapshotRecord(id uuid pk, symbol, expiration, observed_at, bucket_start, calculation_version, capture_reason, resolution_minutes, quality jsonb, normalized_input jsonb, output jsonb, created_at)` — unique by exact symbol/expiration/bucket/version/resolution; one-minute detail compacts to five-minute history.

Options analytics capture uses the same exact calculation path as interactive
requests. Core SPY/QQQ/IWM/SPX capture runs only during the authoritative New
York session. Interactive requests persist the active symbol/expiration at
most once per minute. One-minute data retains 30 days and five-minute data one
year; cleanup and compaction are idempotent and observable. `bucket` is only
the capture/deduplication bucket: any future replay must also require
`observedAt <= replayTime`, so a later representative from the same five-minute
bucket can never leak into an earlier candle.

## 6. Security Summary

Full treatment in `docs/SECURITY.md`. Essentials: AES-256-GCM per-field encryption of Webull
creds (single data key from env/KMS, random IV per write), Argon2id passwords, short-lived JWTs,
refresh rotation, order idempotency, kill switch, audit log, rate limiting on `/v1/orders`,
TLS everywhere, cert pinning in the app.

## 7. Environments

- **local dev:** Webull gateway against the paper/sandbox hosts (per-user practice credentials); there is no mock/demo data path.
- **paper:** `WebullBrokerGateway` against Webull paper/sandbox (P4).
- **live:** same gateway, live Webull endpoints; requires explicit per-user confirmation gate.
