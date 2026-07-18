# ARCHITECTURE — 0dteTrader

## 1. System Overview

```
┌────────────────────┐   HTTPS (REST, JWT)    ┌────────────────────┐   HTTPS/WS (user creds)   ┌──────────────────┐
│  iOS App (SwiftUI) │ ◄────────────────────► │  Backend API       │ ◄───────────────────────► │  Webull OpenAPI  │
│                    │   WSS (quotes, JWT)    │  NestJS + TS       │                           │                  │
└────────────────────┘                        └───────┬────────────┘                           └──────────────────┘
                                                      │
                                              ┌───────▼────────┐  ┌──────────────┐
                                              │  PostgreSQL    │  │  Redis       │
                                              │  users, creds, │  │  rate limit, │
                                              │  tokens, audit │  │  quote cache │
                                              └────────────────┘  └──────────────┘
```

**Why a backend exists:** Webull OpenAPI app key/secret cannot ship in the app bundle — an
extracted secret means account takeover. The iOS app authenticates to our backend (JWT) and the
backend brokers every Webull call using the user's encrypted, server-side credentials.

## 2. Backend Modules (apps/api, NestJS)

| Module | Responsibility |
|---|---|
| `AuthModule` | Register/login/refresh/logout; Argon2id hashing; JWT access (15 min) + rotating refresh tokens |
| `UsersModule` | Profile read/update; kill-switch flag |
| `CredentialsModule` | Store/rotate/delete Webull creds; AES-256-GCM encrypt before persist; decrypt in-memory only |
| `BrokerModule` | `BrokerGateway` interface; `MockBrokerGateway` (deterministic dev/test) and `WebullBrokerGateway` (real, P4); per-user client factory with token caching |
| `MarketDataModule` | REST: candles, quote, options chain; WS gateway streaming subscribed quotes |
| `TradingModule` | Order preview/place/cancel/replace; positions; account summary; idempotency; server-side re-validation of Auto-OTM + mid price; audit log |

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
}
```

Selected via `BROKER_GATEWAY=mock|webull`. All iOS-facing endpoints depend only on the interface.

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

## 4. iOS App Structure (apps/ios)

Clean architecture, MVVM, feature folders:

```
App/                  entry point, DI container, coordinators
Core/
  Networking/         APIClient (REST), QuoteSocketClient (WS, reconnect+backoff)
  Storage/            KeychainStore (JWT), SettingsStore (UserDefaults)
  Models/             DTOs + domain models
DesignSystem/         colors, typography, buttons, haptics
Features/
  Auth/               LoginView, RegisterView, AuthViewModel
  Profile/            ProfileView, WebullCredentialsForm
  Chart/              ChartView (candles + indicator overlays), IndicatorEngine, SymbolSearch
  Trade/              TradePanelView, FloatingTradeButtons, OptionsChainViewModel,
                      AutoContractSelector, OrderTicketView, PositionsStripView
```

**Charting:** DanielGindi/Charts (SwiftPM) for v1 candlesticks + indicator overlays.

**Indicators:** pure functions over `[Candle]` in `IndicatorEngine` — unit-testable, no UI deps.

## 5. Data Model (PostgreSQL)

- `User(id uuid pk, email citext unique, password_hash, trading_disabled bool, created_at, updated_at)`
- `WebullCredential(user_id pk fk, enc_app_key bytea, enc_app_secret bytea, enc_account_id bytea, iv bytea, auth_tag bytea, updated_at)`
- `RefreshToken(id uuid pk, user_id fk, token_hash, expires_at, revoked_at, created_at)`
- `OrderAudit(id uuid pk, user_id fk, idempotency_key unique, request jsonb, response jsonb, status, created_at)`

## 6. Security Summary

Full treatment in `docs/SECURITY.md`. Essentials: AES-256-GCM per-field encryption of Webull
creds (single data key from env/KMS, random IV per write), Argon2id passwords, short-lived JWTs,
refresh rotation, order idempotency, kill switch, audit log, rate limiting on `/v1/orders`,
TLS everywhere, cert pinning in the app.

## 7. Environments

- **local dev:** `BROKER_GATEWAY=mock` — deterministic quotes/fills, no Webull account needed.
- **paper:** real `WebullBrokerGateway` against Webull paper/sandbox (P4).
- **live:** same gateway, live Webull endpoints; requires explicit per-user confirmation gate.
