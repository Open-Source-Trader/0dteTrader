# Contributing to 0dteTrader

Thank you for considering contributing to 0dteTrader. By participating in this
project you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Where to start

Issues labeled [`good first issue`](https://github.com/Open-Source-Trader/0dteTrader/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
are scoped for newcomers. Help is especially welcome on:

- **Broker integrations** — the roadmap's pluggable OAuth broker layer (Schwab, Tastytrade, IBKR, Alpaca, …)
- **iOS ↔ desktop parity** — the two clients must always ship features together; parity gaps are bugs
- **Docs** — setup friction, unclear instructions, missing explanations

> **Risk warning.** This software can place **real orders** against a live brokerage account.
> Contributions that touch trading, auth, or credential handling are held to a high bar — read
> [`docs/SECURITY.md`](docs/SECURITY.md) before changing anything in those areas. Always validate
> against a paper (practice) account first.

## Code of Conduct

- Node.js >= 22.12 (see `.nvmrc`)
- Docker and Docker Compose (for Postgres and Redis)
- npm (not yarn or pnpm)

## Ways to contribute

You don't have to write code to help:

- **Report bugs** — open an issue with a clear repro (see [Reporting issues](#reporting-issues)).
- **Suggest features** — open a discussion/issue describing the use case, not just the solution.
- **Improve docs** — typos, clarifications, and missing runbook steps are always welcome.
- **Write tests** — adding coverage to `apps/api`, `apps/desktop`, or `apps/ios` is high-value.
- **Fix issues** — look for issues labeled `good first issue` or `help wanted`.

## Security and responsible disclosure

**Do not open public issues for vulnerabilities.** If you find a security problem (credential
handling, auth bypass, order-safety, etc.), report it privately:

1. Use GitHub's **Report a vulnerability** flow
   (<https://github.com/TradeWithCash2025/0dteTrader/security/advisories/new>), or
2. Contact the maintainers directly.

See [`docs/SECURITY.md`](docs/SECURITY.md) for the threat model and what counts as sensitive.
Never commit secrets — `.env` is gitignored and real credentials live only in your local
environment.

## Prerequisites

- **Node.js >= 18.17** (see [`.nvmrc`](.nvmrc); use `nvm use`).
- **npm** — this repo uses **npm workspaces**. Do not use `yarn` or `pnpm`.
- **Docker + Docker Compose** — Postgres 16 and Redis 7 run in containers for the API.
- **macOS + Xcode 15+** and **XcodeGen** (`brew install xcodegen`) — only if you build the iOS app.

## Getting started

```bash
git clone https://github.com/Open-Source-Trader/0dteTrader.git
cd 0dteTrader
npm run setup
```

`npm run setup` is idempotent. It verifies the environment, creates `.env` from
`.env.example`, generates a `CRED_ENCRYPTION_KEY`, installs dependencies, starts Postgres +
Redis, and applies Prisma migrations. Details live in [`scripts/setup.js`](scripts/setup.js).

### Run the services

```bash
npm run dev          # API only (http://localhost:3000)
npm run dev:desktop  # Desktop Vite dev server (http://localhost:5173)
npm run dev:all      # API + desktop concurrently
```

The API always talks to the **real** Webull OpenAPI (no mock data). Without stored Webull
credentials, market-data and trading endpoints return `AUTH_FAILED` until you add practice
credentials. The options chain and GEX/DEX endpoints additionally require a
`TRADIER_API_TOKEN` in `.env`.

For the iOS app:

```bash
cd apps/ios
xcodegen
open 0dteTrader.xcodeproj
```

See the [README](README.md) for the full walkthrough, including Webull sandbox setup and the
`npm run smoke:webull` smoke test.

- TypeScript throughout (except iOS which is Swift)
- ESLint with `@typescript-eslint` (workspace configs in each app/package)
- Prettier for formatting (see `.prettierrc`)
- Prefix unused variables with `_`
- See [`AGENTS.md`](AGENTS.md) for architecture conventions and per-module gotchas. (`AGENTS.md` and `CLAUDE.md` are instruction files for AI coding assistants, kept in the repo for transparency — they double as accurate engineering documentation.)

1. **Fork** the repo and clone your fork, or create a branch off `main` if you have write access.
2. **Branch** with a descriptive name: `feat/options-chain-cache`, `fix/jwt-refresh-rotation`,
   `docs/runbook-typos`.
3. **Make changes** following the [coding conventions](#coding-conventions).
4. **Keep the diff focused.** One logical change per PR. Don't reformat files you didn't touch.
5. **Verify locally** (see [Before submitting](#before-submitting-a-pull-request)).
6. **Open a PR** against `main`. Fill in the PR template.

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short summary

Optional body explaining the "why", not the "what".
```

- **Types:** `feat`, `fix`, `chore`, `test`, `docs`, `refactor`, `perf`, `ci`.
- **Scopes:** `api`, `desktop`, `ios`, `webull`, `tradier`, `gex`, `shared-types`, `theme`, `ci`, etc.
- Use the imperative ("add retry on token expiry"), keep the summary under ~70 chars.

Example: `fix(api): rotate refresh token family on reuse detection`

Commit message format is encouraged but not enforced in CI; the pre-commit hook only runs
lint/format (see below).

## Coding conventions

### General

- Match the existing style of the file you edit; don't impose a new pattern.
- Prefer small, surgical changes. Don't reformat unrelated code in the same PR.
- Keep side effects isolated and add tests for non-trivial logic.

### TypeScript (API + Desktop + shared-types)

- **Strict mode**, no `any`.
- NestJS modules with dependency injection on the API.
- API tests: **Jest + Supertest**. Desktop tests: **Vitest**.
- Prettier for formatting, ESLint for linting (workspace configs per app/package).
- Prefix intentionally unused variables with `_`.

### Swift (iOS)

- SwiftUI + MVVM with feature folders.
- `@MainActor` on ViewModels.
- SwiftLint is configured (`.swiftlint.yml` in `apps/ios/`); CI fails on lint errors.
- `IndicatorEngine` is pure functions over `[Candle]` — keep it unit-testable.
- Design system lives in `DesignSystem/` (`AppTokens`, `HudControls`, `TradeButtons`).

### Shared patterns

- The same indicator math is ported between TS and Swift — keep them in sync.
- Desktop is the reference UI for layout; iOS copies its behavior.
- **When you change shared UI/layout behavior, update iOS and desktop together — never one without the other.**

## Before submitting a pull request

Run these locally. All of them (except the iOS steps) run automatically in CI, and a pre-commit
hook runs ESLint + Prettier on staged files.

```bash
npm run lint          # ESLint across all workspaces
npm run format:check  # Prettier check (CI also runs `npm run format`)
npm run build         # shared-types -> API -> desktop
npm run test          # all workspace tests
```

For iOS changes, also verify on a macOS machine:

```bash
cd apps/ios
swiftlint lint
xcodegen
xcodebuild test -scheme 0dteTrader -destination 'platform=iOS Simulator,name=iPhone 16'
```

**Pre-commit hook.** Husky runs `lint-staged`, which lints staged `*.{ts,tsx}` with
`--max-warnings 0` and formats staged files with Prettier. If it fails, fix and re-stage.

**PR checklist:**

- [ ] Branch is up to date with `main` and the diff is focused.
- [ ] `lint`, `format:check`, `build`, and `test` pass locally.
- [ ] New behavior has tests; bug fixes include a regression test.
- [ ] Docs updated where relevant (README, `docs/`, code comments for non-obvious logic).
- [ ] No secrets or `.env` content committed.
- [ ] Risk/credential/auth changes reviewed against `docs/SECURITY.md`.
- [ ] Linked the related issue (e.g. `Closes #123`).

## Continuous integration

CI runs on every pull request and on pushes to `main`:

- **`api` job** (Ubuntu): spins up Postgres 16 + Redis 7 service containers, then runs
  `npm ci`, `npm run lint`, `npm run build`, `npm run test`.
- **`ios` job** (macOS): installs SwiftLint + XcodeGen, lints, generates the Xcode project,
  then builds and tests the `0dteTrader` scheme on the iPhone 16 simulator.

A PR must be green before it can merge. If CI fails for an environment reason unrelated to your
change, mention it in the PR.

## Project structure

```
apps/api/              NestJS backend (auth, encrypted credential vault, market data, trading proxy)
apps/desktop/          React + Vite + Electron desktop app
apps/ios/              SwiftUI iOS app (iOS 17+)
packages/shared-types/ Shared TypeScript contracts
docs/                  Architecture, API spec, security model, Webull guide, runbook
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the module overview and
[`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md) for the deeper engineering context.

## Reporting issues

Open an issue with:

- **What you expected** to happen.
- **What actually happened** (include logs/errors; redact any credentials or tokens).
- **Steps to reproduce** — be specific and minimal.
- **Environment**: OS, Node version (`node -v`), Docker version, and which app (iOS/desktop/API).
- **Broker mode**: Webull paper or live, Tradier paper or brokerage (if relevant).

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
