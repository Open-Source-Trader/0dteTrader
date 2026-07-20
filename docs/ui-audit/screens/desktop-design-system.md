# Screen d17: Desktop design system (cross-cutting deep dive)

- **App:** Desktop
- **Location:** `apps/desktop/src/design/tokens.css`, `design/base.css`, `design/components/components.css`, `design/icons.tsx`, `design/format.ts`, `design/components/*.tsx`; bypass sweep across `apps/desktop/src/features/**` (key refs: `features/chart/CandleChart.tsx:33-40`, `features/chart/ChartView.tsx:15-22`, `features/chart/DrawingLayer.tsx:7-8`, `features/chart/IndicatorPane.tsx:50`, `features/trade/PositionsStrip.tsx:17-24`)
- **Visual:** UNVERIFIED-VISUAL — code-only deep dive per assignment; geometry reconstructed from CSS/TSX values (430×932 frame, 59px status bar, 44px navbar, 50/52px buttons)
- **Scores:** Composition 5/10 · Typography 6/10 · Color 4/10 · Density 6/10 · DataViz 5/10 · Motion 4/10 · States 4/10 · Platform 3/10 · A11y 3/10 · Consistency 4/10 → **Overall 44/100**
- **Score justifications:**
  - **Composition 5:** radii/heights tokenized (`--radius-*`, `--h-*`) and the 430×932 frame is disciplined, but there is no spacing scale — 120+ inline `gap`/`padding` values in features with off-grid numbers (7px, 22px).
  - **Typography 6:** faithful iOS type scale (`--fs-*` 11–34px) + real mono stack; docked for inconsistent tabular figures (only `ChartView.tsx:162,172` sets `fontVariantNumeric`), no line-height or weight tokens, 9px axis labels.
  - **Color 4:** semantic token set is genuinely good and P&L green/red read well on bg (9.67:1 / 5.74:1), but the three most important painted surfaces — accent/green/red action buttons with white text — all fail WCAG AA (3.15:1 / 2.61:1 / 4.30:1 vs 4.5:1 required).
  - **Density 6:** caption/caption2 tokens + 32px controls enable TradingView-grade density; `fontSize: 9` (`IndicatorPane.tsx:51`) crosses into illegible.
  - **DataViz 5:** gridline restraint is excellent (`--chart-grid` = 1.17:1, properly subordinate), left-axis mono labels are right; docked for dead `--chart-*` tokens duplicated as JS hex in 4 files, no chart skeleton (spinner instead), crosshair fully disabled.
  - **Motion 4:** `--sheet-anim: 300ms cubic-bezier(0.32, 0.72, 0, 1)` is a correct iOS spring-approximation and toggle uses 200ms — but there are zero press states, zero hover states, no `prefers-reduced-motion`, and an infinite spinner.
  - **States 4:** disabled (`.dimmed`, opacity .35), loading (Spinner), and error text exist; no skeletons anywhere, no empty-state component, `AlertDialog` lacks the Escape handler `Sheet`/`Menu` both have.
  - **Platform 3:** `cursor: pointer` and Escape-to-dismiss are the only desktop concessions; no `:hover` on any control, no `:focus-visible` (and `outline: none` at `base.css:75` actively removes focus), no keyboard navigation in menus, hit targets down to 17×17px.
  - **A11y 3:** `Toggle` (`role="switch"`), `Stepper` aria-labels, and P&L sign-not-just-color (`Format.signedPrice` emits `+`/`-`) are real wins; failed by invisible focus, missing dialog/menu roles, no focus trap, contrast failures on primary actions.
  - **Consistency 4:** primitives are reused (Sheet, Menu, NavBar, Toggle…), but ~120 inline `style={{}}` sites in features, hardcoded hex in 7 feature files, and `components.css` itself hardcodes `rgba(40,43,53,.96/.98)` instead of the elevated token.

## Findings

### [P0] — White text on BUY/SELL/accent action buttons fails WCAG AA (worst: 2.61:1)

- **What/Why:** The three most consequential painted surfaces in a trading app put white 17px/600 text on fills that don't clear 4.5:1 for normal-size text (17px semibold is below the WCAG "large text" 18.66px-bold threshold). Measured: white on `--app-accent #568ff7` = **3.15:1** (`.button-primary`, base.css:106-117 — Login/Register/Accept); white on `--buy-green #19b85b` = **2.61:1** (`TradeActionButton` via `FloatingTradeButtons.tsx:21`, `TradePanel.tsx:326`, and the Confirm button `OrderConfirmSheet.tsx:171-173`); white on `--sell-red #e13a43` = **4.30:1**. Violates Color&Contrast; the Confirm-Buy label at 2.61:1 is effectively decorative in bright ambient light.
- **Location:** `apps/desktop/src/design/tokens.css:10-12`, `apps/desktop/src/design/base.css:106-117`, `apps/desktop/src/design/components/components.css:331-341`, `apps/desktop/src/features/trade/OrderConfirmSheet.tsx:166-184`
- **Exact fix:** Keep the bright hues for text-on-dark (they pass: green 7.49:1, red 4.55:1 on `--app-background`) and add dedicated fill variants in `tokens.css`:
  ```css
  --app-accent-fill: #2f6be0; /* white text: 4.88:1 */
  --buy-green-fill: #0e7c3a; /* white text: 5.30:1 */
  --sell-red-fill: #c62830; /* white text: 5.60:1 */
  ```
  In `base.css:112` change `.button-primary { background: var(--app-accent); }` → `var(--app-accent-fill)`. In `FloatingTradeButtons.tsx:15,21`, `TradePanel.tsx:320,326`, and `OrderConfirmSheet.tsx:26` swap `'var(--buy-green)'/'var(--sell-red)'` → `'var(--buy-green-fill)'/'var(--sell-red-fill)'` (button-fill usage only; keep the original tokens for text/border usage).

### [P1] — Keyboard focus is invisible: `outline: none` with zero `:focus-visible` replacement

- **What/Why:** `base.css:75` sets `input { outline: none }`, buttons get no outline by default, and a grep of all of `src/` finds **no `:focus` or `:focus-visible` rule anywhere**. On a mouse/keyboard desktop app, tabbing through Login → Trade → Confirm shows no focus ring. Violates Accessibility (WCAG 2.4.7) and Platform Fidelity.
- **Location:** `apps/desktop/src/design/base.css:71-77` (and absence in `design/components/components.css`)
- **Exact fix:** Append to `base.css`:
  ```css
  :focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: 2px;
    border-radius: inherit;
  }
  input:focus-visible {
    outline-offset: 0;
    box-shadow: 0 0 0 2px var(--app-accent);
  }
  ```

### [P1] — Zero hover states on any control (desktop)

- **What/Why:** The only interactive-state style in the entire design system is `.menu-item:active` (`components.css:240-242`). Buttons, chips, segmented segments, grouped rows, navbar buttons have no `:hover` — the app feels dead under a cursor, the exact opposite of the Robinhood fluid-feedback bar. Violates Platform Fidelity and Motion&Micro-interactions.
- **Location:** `apps/desktop/src/design/components/components.css` (absence; contrast with line 240)
- **Exact fix:** Add hover fills using the existing track token, e.g. append to `components.css`:
  ```css
  .button-primary:hover:not(:disabled) {
    filter: brightness(1.12);
  }
  .trade-action-button:hover:not(:disabled) {
    filter: brightness(1.12);
  }
  .quick-chip:hover,
  .chip-button:hover {
    background: color-mix(in srgb, var(--app-surface-elevated) 70%, var(--label-primary) 6%);
  }
  .segmented .segment:hover:not(.selected) {
    background: rgba(118, 118, 128, 0.12);
  }
  .grouped-row:is(button):hover {
    background: rgba(118, 118, 128, 0.12);
  }
  .navbar-icon-button:hover,
  .navbar-text-button:hover {
    opacity: 0.7;
  }
  ```

### [P1] — `--chart-*` tokens are dead; chart colors duplicated as JS hex in 4 files

- **What/Why:** `tokens.css:21-32` defines 12 `--chart-*` variables that **nothing consumes** (grep for `var(--chart-` returns zero hits outside tokens.css). The same values are hardcoded in JS because canvas/lightweight-charts can't read CSS vars: `CandleChart.tsx:34-40` (`#30d158`, `#ff453a`, axis/grid rgba), `ChartView.tsx:16-23` (6 overlay hexes) plus `ChartView.tsx:81,94-95,98-99,112-113,129` (RSI/MACD/Stoch/ATR), `IndicatorPane.tsx:50,115` (axis text, guide line), `DrawingLayer.tsx:7-8,131,187,192` (`#568ff7`, `#ff9f0a`, `#0b0c10`, `#fff`), `CandleChart.tsx:259` (volume `rgba(48,209,88,.45)`). The "Mirror tokens.css" comment at `CandleChart.tsx:33` is a manual-sync pact that will drift. Violates Consistency (single source of truth).
- **Location:** `apps/desktop/src/design/tokens.css:21-32`, `apps/desktop/src/features/chart/CandleChart.tsx:33-40,259`, `features/chart/ChartView.tsx:15-22,81,94-99,112-113,129`, `features/chart/IndicatorPane.tsx:50,115`, `features/chart/DrawingLayer.tsx:7-8,131,187,192`
- **Exact fix:** Create `apps/desktop/src/design/chartColors.ts` as the one source and make CSS the consumer, not the parallel copy:
  ```ts
  export const chartColors = {
    sma: '#ff9f0a',
    ema: '#64d2ff',
    vwap: '#bf5af2',
    bbOuter: '#8e8e93',
    bbMiddle: '#40cbe0',
    rsi: '#ffd60a',
    macd: '#0a84ff',
    macdSignal: '#ff9f0a',
    candleUp: '#30d158',
    candleDown: '#ff453a',
    axisLabel: 'rgba(235, 235, 245, 0.6)',
    grid: 'rgba(84, 84, 88, 0.25)',
    axisBorder: 'rgba(84, 84, 88, 0.4)',
    guideLine: 'rgba(142, 142, 147, 0.6)',
    volumeUp: 'rgba(48, 209, 88, 0.45)',
    volumeDown: 'rgba(255, 69, 58, 0.45)',
    accent: '#568ff7',
    alert: '#ff9f0a',
    priceTagText: '#0b0c10',
    handle: '#ffffff',
    rectFill: 'rgba(86, 143, 247, 0.12)',
  } as const;
  ```
  Replace every literal above with `chartColors.*`, and in `tokens.css` replace the 12 hex literals with a comment `/* Canonical values live in design/chartColors.ts (canvas can't read CSS vars); kept in sync by design/chartColors.test.ts */` — plus a unit test asserting `chartColors.sma === getComputedStyle(document.documentElement).getPropertyValue('--chart-sma').trim()` for each key.

### [P1] — `pnl-negative` and `app-accent` text fail AA on elevated surfaces

- **What/Why:** Both pass on `--app-background` (red 5.74:1, accent 6.21:1) but fail where they're actually rendered — on `--app-surface-elevated #282b35`: `--pnl-negative #ff453a` = **4.14:1** (`.grouped-row.destructive` on `.section-card`, `components.css:394-397,424-426`; `.alert-button.destructive` on the alert card, `components.css:163-169,191-193`) and `--app-accent #568ff7` = **4.48:1** (`.grouped-row.button-row`, `.alert-button`, `components.css:182-189,420-422`). Also `#e13a43` (sell-red) text on bg = 4.55:1 — a rounding error from failing. Violates Color&Contrast.
- **Location:** `apps/desktop/src/design/tokens.css:12,15`, `apps/desktop/src/design/components/components.css:163-197,394-426`
- **Exact fix:** Add text-on-surface variants in `tokens.css`:
  ```css
  --app-accent-text: #6b9ff8; /* 5.34:1 on elevated, 7.39:1 on bg */
  --pnl-negative-text: #ff6961; /* 5.01:1 on elevated, 6.93:1 on bg */
  ```
  In `components.css` use `--app-accent-text` for `.navbar-text-button`, `.navbar-icon-button`, `.alert-card .alert-button`, `.grouped-row.button-row`, and `--pnl-negative-text` for `.alert-button.destructive` and `.grouped-row.destructive`. Keep the original tokens for fills and chart series.

### [P2] — No spacing scale tokens; 120+ inline style sites with off-grid values

- **What/Why:** The entire spacing system is one token (`--pad-screen: 24px`, used by only 3 auth views). Everything else is inline magic numbers: ~120 `style={{}}` occurrences across `features/`, including off-4pt-grid values — `PositionsStrip.tsx:18` `padding: '7px 10px'` (7px), `components.css:377` `gap: 22px` in `.grouped-list`, `components.css:36` `gap: 7px` in status glyphs, `PositionsStrip.tsx:38` `gap: 6`. Violates Composition (8pt grid) and Consistency.
- **Location:** `apps/desktop/src/design/tokens.css:63`, `apps/desktop/src/features/trade/PositionsStrip.tsx:17-24,38`, `apps/desktop/src/design/components/components.css:36,377`
- **Exact fix:** Add to `tokens.css`:
  ```css
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  ```
  Snap offenders: `PositionsStrip.tsx:18` → `padding: '8px 12px'` (i.e. `var(--space-2) var(--space-3)`); `components.css:377` → `gap: var(--space-6)` (22→24); `components.css:36` → `gap: var(--space-2)` (7→8).

### [P2] — No elevation tokens: four one-off shadows

- **What/Why:** Shadows are invented per-component: `components.css:214` `0 10px 40px rgba(0,0,0,0.55)` (menu), `:268` `0 1px 4px rgba(0,0,0,0.25)` (segmented knob), `:295` `0 2px 5px rgba(0,0,0,0.3)` (toggle knob), `:454` `0 0 6px rgba(0,0,0,0.45)` (toast). Violates token coverage (elevation) and Consistency.
- **Location:** `apps/desktop/src/design/components/components.css:214,268,295,454`
- **Exact fix:** Add to `tokens.css` and reference:
  ```css
  --shadow-knob: 0 1px 4px rgba(0, 0, 0, 0.25);
  --shadow-knob-lg: 0 2px 5px rgba(0, 0, 0, 0.3);
  --shadow-overlay: 0 10px 40px rgba(0, 0, 0, 0.55);
  --shadow-toast: 0 0 6px rgba(0, 0, 0, 0.45);
  ```

### [P2] — No z-index scale; stacking order has an inversion

- **What/Why:** z-indexes are scattered literals: status-bar `5` (`components.css:12`), sheet `20/21` (`:120,131`), alert `30` (`:160`), menu `40` (`:215`), toast `50` (`:442`). A `Menu` opened from inside a sheet (e.g. trade-panel chip menus) paints **above an AlertDialog** (40 > 30) if both are live. Violates Consistency and State Coverage.
- **Location:** `apps/desktop/src/design/components/components.css:12,120,131,160,215,442`
- **Exact fix:** Tokenize in `tokens.css` and reorder menu below alerts:
  ```css
  --z-chrome: 5;
  --z-sheet: 20;
  --z-menu: 25;
  --z-alert: 30;
  --z-toast: 50;
  ```
  (`components.css:215` → `z-index: var(--z-menu)` = 25, etc.)

### [P2] — Motion coverage gaps: no press states, no reduced-motion, ease-in-out entrance, infinite spinner

- **What/Why:** (a) No `:active` press state on `.button-primary`, `.trade-action-button`, `.quick-chip`, `.chip-button` — taps give zero feedback (b) `--toast-anim: 200ms ease-in-out` (tokens.css:65) uses ease-in-out for an _entrance_, which reads sluggish; entrances should decelerate (c) no `prefers-reduced-motion` query anywhere; `spinner-rotate 0.8s linear infinite` (`components.css:106`) never stops for motion-sensitive users. Violates Motion and A11y (WCAG 2.3.3/2.2.2).
- **Location:** `apps/desktop/src/design/tokens.css:65`, `apps/desktop/src/design/components/components.css:101-112,240-242`, `apps/desktop/src/design/base.css:129-138`
- **Exact fix:**
  ```css
  /* tokens.css */
  --toast-anim: 200ms cubic-bezier(0, 0, 0.2, 1); /* decelerate on entry */
  --press-scale: 0.97;
  /* components.css */
  .button-primary:active:not(:disabled),
  .trade-action-button:active:not(:disabled) {
    transform: scale(var(--press-scale));
    transition: transform 100ms ease-out;
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2.4s;
    }
    .sheet-panel,
    .sheet-backdrop,
    .toast,
    .alert-backdrop {
      animation-duration: 1ms;
    }
    .toggle,
    .toggle .knob {
      transition: none;
    }
  }
  ```

### [P2] — Sheet/AlertDialog/Menu lack dialog semantics and focus management; AlertDialog has no Escape

- **What/Why:** `Sheet.tsx` renders a plain `div` (no `role="dialog"`, no `aria-modal`, no focus trap, no initial focus); `AlertDialog.tsx` same plus it's the only overlay **without** an Escape handler (`Sheet.tsx:18-24` and `Menu.tsx:30-34` both have one); `Menu.tsx` dropdown is a `div` of buttons with no `role="menu"`/arrow-key navigation. Violates A11y and Platform (keyboard).
- **Location:** `apps/desktop/src/design/components/Sheet.tsx:27-31`, `AlertDialog.tsx:17-35`, `Menu.tsx:45-66`
- **Exact fix:** In `AlertDialog.tsx` add the same `useEffect` Escape listener as `Sheet.tsx:18-24` calling `onDismiss`, and set `<div className="alert-backdrop" role="alertdialog" aria-modal="true" aria-label={title}>`; in `Sheet.tsx:29` → `<div className={...} role="dialog" aria-modal="true">` and auto-focus the panel's first focusable element on mount (`panelRef.current?.querySelector('button, input')?.focus()`); in `Menu.tsx:52` add `role="menu"` on the dropdown and `role="menuitem"` on each `button`, plus `onKeyDown` ArrowUp/ArrowDown moving `document.activeElement` between items.

### [P2] — Hit targets below 44px on chart header and utility controls

- **What/Why:** Reconstructed from code: indicator-settings button = 15px icon + 2×8px padding = **31×31px** (`ChartView.tsx:203-214`); segmented control and stepper are **32px tall** (`components.css:250,307`); interval chip ≈ 12px text + 2×6px = **~30px** (`ChartView.tsx:184-194`); symbol picker button has an 11px chevron and no padding (`ChartView.tsx:147-153`); cancel-order affordance is a bare 17×17px icon (`PositionsStrip.tsx:95-102`). Violates Platform Fidelity / A11y (Apple 44×44, WCAG 2.5.8's 24px floor is only barely met).
- **Location:** `apps/desktop/src/features/chart/ChartView.tsx:147-153,184-214`, `apps/desktop/src/design/components/components.css:250,307`, `apps/desktop/src/features/trade/PositionsStrip.tsx:95-102`
- **Exact fix:** Add `min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center;` to the settings button (`ChartView.tsx:204-209`) and the cancel button (`PositionsStrip.tsx:97`); raise `.segmented` and `.stepper` to `height: 36px` (desktop pointer minimum) or 44px for true parity; pad the symbol button `padding: 8px` (`ChartView.tsx:148`).

### [P2] — Tabular figures applied ad hoc; P&L/price text outside ChartView is proportional

- **What/Why:** Only `ChartView.tsx:162,172` sets `fontVariantNumeric: 'tabular-nums'` with `--font-mono`. The same app's P&L and prices elsewhere — `PositionsStrip.tsx:58-69` (avg price, unrealized P&L), `HistoryView.tsx` rows, `TradePanel.tsx:237,307` — render in proportional system-ui, so live-ticking values jitter horizontally. There is no shared `<Price>` component to enforce it. Violates Typography (tabular figures for ALL prices/P&L) and DataViz.
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx:53-69` vs `apps/desktop/src/features/chart/ChartView.tsx:157-176`
- **Exact fix:** Add a utility class in `base.css`:
  ```css
  .numeric {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  ```
  and apply `className="numeric"` to the price/P&L spans at `PositionsStrip.tsx:58,61`, `HistoryView.tsx:97,101,133,145`, and every `Format.price/signedPrice` call site's element.

### [P2] — No line-height or font-weight tokens

- **What/Why:** `tokens.css:45-53` tokenizes sizes only; line-height is never declared anywhere in the system (browser `normal` ≈ 1.2–1.35 depending on the platform font, so the "pixel-faithful iOS clone" typesets differently on Windows vs macOS), and weights 500/600/700 are inlined across `components.css` and ~20 feature sites. Violates Typography and Consistency.
- **Location:** `apps/desktop/src/design/tokens.css:45-53`, e.g. `components.css:18,71,115`, `features/chart/ChartView.tsx:151,161`
- **Exact fix:** Add to `tokens.css`:
  ```css
  --lh-tight: 1.2;
  --lh-body: 1.35;
  --fw-medium: 500;
  --fw-semibold: 600;
  --fw-bold: 700;
  ```
  set `body { line-height: var(--lh-body) }` in `base.css:15-25`, and sweep `fontWeight: 600` → `var(--fw-semibold)` at the ~20 inline sites.

### [P3] — `format.ts` has no thousands grouping; zero renders as `+0.00`

- **What/Why:** `Format.price` uses `toFixed` (format.ts:4) so `12345.678` → `"12345.68"` — balances/P&L in the thousands lack grouping separators that both iOS `NumberFormatter` and TradingView show; `signedPrice(0)` → `"+0.00"` (format.ts:10) which reads as a gain at flat. Violates DataViz/Typography polish.
- **Location:** `apps/desktop/src/design/format.ts:3-11`
- **Exact fix:**
  ```ts
  const group = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  price(value: number, fractionDigits = 2): string {
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(value);
  },
  signedPrice(value: number, fractionDigits = 2): string {
    if (value === 0) return this.price(0, fractionDigits); // "0.00", no sign
    const text = this.price(Math.abs(value), fractionDigits);
    return value < 0 ? `-${text}` : `+${text}`;
  },
  ```

### [P3] — `components.css` hardcodes the elevated surface color instead of the token

- **What/Why:** `.alert-card` uses `rgba(40, 43, 53, 0.96)` (components.css:165) and `.menu-dropdown` `rgba(40, 43, 53, 0.98)` (`:212`) — literally `#282b35` = `--app-surface-elevated` with alpha, duplicating the token by hand. Same file: `.status-bar .time` hardcodes `font-size: 16px` (`:16`) outside the `--fs-*` scale (16 sits between subheadline 15 and headline 17); `.toast-capsule` shadow untokenized (`:454`). Violates Consistency.
- **Location:** `apps/desktop/src/design/components/components.css:16,165,212,454`
- **Exact fix:** `background: color-mix(in srgb, var(--app-surface-elevated) 96%, transparent)` (`:165`) and `98%` (`:212`); add `--fs-status-time: 16px` to tokens.css or use `var(--fs-subheadline)` at 600 weight (matches real iOS status-bar metrics closely enough at 15px/600).

### [P3] — Icons use a fixed `strokeWidth: 2` across 11–24px sizes

- **What/Why:** `icons.tsx:16` sets `strokeWidth: 2` for every glyph; at `size={11}` (`ChartView.tsx:152` chevron) a 2px stroke on a 24-grid glyph scaled to 11px renders ≈0.92px — mushy — while at 22–24px it reads thin vs SF Symbols' weight-matched variants. `ChevronDownIcon` already hand-overrides to 3 (`:63`), proof the fixed default is wrong at small sizes. Violates Consistency/polish.
- **Location:** `apps/desktop/src/design/icons.tsx:9-21,63`
- **Exact fix:** Scale stroke with size in `svgProps`: `strokeWidth: size <= 13 ? 2.5 : size <= 17 ? 2.25 : 2`, and drop the per-icon `strokeWidth={3}` override at `icons.tsx:63`.

### [P3] — Misc token gaps: `#000` body chrome, `0.5px` hairline, dimmed-button legibility

- **What/Why:** `base.css:16` `background: #000` (page chrome behind the phone frame) is untokenized; the `0.5px` hairline border recurs 4× (`components.css:188,237,412`, `PositionsStrip.tsx:21`) with no `--border-hairline` token; `.button-primary.dimmed` at `opacity: 0.35` (base.css:119-121) yields an effective 1.73:1 label contrast — acceptable under WCAG's disabled exemption but indistinguishable from enabled at a glance since there's no `cursor`/saturation difference beyond opacity. Violates token coverage (Composition/Consistency).
- **Location:** `apps/desktop/src/design/base.css:16,119-121`, `apps/desktop/src/design/components/components.css:188,237,412`
- **Exact fix:** Add `--chrome-background: #000;` and `--border-hairline: 0.5px;` to tokens.css and reference them; for dimmed, add `filter: saturate(0.4)` alongside the opacity so disabled reads as intent, not rendering artifact.

## Quick wins vs structural work

**Quick wins (<1 hour each):**

- Add `--app-accent-fill` / `--buy-green-fill` / `--sell-red-fill` tokens + swap 6 usages (P0).
- Add `:focus-visible` block to base.css (P1, one rule).
- Add hover rules to components.css (P1, ~6 rules).
- Add `--app-accent-text` / `--pnl-negative-text` + 6 class swaps (P1).
- Add spacing/elevation/z-index token blocks and snap the 4 off-grid values (7px→8, 22→24) (P2).
- Toast easing change + press-state rules + reduced-motion media query (P2).
- `.numeric` utility class + apply to PositionsStrip/HistoryView price spans (P2).
- AlertDialog Escape handler + `role="alertdialog"` (P2, ~10 lines).
- `format.ts` grouping + zero-sign fix (P3, ~8 lines).
- `color-mix` swap for the two hardcoded elevated backgrounds (P3).

**Structural work:**

- `design/chartColors.ts` single-source refactor across 4 canvas/chart files + sync test (P1 — touches CandleChart, ChartView, IndicatorPane, DrawingLayer).
- Shared `<Price>`/`<Pnl>` component enforcing mono + tabular-nums + sign semantics app-wide (P2 — replaces ~15 call sites).
- Focus trap + roving-tabindex keyboard nav for Sheet/Menu (P2 — needs a small focus-management utility).
- Backfilling the ~120 inline `style={{}}` sites in features onto spacing tokens / CSS classes (P2 — mechanical but wide; do per-screen as those screens are audited).
- Skeleton loading components to replace spinner-only states (P2 — new primitive + per-screen adoption).
