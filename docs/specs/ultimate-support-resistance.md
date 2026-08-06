# Ultimate Support & Resistance

Attribution: the original MIT-licensed indicator is © @ArunaReborn / @TradeWithCash — Premium Options Trading LLC. The repository's MIT license applies to this modular port.

This implementation ports the confirmed-bar Pine v6 model into both chart clients. The validated Pine source (`Ultimate Support & Resistance`, SHA-256 `6da03c2677f78130101f6584c24a004b3a60d588739eca950bd155f3f3f2d6a8`) is the behavioral specification.

## Architecture

The indicator is a stateful chart script, not a stateless numeric series. It therefore follows the existing TWC overlay path and shares its renderer-neutral geometry instead of duplicating the generic indicator registry or chart renderer.

| Responsibility               | Desktop                                    | iOS                                           |
| ---------------------------- | ------------------------------------------ | --------------------------------------------- |
| Settings and validation      | `ultimateSupportResistance/usrSettings.ts` | `UltimateSupportResistance/UsrSettings.swift` |
| Confirmed/HTF clocks         | `usrTimeframe.ts`                          | `UsrTimeframe.swift`                          |
| Zone detection and lifecycle | `usrZones.ts`                              | `UsrEngine.swift`                             |
| Confluence and pools         | `usrDerived.ts`                            | `UsrDerivedEngine.swift`                      |
| FVG and IFVG lifecycle       | `usrFvg.ts`                                | `UsrFvgEngine.swift`                          |
| Signal arbitration           | `usrSignals.ts`                            | `UsrSignalEngine.swift`                       |
| Render projection            | `usrRender.ts`                             | `UsrRenderEngine.swift`                       |
| Orchestration                | `computeUsr.ts`                            | `UsrEngine.compute`                           |

The desktop `ScriptRenderModel` and iOS `TwcRenderModel.merging` compose stateful scripts into the existing overlay renderer. Neither analytical state nor model retention depends on proximity or visibility settings.

## Causality invariants

- The open time-based chart candle is excluded. Tick-chart arrays already contain only completed candles (the in-progress accumulator is separate), so every supplied tick candle is retained. All state transitions consume confirmed candles once.
- A higher-timeframe candle is published only at the first chart candle of the following higher-timeframe bucket. Its OHLCV, ATR, and lagged volume baseline remain aligned.
- During Wilder ATR warm-up, chart-clock logic uses Pine's 2%-of-price fallback and higher-timeframe lifecycle logic uses the latest confirmed true range.
- Detection, activation, touch, invalidation, flip, derived-area birth, and signal cooldowns use the analysis clock. Rendering uses chart indices only after analytical state is final.
- A zone cannot be touched or invalidated by its activation candle. Derived pools cannot backfill before their constituent information is available.
- Confluence never mutates authoritative zone bounds. Proximity filtering and display budgets are renderer-only.
- FVG expiry precedes inversion; mitigation milestones are monotonic; IFVG state begins only after a valid far-edge inversion.
- Signal candidates are collected without mutating source quotas. Only the winning, non-cancelled candidate commits quota and cooldown state.
- One source can emit at most one signal of a given kind on an analysis bar. Bull/bear conflicts are resolved deterministically.

## Platform contract

TradingView provides `syminfo.mintick`; the app candle model currently does not. `minimumTick` is therefore an explicit validated setting on both platforms (default `0.01`). All other defaults and input bounds mirror the Pine contract.

Custom timeframes use Pine notation (`15S`, minute counts such as `60`, `1D`, `2W`, or `3M`). Auto mode preserves Pine's calendar 1M/2M/3M/12M buckets rather than approximating them as fixed day counts.

Desktop and iOS deliberately keep separate language implementations because the repository ships independent clients. Module boundaries, event order, defaults, limits, source identities, and lifecycle rules are kept equivalent and covered by deterministic tests.
