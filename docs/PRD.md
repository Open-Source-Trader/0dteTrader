# PRD — 0dteTrader

## 1. Overview

0dteTrader is an iPhone app for rapid discretionary trading of options and futures on Webull,
built around one idea: **the trader is watching a chart and must be able to enter/exit a position
in under two seconds.** The official Webull OpenAPI provides market data, order execution, and
account management. A custom backend holds user accounts and encrypted Webull credentials.

## 2. Personas

- **Active 0DTE options scalper** — watches SPX/SPY/QQQ intraday, enters/exits in seconds,
  trades the +1 OTM strike repeatedly during a session.
- **Futures day trader** — trades micro/index futures (MES, ES, MNQ, NQ) off the same chart UI.

## 3. Functional Requirements

### 3.1 Auth & Profile
- FR-1 Email + password registration and login (JWT access + refresh).
- FR-2 Profile screen with Webull credential form: app key, app secret, account ID
  (extended if Webull OpenAPI requires additional fields).
- FR-3 Credentials persist server-side (encrypted); user never re-enters them per session.
- FR-4 Credentials are write-only in the UI: after save, show "Configured" state; allow
  update or delete; never render the secret back.
- FR-5 Optional FaceID app lock.

### 3.2 Chart
- FR-6 Candlestick chart for any symbol (stocks/ETF underlyings, indices, futures).
- FR-7 Indicators computed client-side: EMA, SMA, VWAP, RSI, MACD, Bollinger Bands;
  user-configurable and toggleable; presets persisted.
- FR-8 Live updates via WebSocket quote stream.
- FR-9 Symbol search/switcher.

### 3.3 Layouts
- FR-10 **Layout A — Fullscreen:** chart fills the screen; floating Buy/Sell buttons overlaid.
- FR-11 **Layout B — Split:** chart on top, trade panel in the bottom half; drag divider to
  resize between 1/4 and 1/2 of screen height.
- FR-12 Layout choice persists across launches.

### 3.4 Options Quick Trade
- FR-13 Trade panel defaults to the ticker currently on the chart.
- FR-14 Manual contract selection: expiration picker → strike picker (from live options chain).
- FR-15 **Auto mode:** one tap selects the contract +1 strike OTM from the underlying's last
  price — calls: lowest strike strictly above last; puts: highest strike strictly below last.
- FR-16 Expiration defaults to nearest (0DTE when available); user can override.
- FR-17 Order type toggle: **limit at mid price** (recomputed from live bid/ask at send time)
  or **market**.
- FR-18 Quantity input with quick-steppers (1/5/10).
- FR-19 Every order requires an explicit confirm (arm-then-confirm) to prevent fat-finger.
- FR-20 Server re-validates contract selection and price before submission.

### 3.5 Futures Quick Trade
- FR-21 Futures mode: front-month contract by default; explicit contract selector.
- FR-22 Same Buy/Sell, qty, mid/market, confirm pipeline as options.

### 3.6 Positions & Orders
- FR-23 Positions strip on the trade screen: symbol, qty, avg price, unrealized P&L.
- FR-24 Tap a position to flatten (with confirm).
- FR-25 Open orders list with cancel.

### 3.7 Safety
- FR-26 All order POSTs are idempotent (client-generated idempotency key).
- FR-27 Server-side kill switch: per-user trading disable flag honored by every order endpoint.
- FR-28 Full audit log of order actions.

## 4. Non-Functional Requirements

- NFR-1 Quote-to-screen latency target: < 500 ms on typical broadband/LTE (mock + real).
- NFR-2 Secrets encrypted at rest (AES-256-GCM); TLS in transit; no secrets in the app bundle.
- NFR-3 Dark-mode-first UI; light mode supported; Dynamic Type respected on non-chart screens.
- NFR-4 Backend test coverage on auth, encryption, order validation, Auto-OTM, mid-price calc.
- NFR-5 App Store–ready code quality even though v1 targets TestFlight/personal use.

## 5. Acceptance Criteria (key flows)

1. New user registers → logs in → enters Webull creds → returns tomorrow and is not asked again.
2. User views SPY chart with EMA(9)+VWAP; switches layout; choice persists after relaunch.
3. Auto mode, calls, 0DTE: SPY last = 502.13 → selects 503 call (first strike strictly above).
4. Mid-price toggle: bid 1.20 / ask 1.28 → limit sent at 1.24.
5. Double-tap on Buy submits exactly one order (idempotency).
6. With kill switch on, order endpoints return 403 and audit-log the attempt.
7. Futures mode on /ES chart: Buy auto-selects front-month MES/ES per user default.

## 6. Out of Scope (v1)

Android, alerts/notifications, analytics, multi-broker, public App Store compliance work.
