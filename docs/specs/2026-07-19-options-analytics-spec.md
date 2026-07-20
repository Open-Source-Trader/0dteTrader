# Options Analytics Snapshot Integrity Suite

## 1. Title And Metadata

- Spec type: product, API, calculation, storage, and client behavior
- Status: approved for implementation
- Owner: 0dteTrader engineering
- Last updated: 2026-07-19
- Source templates: `docs/specs/templates/spec-template.md`

## 2. Problem Statement

The current GEX/DEX overlay presents open-interest assumptions as observed dealer exposure, scales gamma without the 1% conversion, hard-codes a UTC expiration time, silently substitutes 20% IV, and calls open interest multiplied by current mark “premium.” Provider Greek freshness, exact expiration, multiplier, quote quality, and failure provenance are not represented. The current full-width heat bands also make a present-time snapshot look historical.

The desired outcome is an honest, reproducible options-structure snapshot whose observed inputs, modeled outputs, assumptions, units, source ages, and partial failures are visible to both clients and persisted for later validation.

## 3. Goals And Non-Goals

### Goals

- Calculate local IV, delta, and gamma from validated two-sided quotes using one pricing kernel.
- Express gamma exposure as USD delta change per 1% underlying move.
- Keep call, put, and gross structure separate from optional dealer-position scenarios.
- Provide implied expiry range, straddle breakevens, independent call/put walls, all gamma-proxy roots, marked-OI value, and liquidity.
- Return only an exact requested expiration with explicit source quality and warnings.
- Persist idempotent one-minute snapshots and compact them to five-minute history.
- Present the same terminology and defaults on desktop and iOS.

### Non-Goals

- Claiming observed dealer inventory, participant intent, opening/closing direction, or signed trade flow.
- Adding a public history API in this version.
- Implementing skew, vanna, charm, risk-neutral density, max pain, or put/call ratio in this version.

## 4. Scope

In scope: shared contracts, Tradier normalization, pricing and exposure engine, exact-expiration service/cache, session calendar, Prisma snapshot capture, desktop and iOS Options Structure overlays, documentation, tests, and operational metadata.

Out of scope: order execution behavior, Webull market-data behavior, unrelated chart indicators, and repair of unrelated dirty files in the original `main` worktree.

## 5. Context And Dependencies

- NestJS API, Prisma/PostgreSQL, React/Electron desktop, SwiftUI/DGCharts iOS.
- Tradier quotes may be real-time or delayed while provider Greeks have independent timestamps.
- OI is descriptive and does not reveal bullish/bearish direction or dealer inventory.
- U.S. option settlement uses America/New_York session rules with product-specific AM/PM settlement.

## 6. Requirements

- **REQ-001 (must):** `GET /v1/market/options-analytics` requires a symbol and exact expiration and never substitutes another expiration. Internal scheduled core capture may resolve the nearest listed expiration before calling the calculation service. Validate with controller/service tests.
- **REQ-002 (must):** Every snapshot identifies observation time, expiration, spot, forward, exposure unit, calculation version, feed mode, quote/Greek/OI ages, coverage, status, and warnings. Validate with contract fixtures.
- **REQ-003 (must):** Gamma exposure equals `gamma * OI * multiplier * spot^2 * 0.01`. Validate with golden vectors and multiplier tests.
- **REQ-004 (must):** Missing or invalid IV is never replaced by an undocumented constant. Quote-invalid contracts are excluded; quote-valid observations remain usable with all model-dependent fields set to `null`, including an all-observed snapshot. Coverage and warnings disclose the modeling loss. Validate with malformed-chain and all-observed tests.
- **REQ-005 (must):** Current and scenario exposure use the same pricing kernel and volatility inputs. Validate with finite-difference and root tests.
- **REQ-006 (must):** Call wall, put wall, max-OI strike, every gamma-proxy root, and nearest root are calculated independently and deterministically. Validate with cancellation, exact-zero, and multiple-root chains.
- **REQ-007 (must):** Implied forward uses synchronized call/put pairs and implied range uses ATM IV and remaining settlement time. Straddle breakevens are separate. Validate with golden vectors.
- **REQ-008 (must):** Marked OI and liquidity are separate layers; neither is named premium or flow. Validate contract and UI string scans.
- **REQ-009 (must):** Expired contracts produce no modeled exposure. DST, early-close, AM/PM, and post-expiration behavior are tested.
- **REQ-010 (must):** Cache entries are exact-keyed, age/size bounded, in-flight deduplicated, and never fall back to another expiration.
- **REQ-011 (must):** Core SPY/QQQ/IWM/SPX and viewed symbol/expiration snapshots are captured at most once per minute during the configured market session.
- **REQ-012 (must):** One-minute records retain 30 days; five-minute compact records retain one year; capture, compaction, and cleanup are observable.
- **REQ-013 (must):** Desktop and iOS default to implied range and gross gamma; marked OI, liquidity, and dealer proxy default off.
- **REQ-014 (must):** The current snapshot renders as a right-edge/current-session profile, never as historical full-width heat.
- **REQ-015 (must):** Both clients cancel obsolete requests and reject responses for an old symbol or expiration.
- **REQ-016 (must):** Both clients expose an accessible summary of expiration, units, ages, quality, range, walls, and roots.

The V1 volatility representation is a discrete sticky-strike smile: each retained contract's locally solved IV is held fixed while that contract is repriced across the scenario spot grid. Current Greeks, scenario exposures, and root refinement all use that same IV set and Black forward kernel. V1 does not claim an interpolated continuous surface between listed strikes.

- **REQ-017 (must):** The old GEX endpoint, DTOs, settings keys, comments, UI names, and dead code are removed without compatibility aliases.

## 7. User/System Flows

Primary request: validate query, fetch exact chain and underlying quote, normalize/validate inputs, derive forward/IV/Greeks, aggregate observed facts and optional scenario, attach quality, persist the viewed snapshot idempotently, and return it.

Scheduled capture: on a minute boundary during an open session, resolve current expirations for configured core symbols, deduplicate keys, calculate snapshots, persist successes, and record failures without inventing data.

Error flows: exact expiration unavailable returns 404; no valid observed inputs returns 503; quote-valid but unmodelable inputs return a partial observed snapshot with nullable modeled layers and warnings; stale exact-key cache may be returned only inside its hard age with its cache state exposed.

## 8. Data/Interface Contracts

`OptionsAnalyticsSnapshot` contains:

- `scope`: requested symbol, exact modeled root symbol, AM/PM settlement style, expiration, observedAt, settlementAt, spot, and forward. This product provenance prevents a mixed SPX/SPXW chain from being presented as one instrument.
- `exposureUnit`: literal `$ delta change per 1% underlying move`.
- `quality`: quoteAsOf, greeksAsOf, oiEffectiveDate, feedMode, coverage, status, warnings, calculationVersion, cacheStatus.
- `structure`: nullable modeled call/put/gross gamma exposure, nullable call/put delta notional, independent walls, grossGammaConcentration, and descriptive maxOpenInterestStrike. A modeled total is `null`, never zero, when its side has no modeled leg.
- `scenarios.callPutDealerProxy`: nullable explicitly labeled call-minus-put positioning scenario with gamma/delta exposure, every proxy root, and the root nearest spot.
- `impliedRange`: lower, upper, confidence `0.68`, label, ATM IV, and straddle breakevens.
- `strikes`: nested call/put observations and modeled values plus gross exposure and liquidity.

`OptionsAnalyticsSnapshotRecord` uses a unique symbol/expiration/minute/calculation-version key and stores capture reason, quality, normalized input JSON, derived output JSON, compaction level, and timestamps.

This is a breaking internal contract. No `/market/gex` alias or old field compatibility is allowed.

## 9. Observability And Operations

- Structured logs: calculation coverage/warnings, exact-expiration misses, cache state, provider throttling, capture result, compaction, and cleanup.
- Counters: requested/calculated/partial/failed snapshots, provider throttles, cache hits, capture writes/deduplications/failures, compaction/deletion totals.
- Runbook documents token requirements, feed-mode caveats, retention, and safe capture disabling.

## 10. Security, Privacy, And Compliance

Snapshot data is public market data with no user identifiers. Tradier credentials remain server-side. The existing authenticated API guard remains in force. Stored viewed captures contain only symbol/expiration and no account or order data.

## 11. Acceptance Criteria

- Given a golden chain, when analytics run, then values match the documented formulas and independent reference tolerances.
- Given July and January 0DTE expirations, when time remains, then EDT/EST settlement and gamma are correct.
- Given stale, crossed, or one-sided quotes, when analytics run, then quote-invalid contracts are excluded and warnings/coverage identify the loss.
- Given quote-valid contracts whose IV cannot be solved, when analytics run, then observed OI/liquidity remains available and unavailable model fields, totals, range, and scenario are `null`.
- Given multiple roots, when the scenario curve is scanned, then all roots are returned and the nearest spot root is primary.
- Given a requested unavailable expiration, when the API is called, then no different expiration is returned.
- Given concurrent identical requests, when the provider is slow, then only one in-flight calculation occurs.
- Given repeated scheduled/viewed capture in one minute, when persisted, then one record per unique key exists.
- Given either client, when enabled with defaults, then implied range and gross gamma appear with provenance and no dealer proxy.
- Given a symbol/expiration change, when an older response completes, then it cannot overwrite the current selection.
- Given the shipped tree, when searched, then no obsolete GEX contract or misleading premium-heat language remains.

## 12. Risks And Mitigations

- Sparse/wide quotes: quality filters, nullable layers, and coverage warnings.
- Provider rate limits: correct headers, bounded exact-key cache, in-flight dedupe, and staggered core capture.
- Model risk: facts first, scenarios off by default, visible units/assumptions/version.
- Storage growth: unique minute keys, compaction, retention cleanup, and metrics.
- Client drift: canonical fixture and parity tests.

Rollback is a branch/release rollback plus disabling scheduled capture. No old endpoint shim is retained.

## 13. Rollout Plan

1. Land schema/engine/provider and record shadow snapshots.
2. Compare golden and recorded snapshots against an independent reference.
3. Land synchronized API and client contract migration.
4. Enable core capture in configured environments.
5. Keep the refreshed indicator disabled by default until shadow validation is accepted.

## 14. Open Questions

None blocking. Later indicator versions require a separate design and data-source review.
