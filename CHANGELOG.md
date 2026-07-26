# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Pre-commit hooks with husky and lint-staged
- CONTRIBUTING.md, LICENSE, and CHANGELOG.md
- `tasks/` directory for task tracking
- React + Vite + Electron desktop app (`apps/desktop`) — phone-frame clone of the iOS UI
- GEX/DEX indicator engine with Tradier API integration (`GET /v1/market/gex`)
- TWC (Trade With Cash) heatmap indicator overlay (iOS + desktop)
- Trade history with average-cost realized P/L (`GET /v1/orders/history`, `TradeOrder` model)
- Webull token persistence (`WebullApiToken` model, AES-256-GCM encrypted at rest)
- Live/practice dual credential sets and per-user trading mode switching
- Crypto quotes and candles via Coinbase public API (BTC, ETH, etc.)
- Health endpoint (`GET /v1/health`)
- `POST /v1/me/webull-session/refresh` — reconnect escape hatch
- Webull account ID auto-discovery via `GET /openapi/account/list`
- Partial fill tracking (`filledQuantity` on orders)
- Trading lock toggle in the top-right nav (iOS + desktop) — disables all order-placing controls (Buy/Sell, order config, flatten/cancel) while leaving the chart interactive; remembered across launches
- Profile setting to skip the buy/sell confirmation sheet and place orders immediately (per-device)
- Chart trading: TradingView-style order lines on the candle chart (iOS + desktop, on by default)
  - Entry line per open position on the underlying's price scale — signed quantity, live P/L, and a ✕ that closes only that contract (anchored by the underlying price recorded at placement, `Position.underlyingEntryPrice`)
  - Draggable limit / target / stop lines watched against the **underlying**; a crossing fires a normal mid/market option order through the existing order pipeline (kill switch, idempotency, server-side re-validation, audit unchanged)
  - Per-line `MID`/`MKT` execution pill, visible on the line and flippable with one tap
  - Futures-style brackets: drag off the entry line to place target + stop as an OCO pair; direction follows the contract (a long put's target sits below entry), not the screen
  - Placement guide: tap (iOS) or click (desktop) empty chart space to summon a dashed level with a chamfered `+` handle flush against the pane's right border; tap again to dismiss it, drag the handle to fine-tune the level, and tap the `+` for a HUD order window whose level, side, size, and execution are all editable. Keyboard and VoiceOver reach the same two steps through the handle, which stays focusable while dormant
  - Server-side watcher (`ChartOrderWatcherService`, leased singleton) fires lines with no client connected; client and watcher race safely via deterministic idempotency keys
  - Environment isolation at the fire boundary: a practice-armed line can never route to the live account, including the client-trigger path
  - Armed-side crossing predicate (no instant fires on placement, gap-safe across restarts), stale-quote refusal, settled-contract expiry, orphaned-bracket sweep with an opening grace window
  - New API surface: `GET/POST/PATCH/DELETE /v1/chart-orders`, `POST /v1/chart-orders/:id/trigger`, `chartOrder` WebSocket message, `ChartOrder` Prisma model, `CHART_ORDER_WATCHER_*` env vars
- Sell with a held contract selected now closes (part of) that position instead of opening a short — ticket quantity honored but capped at the position size, with a `CLOSE n of m` confirm summary (iOS + desktop)
- Quick screenshot button (iOS) — capture the current view with one tap, system share sheet for save/share

### Changed

- TWC Heatmap V5: VWAP RIP markers now default to off (iOS + desktop)
- After login, the chart reloads the current symbol instead of sitting empty until a ticker change (iOS + desktop)

### Fixed

- `/v1/health` responds 200 with degraded status instead of failing, so Railway healthchecks pass during broker outages
- iOS header wordmark scales down instead of truncating to `0dteTr…` when the toolbar is full
- `scripts/generate-env.sh` no longer aborts the iOS build when `.env` lacks `API_BASE_URL` (falls back to localhost as intended)
- Trade-history accounting ignores degenerate broker rows reporting a fill with zero executed quantity (would NaN-poison a contract's average-cost book)
- A broker-accepted chart-order fire is never relabeled `failed` by a bookkeeping error (which would orphan its OCO sibling to double-fire)

## [0.1.0] - 2026-07-19

### Added

- Monorepo scaffold with npm workspaces (api, desktop, shared-types)
- NestJS backend: auth, users, encrypted credential vault, market data, trading proxy
- Webull OpenAPI integration (HMAC signing, token flow, snapshots, bars, order management)
- Tradier API integration for options chain, Greeks, and GEX/DEX levels
- iOS app shell (SwiftUI, XcodeGen, DesignSystem, APIClient, auth screens)
- React + Vite + Electron desktop app with candlestick chart, trade panel, options chain
- Shared TypeScript types package
- Docker Compose for Postgres 16 and Redis 7
- CI pipeline (GitHub Actions) for lint, build, and test
- Setup script (`npm run setup`) for first-time environment configuration
- Documentation: architecture, API spec, security model, Webull integration guide, runbook
