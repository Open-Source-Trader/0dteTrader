# AGENTS.md — AI Agent Context

> Instructions for AI coding assistants, kept public for transparency. The architecture notes and gotchas below double as accurate engineering documentation for human readers too.

This file gives AI coding agents the project-specific context needed to build, test, and modify this codebase correctly.

## Project Structure

```
0dteTrader/
├── apps/
│   ├── api/          NestJS + TypeScript backend (Prisma, PostgreSQL, Redis)
│   ├── desktop/      React + Vite + Electron — standalone desktop trading app
│   └── ios/          SwiftUI iOS app (XcodeGen, DGCharts, iOS 17+)
├── packages/
│   └── shared-types/ TypeScript contracts shared between API and desktop
├── docs/             Architecture, API spec, security, runbook
├── docker-compose.yml  Postgres 16 + Redis 7
└── scripts/setup.js    One-time environment bootstrap
```

iOS and desktop are **independent apps** with their own UX, developed separately. They share the backend (`apps/api`) and its wire contract (`packages/shared-types`), and both implement the same underlying trading domain (options chain, order placement, positions) — but neither's UI or feature work implies a corresponding change in the other. A task scoped to one app stays scoped to that app unless it explicitly touches shared backend/API contract code.

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
- **Desktop is a standalone, desktop-native trading app** — its own responsive layout, not a phone-frame clone of iOS. UI/UX decisions for desktop should suit a desktop trading workflow (larger canvas, keyboard shortcuts, multi-pane layouts), not mirror iOS's mobile constraints.
- **Indicator sub-panes capped at 2** (RSI, MACD, Stoch, ATR) on both apps. Panel density auto-adjusts: roomy (0 panes) → compact (1) → dense (2).

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

- Both apps use the same indicator math (ported between TS and Swift) and the same underlying trading domain model (order arm/confirm flow, position close-detection, etc.) — but each owns its own UI/UX independently. A layout or interaction pattern introduced on one app does not need to be ported to the other unless the task calls for it.
- Both apps talk to the same backend API and must stay compatible with its contract (`packages/shared-types`). Changes to the API request/response shape need checking against both clients.

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
- iOS and desktop are independent apps — a fix or feature scoped to one does not need to be ported to the other. Only changes to `apps/api` or `packages/shared-types` that affect the wire contract need checking against both clients.
