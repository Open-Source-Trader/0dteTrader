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
