# AGENTS.md — AI Agent Context

This file gives AI coding agents the project-specific context needed to build, test, and modify this codebase correctly.

## Project Structure

```
0dteTrader/
├── apps/
│   ├── api/          NestJS + TypeScript backend (Prisma, PostgreSQL, Redis)
│   ├── desktop/      React + Vite + Electron (iPhone-faithful web clone)
│   └── ios/          SwiftUI iOS app (XcodeGen, DGCharts, iOS 17+)
├── packages/
│   └── shared-types/ TypeScript contracts shared between API and desktop
├── docs/             Architecture, API spec, security, runbook
├── docker-compose.yml  Postgres 16 + Redis 7
└── scripts/setup.js    One-time environment bootstrap
```

## Build & Run Commands

```bash
# First-time setup (installs deps, starts Docker, runs migrations)
npm run setup

# Development
npm run dev            # API only (localhost:3000)
npm run dev:desktop    # Desktop Vite dev server (localhost:5173)
npm run dev:all        # Both concurrently

# Build
npm run build          # shared-types → API → desktop (in order)

# Test
npm run test           # All workspace tests (Jest for API, Vitest for desktop)
npm run lint           # ESLint across all workspaces
npm run format:check   # Prettier check

# Database
npm run db:up          # Start Postgres + Redis containers
npm run db:down        # Stop containers
npm run db:migrate     # Apply Prisma migrations

# iOS (from apps/ios/)
xcodegen               # Generate .xcodeproj from project.yml
xcodebuild build -scheme 0dteTrader -destination 'platform=iOS Simulator,name=iPhone 16 Pro'
xcodebuild test -scheme 0dteTrader -destination 'platform=iOS Simulator,name=iPhone 16 Pro'
```

## Key Architecture Decisions

- **Monorepo** with npm workspaces (api, desktop, shared-types). iOS is separate (XcodeGen).
- **Backend proxies all broker calls** — Webull API credentials never leave the server. The iOS/desktop apps authenticate via JWT to our API.
- **Hybrid data model**: Webull for orders + candles, Tradier for options chain + Greeks.
- **iOS module name**: `ZeroDTETrader` (Swift modules can't start with a digit). Tests use `@testable import ZeroDTETrader`.
- **Desktop uses a fixed 430x932 phone frame** that scales to fit the window (`--app-scale` CSS variable). No scrollbars — content adjusts based on indicator count.
- **Indicator sub-panes capped at 2** (RSI, MACD, Stoch, ATR). Panel density auto-adjusts: roomy (0 panes) → compact (1) → dense (2).

## Conventions

### TypeScript (API + Desktop)

- Strict mode, no `any`
- NestJS modules with dependency injection
- API tests: Jest + Supertest
- Desktop tests: Vitest
- Prettier for formatting, ESLint for linting

### Swift (iOS)

- SwiftUI + MVVM, feature folders
- `@MainActor` on ViewModels
- SwiftLint configured (`.swiftlint.yml` in `apps/ios/`)
- DGCharts v5 via SwiftPM for candlestick rendering
- `IndicatorEngine` — pure functions over `[Candle]`, unit-testable
- Design system in `DesignSystem/` (AppTokens, HudControls, TradeButtons)

### Shared Patterns

- Both apps use the same indicator math (ported between TS and Swift)
- Both apps have the same screen structure: fullscreen (chart + floating buttons) vs split (chart + trade panel)
- Desktop is the reference implementation for layout behavior; iOS copies it

## Environment

- `.env` holds all secrets (gitignored). Created from `.env.example` by `npm run setup`.
- `CRED_ENCRYPTION_KEY` — AES-256-GCM key for encrypting stored Webull credentials
- `TRADIER_API_TOKEN` — server-side only, powers options chain / GEX endpoints
- `WEBULL_API_BASE_URL` — paper (`sandbox.webull.com`) or live (`api.webull.com`)

## Common Gotchas

- `npm run dev` (API) uses `node --watch` on the compiled output — changes require a rebuild (`tsc` runs on start).
- The desktop Electron mode requires the Vite dev server running first (`npm run dev:desktop`, then `npm run electron` in `apps/desktop/`).
- Docker must be running before `npm run dev` (Postgres + Redis are required).
- The options chain and GEX/DEX endpoints need a `TRADIER_API_TOKEN` in `.env` — without it, chart and order functionality still works but options analytics fail.
