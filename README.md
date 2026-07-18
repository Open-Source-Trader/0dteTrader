# 0dteTrader

Rapid options quick-trade iOS app backed by the official Webull OpenAPI.

- `apps/ios` — SwiftUI iPhone app (iOS 17+)
- `apps/api` — NestJS + TypeScript backend (auth, encrypted credential vault, market data, trading proxy)
- `packages/shared-types` — shared TypeScript contracts
- `docs` — PRD, architecture, API spec, security, Webull integration, runbook, roadmap

See **docs/RUNBOOK.md** to get running locally and **docs/ARCHITECTURE.md** for the system design.

> Trading involves substantial risk of loss. This software places real orders when connected to a live
> brokerage account. Always validate against the mock gateway and a paper account first.

Webull OpenAPI credentials (App Key + App Secret) are entered per-user via
`PUT /me/webull-credentials` and stored encrypted — never commit them to this repo or any file.