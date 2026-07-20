# Contributing to 0dteTrader

Thank you for considering contributing to 0dteTrader. By participating in this
project you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting Started

### Prerequisites

- Node.js >= 18.17 (see `.nvmrc`)
- Docker and Docker Compose (for Postgres and Redis)
- npm (not yarn or pnpm)

### Setup

```bash
git clone https://github.com/Open-Source-Trader/0dteTrader.git
cd 0dteTrader
npm run setup
```

The setup script checks your environment, creates `.env`, installs dependencies,
starts database containers, and runs migrations. See `scripts/setup.js` for details.

### Development

```bash
npm run dev          # start API server
npm run dev:desktop  # start desktop app (Vite dev server)
npm run dev:all      # start both concurrently
```

## Before Submitting a Pull Request

1. **Lint:** `npm run lint`
2. **Format:** `npm run format`
3. **Build:** `npm run build`
4. **Test:** `npm run test`

Pre-commit hooks run ESLint and Prettier on staged files automatically.

## Code Style

- TypeScript throughout (except iOS which is Swift)
- ESLint with `@typescript-eslint` (workspace configs in each app/package)
- Prettier for formatting (see `.prettierrc`)
- Prefix unused variables with `_`
- See `CLAUDE.md` for the full coding philosophy

## Project Structure

```
apps/api/              NestJS backend
apps/desktop/          React + Vite + Electron desktop app
apps/ios/              SwiftUI iOS app
packages/shared-types/ Shared TypeScript types
docs/                  Architecture, API spec, security, runbook
```

## Commit Messages

```
type(scope): short description
```

Types: `feat`, `fix`, `chore`, `test`, `docs`, `refactor`

Scopes: `api`, `desktop`, `ios`, `webull`, `gex`, `theme`, etc.

## Reporting Issues

Open an issue on GitHub with:

- What you expected
- What actually happened
- Steps to reproduce
- Your environment (OS, Node version, Docker version)
