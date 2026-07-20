# UI/UX Audit — Summary & Master Report

**Scope:** every screen of `apps/ios/` (SwiftUI, iOS 17, iPhone-only) and `apps/desktop/` (React 18 + Electron, 430×932 phone-frame clone) — 35 audit units, 18 iOS + 17 desktop.
**Bar:** Apple (HIG, polish) × Robinhood (delight, motion, simplicity) × TradingView (density, data-viz).
**Method:** per-screen code pass + visual pass. Desktop visuals are real headless-Chrome screenshots (`shots/`); iOS visuals are `UNVERIFIED-VISUAL` code-driven reconstructions (Linux machine, no Xcode — re-verify on a Mac before shipping fixes).
**Totals:** **441 findings — 7× P0 · 152× P1 · 172× P2 · 110× P3.** Per-screen detail: `screens/*.md`. Checklist: `INVENTORY.md`.

**Verdict:** the app is functional and coherent, but it is not yet at the Apple/Robinhood/TradingView bar. Average screen scores **51/100 (iOS)** and **52/100 (desktop)**. The gap is concentrated and fixable: illegible primary CTAs, clipped trade ticket, broken chart pane sync, zero press/hover/focus feedback, dead-end error states, and missing dimensional design tokens.

---

## 1. Master scorecard (worst → best)

| #   | Screen                        | App     | Overall |  P0 |  P1 |  P2 |  P3 |
| --- | ----------------------------- | ------- | ------: | --: | --: | --: | --: |
| 1   | Drawing overlay               | iOS     |  **40** |   0 |   5 |   7 |   4 |
| 2   | Chart view + panes            | iOS     |  **43** |   1 |   5 |   5 |   3 |
| 3   | Trade — fullscreen (Layout A) | Desktop |  **43** |   0 |   5 |   6 |   4 |
| 4   | Design system                 | Desktop |  **44** |   1 |   4 |   8 |   4 |
| 5   | Trade panel                   | Desktop |  **46** |   2 |   7 |   3 |   4 |
| 6   | Chart view + panes            | Desktop |  **47** |   0 |   8 |   5 |   2 |
| 7   | Risk disclaimer               | Desktop |  **48** |   0 |   3 |   3 |   4 |
| 8   | Drawing layer + toolbar       | Desktop |  **48** |   0 |   4 |   4 |   4 |
| 9   | Root / lock overlay           | iOS     |  **48** |   0 |   3 |   4 |   3 |
| 10  | Register                      | iOS     |  **48** |   0 |   6 |   5 |   1 |
| 11  | History                       | iOS     |  **48** |   0 |   5 |   4 |   3 |
| 12  | Positions strip               | iOS     |  **48** |   0 |   4 |   4 |   3 |
| 13  | Design system                 | iOS     |  **48** |   0 |   5 |   6 |   5 |
| 14  | Login                         | iOS     |  **49** |   0 |   7 |   5 |   2 |
| 15  | Trade — fullscreen (Layout A) | iOS     |  **49** |   0 |   4 |   5 |   1 |
| 16  | Risk disclaimer               | iOS     |  **50** |   0 |   4 |   3 |   2 |
| 17  | Order confirm                 | Desktop |  **50** |   0 |   6 |   6 |   3 |
| 18  | Positions strip               | Desktop |  **50** |   0 |   4 |   5 |   5 |
| 19  | Order confirm                 | iOS     |  **51** |   0 |   5 |   6 |   1 |
| 20  | Register                      | Desktop |  **53** |   0 |   5 |   6 |   2 |
| 21  | Floating trade buttons        | iOS     |  **54** |   0 |   4 |   4 |   3 |
| 22  | Toast                         | iOS     |  **54** |   1 |   2 |   4 |   2 |
| 23  | Trade — split (Layout B)      | Desktop |  **55** |   0 |   3 |   4 |   3 |
| 24  | Phone shell + status bar      | Desktop |  **55** |   0 |   3 |   6 |   3 |
| 25  | Trade panel                   | iOS     |  **55** |   1 |   4 |   6 |   3 |
| 26  | Trade — split (Layout B)      | iOS     |  **56** |   1 |   3 |   3 |   1 |
| 27  | Symbol search                 | iOS     |  **56** |   0 |   4 |   4 |   3 |
| 28  | Login                         | Desktop |  **56** |   0 |   5 |   4 |   3 |
| 29  | History                       | Desktop |  **56** |   0 |   4 |   5 |   3 |
| 30  | Profile                       | Desktop |  **56** |   0 |   5 |   6 |   3 |
| 31  | Indicator settings            | iOS     |  **60** |   0 |   4 |   5 |   4 |
| 32  | Indicator settings            | Desktop |  **60** |   0 |   3 |   7 |   5 |
| 33  | Symbol search                 | Desktop |  **61** |   0 |   4 |   5 |   5 |
| 34  | Toast                         | Desktop |  **63** |   0 |   2 |   3 |   4 |
| 35  | Profile                       | iOS     |  **64** |   0 |   3 |   6 |   5 |

**Averages: iOS 51.2 / desktop 52.4.** Weakest criteria fleet-wide: Motion (avg ≈3.5), A11y (≈3.7), State coverage (≈4.4). Strongest: Density (≈6.6). Nothing scores ≥8 on Motion anywhere — there is no motion system.

---

## 2. Prioritized fix backlog

### P0 — ship-blocking (7)

1. **Trade ticket clips BUY/SELL at allowed split heights — both platforms.** Panel floor 120–199px vs ≈264–334px of content; `overflow: hidden` hides the action row.
   - iOS: `TradePanelView.swift:13-51` (no ScrollView), `TradeScreenView.swift:178,192` → wrap in ScrollView, pin actions to bottom.
   - Desktop: `TradePanel.tsx:66`, `TradeScreen.tsx:154,246` → raise floor to 300px / fraction 0.34, `overflowY: 'auto'`.
2. **White CTA text on BUY/accent fills fails WCAG AA fleet-wide** — 2.61:1 on `#19b85b`, 3.15:1 on `#568ff7`. Add fill variants: `--buy-green-fill #0e7c3a` (5.30:1), `--sell-red-fill #c62830` (5.60:1), `--app-accent-fill #2f6be0` (4.88:1). See `screens/desktop-design-system.md` (P0) and `screens/ios-design-system.md`.
3. **iOS indicator sub-panes never align with the main chart viewport** — panes pin x-range to all 400 candles while the chart shows 120; every indicator reads against the wrong candles. `CandleChartRepresentable.swift:174-177`, `IndicatorPaneRepresentable.swift:104-105` → drive panes from the main chart's visible range.
4. **iOS toast renders inside the status bar / Dynamic Island region** — overlay attached to the full-screen NavigationStack, capsule top 55pt above the safe-area top. `TradeScreenView.swift:68-76` → move overlay inside content, add spring.
5. **Desktop chain-load failure silently kills BUY/SELL** — `ChainStore.errorMessage` is written but rendered nowhere; user sees "No contract" + dead buttons with no reason or retry. `TradePanel.tsx:150-172`, `ChainStore.ts:158,220`.
6. **iOS divider hit target is 18pt** (< half the 44pt HIG minimum) on the primary screen's only resize affordance. `TradeScreenView.swift:223,230,232` → keep 18pt visual, expand contentShape to 44pt.
7. (Same root as 1, iOS side is its own P0 in `screens/ios-trade-panel.md`.)

### P1 — quality bar (152), grouped by theme

- **Contrast & legibility (~15 screens):** CTA fills (above), `.dimmed` dims label text to ~2:1, `appBorder` 1.65:1 used for interactive grabbers, `pnl-negative`/`app-accent` text fail AA on elevated surfaces, zero-P/L rendered positive-green.
- **Hit targets below 44pt (~14 screens):** navbar icons 20–22px, cancel-order 17–20px, header chart controls 27–31px, QuickChip 32pt, steppers, "Create an account" link.
- **Zero interaction feedback (fleet-wide):** no press states on any custom iOS button (`.buttonStyle(.plain)`); no hover, no `:focus-visible` (`outline: none` global), no active-drag state anywhere on desktop.
- **Numeric typography (~10 screens):** live prices/P&L in proportional fonts → chip-width jitter on every tick; `Font.priceMedium` / `tabular-nums` exist but are unused outside the chart header; no thousands grouping.
- **Error states are dead ends (~10 screens):** chart error names the fix but gives no action; session restore spins up to 60s then dumps to login; history/profile/register errors have no retry, no announcement; register validation messages computed but never rendered.
- **Sheet/dialog semantics (desktop, 6 sheets):** no `role="dialog"`, no focus trap, no initial focus, no Escape handling; order-confirm dismissible mid-submission.
- **VoiceOver/screen-reader (~12 screens):** drawing canvases are total black holes; lock overlay leaks the trade screen behind it; unlabeled toggles/steppers; toasts not announced; positions strip labels omit quantity and P&L.
- **Token bypass (~20 hardcoded hexes on desktop, iOS inline values):** `CandleChart.tsx:33-40`, `ChartView.tsx:15-22` + 2 more files duplicate `--chart-*` tokens; P&L green/red rendered by two different token pairs across screens.
- **Data-viz:** crosshair disabled + no OHLC legend on desktop; no crosshair at all on iOS; desktop sub-pane x-axis unsynced (iOS P0 sibling); fullscreen chart bleeds behind SELL/BUY with no scrim; TradingView attribution glyph overlaps the SELL button in fullscreen.
- **Dangerous defaults:** "Clear all drawings" is instant, unrecoverable, no confirm/undo (both platforms); zero-length drawings persisted as undeletable junk; desktop Backspace deletes without confirm.
- **Toast:** iOS P0 (above) + style tint is a sub-3:1 ring; desktop toast pops out instantly while iOS animates both directions.

Full per-finding detail with exact fixes: `screens/*.md` (each finding has `file:line` + verbatim-applicable fix).

---

## 3. Consolidated design-token proposal

Neither platform has dimensional tokens today (spacing/radius/elevation/motion) — 30+ inline magic values on iOS, ~120 inline `style={{}}` sites on desktop. Proposed shared system (values identical on both platforms; iOS as `DesignSystem/AppTokens.swift`, desktop as additions to `tokens.css`):

**Color — split every action hue into text vs fill variants** (measured, WCAG AA-passing):

| Token               | Value     | White-text contrast               | Use                          |
| ------------------- | --------- | --------------------------------- | ---------------------------- |
| `--buy-green`       | `#19b85b` | 2.61:1 ✗ (7.49:1 as text on bg ✓) | text, borders, chart candles |
| `--buy-green-fill`  | `#0e7c3a` | **5.30:1** ✓                      | BUY/Confirm button fills     |
| `--sell-red`        | `#e13a43` | 4.30:1 ✗ (4.55:1 as text ✓)       | text, borders                |
| `--sell-red-fill`   | `#c62830` | **5.60:1** ✓                      | SELL button fills            |
| `--app-accent`      | `#568ff7` | 3.15:1 ✗                          | text, icons, links           |
| `--app-accent-fill` | `#2f6be0` | **4.88:1** ✓                      | primary button fills         |

**Spacing (8pt grid):** `2 / 4 / 8 / 12 / 16 / 20 / 24 / 32` — snap offenders: 7→8, 14→12 or 16, 22→24.
**Radius:** `sm 8 · md 10 · lg 12` (+2.5 one-off for the divider grabber).
**Elevation:** `toast: black 40%, radius 8, y 4`; sheet: `black 50%, radius 16, y 8`. Add a z-index scale on desktop (`base 0 · chart-overlay 10 · sheet 20 · toast 30`).
**Motion:** iOS `quick = .snappy(0.15)`, `standard = .spring(response: 0.3, dampingFraction: 0.8)`; desktop `120–200ms cubic-bezier(0.2, 0, 0, 1)` for hovers/presses, `200–250ms` for sheets/toasts; `prefers-reduced-motion` / Reduce-Motion fallbacks everywhere (spinner, toast, sheets, layout toggle).
**Typography:** one rule — _every_ price, P&L, quantity, and percentage uses tabular figures (iOS `Font.priceMedium/Small`, desktop `font-variant-numeric: tabular-nums` + `--font-mono`), plus thousands grouping in `Formatters.swift` / `format.ts`.
**Opacity:** single `disabled = 0.35` token (hand-duplicated in 4 iOS files today) + a rule that disabled buttons also dim the fill, not just the label.

## 4. "Holy shit" opportunities (highest leverage)

1. **Fix the trade ticket end-to-end.** It is the app's reason to exist and holds 4 of 7 P0s: clipped actions, illegible CTAs, silent chain failures, tiny hit targets. A ticket that is always visible, legible in sunlight, springs under the finger with haptics, and explains itself when broken is the single biggest quality leap. (Screens: trade-panel ×2, order-confirm ×2, floating-buttons.)
2. **Make the chart TradingView-grade.** Sync indicator pane viewports (iOS P0 + desktop P1), add crosshair + OHLC legend, skeleton loading that matches final layout, chart bottom inset so floating buttons never occlude the last-price line, and route all chart colors through the dead `--chart-*` tokens. The chart occupies ~60% of the primary screen — it _is_ the product's first impression.
3. **Build the motion system.** Currently zero press states, zero springs, hard cuts on layout toggle, instant toast exit, unconditional spinner/rAF loops. One token layer (§3) + a press-state modifier applied to every custom control + spring-based sheet/toast transitions would transform feel more than any visual restyle — this is the Robinhood gap.
4. **Give every destructive or async action a designed state.** Skeletons over spinners, actionable error cards (reason + retry + where to fix), undo/confirm for "Clear all drawings", submission locks on order confirm, offline/timeout state for session restore. This converts the app's worst moments (its current dead ends) into trust-builders.
5. **Symbol search → market-data command palette.** Rows currently show a bare ticker; free text is accepted and fails silently downstream. Add name, last price, day change, and a sparkline per row, keyboard navigation with Enter-commits-top-match, and validation against the shared catalog (deduplicate the hardcoded 31-symbol list across platforms). Cheap to build, disproportionately premium feel.

---

## Appendix

- **How desktop screenshots were produced:** Vite dev server + local API (mock broker) + Postgres, driven by headless Chrome (`docs/ui-audit/.tools/shoot.mjs`, `shoot2.mjs`, throwaway registered account). No broker credentials were configured, so chart screens show their genuine no-credentials error state and the order-confirm sheet could not be triggered (`UNVERIFIED-VISUAL` on both platforms for that screen).
- **iOS re-verification:** every iOS finding is code-derived; rerun the visual pass on macOS/Xcode (simulator screenshots) before applying layout fixes.
- **Not modified:** no app source files were changed. Audit artifacts only: `INVENTORY.md`, `SUMMARY.md`, `screens/` (35 files), `shots/` (11 screenshots), `.tools/` (capture scripts — safe to delete).
