# TODO

Tracking file for implementation tasks. Each item is a checkable box.
Update this file as tasks are planned, started, and completed.

## Current Sprint

- [ ] (placeholder — add tasks here)

## Backlog

- [ ] Rate-limit tuning and audit review
- [ ] Cert pinning implementation
- [ ] FaceID lock for iOS
- [ ] Edge-case pass (network loss mid-order, stale quotes, market closed)
- [ ] TestFlight build and live-account go-live checklist

## Completed

- [x] Chart fixes (2026-07-19): 30m/4h via server-side aggregation (Coinbase
      rejected 1800/14400 granularities; Webull M30/M240 native-first with
      aggregation fallback), new 1w weekly interval (Monday-UTC buckets,
      aggregated from daily), tick charts reworked (10t–250t sizes, accumulator
      persistence, 1m-history seeding, progress chip), SPX/NDX/VIX index
      charting via Tradier (quotes + history/timesales, 5s stream cadence).
      Both desktop and iOS updated. Review: all unit tests green (api 290,
      desktop 128, iOS chart tests); one pre-existing AutoContractSelectorTests
      failure reproduced on clean tree (unrelated). Remaining: run
      `apps/api/src/scripts/candles-e2e-probe.ts` against the live API to
      verify Webull native M30/M240 support and Tradier index data end-to-end.
- [x] Repo and docs scaffold
- [x] Backend core (NestJS, Auth, Credentials, Trading)
- [x] iOS shell (XcodeGen, DesignSystem, APIClient)
- [x] Chart and trade UI
- [x] Real Webull gateway (code complete)
