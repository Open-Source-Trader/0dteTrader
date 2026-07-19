# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Pre-commit hooks with husky and lint-staged
- CONTRIBUTING.md, LICENSE, and CHANGELOG.md
- `tasks/` directory for task tracking

## [0.1.0] - 2025-07-19

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
