# Screen d12: Chart view + candle chart + indicator panes
- **App:** Desktop
- **Location:** `apps/desktop/src/features/chart/ChartView.tsx` (OVERLAY_COLORS L16–23, header L138–216, loading overlay L227–240, error L241–257, pane heights L260–279) · `CandleChart.tsx` (COLORS L34–40, createChart L85–110, crosshair kill L105–108, VISIBLE_CANDLES L42, snap L180–184, volume colors L255–260) · `IndicatorPane.tsx` (createChart L47–66, fontSize 9 L51, guide lines L111–123, fitContent L150) · `ChartStore.ts` (isLoading/errorMessage L78–98, MAX_CANDLES 600 L48, live bucketing L124–162)
- **Visual:** screenshots `docs/ui-audit/shots/05-trade-split.png`, `docs/ui-audit/shots/08-trade-fullscreen.png` (read via ReadMediaFile)
- **Scores:** Composition 6/10 · Typography 6/10 · Color 6/10 · Density 7/10 · DataViz 4/10 · Motion 3/10 · States 4/10 · Platform 4/10 · A11y 3/10 · Consistency 4/10 → **Overall 47/100**
- **Score justifications:**
  - Composition 6 — header row is tight and right-clustered controls read well, but the TradingView attribution logo overlaps the SELL CTA in fullscreen and the left price-scale border runs behind the SELL/BUY buttons (08 png), and header padding 12px ignores `--pad-screen: 24`.
  - Typography 6 — prices use `--font-mono` + `tabular-nums` correctly (ChartView.tsx:159–174), but chart axis text is 10px and pane axis text 9px, below the 11px `--fs-caption2` floor of the iOS type scale it clones.
  - Color 6 — palette matches iOS dark values and axis-label contrast is ~6.3:1 (passes AA), but ~20 hexes are hardcoded duplicates of existing tokens.css vars, so semantic color is one stale edit away from drifting.
  - Density 7 — dense-but-clean header (symbol, last, B/A, tools, interval, settings in one row) is genuinely TradingView-adjacent; docked one point for missing OHLC legend forcing density too low on actual data readout.
  - DataViz 4 — gridlines are restrained (0.25 alpha, good) and volume is correctly docked to bottom 20%, but crosshair is explicitly disabled, no tooltip/legend exists, and sub-pane x-ranges don't match the main chart's 120-bar window.
  - Motion 3 — only the spinner animates; the interval Menu pops with no transition, header buttons have no hover/press states, and `prefers-reduced-motion` is never consulted.
  - States 4 — loading is a bare centered spinner (no skeleton), error is passive text with no retry/action, refresh errors with existing candles are silently swallowed, and socket disconnect is invisible.
  - Platform 4 — pan/zoom and autoSize work, but no hover/focus-visible styles on any header control, no keyboard shortcuts, no crosshair on a pointer platform, and hit targets are 27–31px.
  - A11y 3 — no `role="status"` on the spinner, no `role="alert"` on the error, symbol button's accessible name is just "SPY", chart canvas has no accessible summary, focus ring is browser-default only.
  - Consistency 4 — tokens.css already defines every chart color used (`--chart-*` L20–33), yet ChartView/CandleChart/IndicatorPane re-hardcode them; header is built entirely from inline `style={{}}` one-offs (999 radius, 6px 10px padding, magic heights 72/84).

## Findings

### [P1] — Stray glyph bottom-left is the lightweight-charts TradingView attribution logo; in fullscreen it overlaps the SELL button
- **What/Why:** The white "TV" mark at bottom-left of the chart in 05-trade-split.png and overlaid on the SELL CTA in 08-trade-fullscreen.png is the default `attributionLogo` that lightweight-charts 4.x renders unless disabled. It collides with the primary trade action (broken visual hierarchy, Composition/Platform) and reads as a rendering bug to any user. lightweight-charts is Apache-2.0; the logo is optional via config.
- **Location:** `apps/desktop/src/features/chart/CandleChart.tsx:86-110` (no `attributionLogo` option), `IndicatorPane.tsx:48-66`
- **Exact fix:** in both `createChart` calls, add to `layout`:
  ```ts
  layout: {
    background: { type: ColorType.Solid, color: 'transparent' },
    attributionLogo: false,
    textColor: COLORS.axisLabel,
    ...
  }
  ```

### [P1] — Fullscreen chart bleeds behind SELL/BUY buttons; left price-scale border line runs through the SELL button
- **What/Why:** In 08-trade-fullscreen.png the chart container extends to the screen bottom and the buy/sell bar is drawn on top of it; the left axis border (`borderColor: COLORS.border`) visibly crosses the SELL button face. A chrome line intersecting a primary CTA is a Composition break. The chart area should end above the action bar (or the action bar needs an opaque backdrop).
- **Location:** `apps/desktop/src/features/chart/ChartView.tsx:219` (`<div style={{ flex: 1, minHeight: 100, position: 'relative' }}>` — parent TradeScreen overlays the buttons)
- **Exact fix:** in the parent layout (TradeScreen fullscreen branch), give the action bar `background: var(--app-background)` and place it in normal flow after the chart, or pad the chart container: `paddingBottom: 84` (button height 52 + 16 top gap + 16 bottom) so no axis/grid pixels sit under the CTAs.

### [P1] — Crosshair explicitly disabled and no OHLC legend on a pointer platform
- **What/Why:** `crosshair: { vertLine: { visible: false ... }, horzLine: { visible: false ... } }` removes the single most-used desktop chart interaction. There is no substitute: no tooltip, no legend, no way to read exact OHLC/time at the cursor. This alone keeps DataViz far below the TradingView bar; on desktop with a mouse it's a P1, not a nit.
- **Location:** `apps/desktop/src/features/chart/CandleChart.tsx:105-108`
- **Exact fix:**
  ```ts
  crosshair: {
    vertLine: { visible: true, labelVisible: true, color: 'rgba(235, 235, 245, 0.4)', style: 3, width: 1 },
    horzLine: { visible: true, labelVisible: true, color: 'rgba(235, 235, 245, 0.4)', style: 3, width: 1 },
  },
  ```
  plus a legend: subscribe in the mount effect —
  ```ts
  chart.subscribeCrosshairMove((param) => {
    const bar = param.seriesData.get(candleSeries) as CandlestickData | undefined;
    setLegend(bar ? `O ${Format.price(bar.open)}  H ${Format.price(bar.high)}  L ${Format.price(bar.low)}  C ${Format.price(bar.close)}` : null);
  });
  ```
  rendered as an absolutely-positioned overlay at `top: 4, left: 52` (clear of the left axis) with `fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-caption2)', fontVariantNumeric: 'tabular-nums', pointerEvents: 'none'`.

### [P1] — Sub-pane x-axis is not synchronized with the main chart
- **What/Why:** The main chart snaps to the last 120 bars (`VISIBLE_CANDLES = 120`, `setVisibleLogicalRange` at CandleChart.tsx:180–184), but every `IndicatorPane` calls `chart.timeScale().fitContent()` (IndicatorPane.tsx:150), rendering all ~400–600 candles compressed into the same pixel width. Stacked panes therefore show different time ranges that visually imply alignment — a data-integrity-grade DataViz defect. Panning/zooming the main chart leaves panes frozen entirely.
- **Location:** `apps/desktop/src/features/chart/CandleChart.tsx:42,180-184` · `apps/desktop/src/features/chart/IndicatorPane.tsx:150`
- **Exact fix:** add to `CandleChart` props `onVisibleRangeChange?: (range: { from: number; to: number } | null) => void`, wired in the mount effect: `chart.timeScale().subscribeVisibleLogicalRangeChange((r) => onVisibleRangeChangeRef.current(r))`. In `ChartView`, hold `const [visibleRange, setVisibleRange] = useState(...)` and pass it to each `IndicatorPane`; in `IndicatorPane` accept `visibleRange?: { from: number; to: number } | null` and replace line 150 with:
  ```ts
  if (visibleRange) chart.timeScale().setVisibleLogicalRange(visibleRange);
  else chart.timeScale().fitContent();
  ```

### [P1] — Error state is passive text: no retry, no action, and refresh failures vanish
- **What/Why:** The empty-chart error (visible in both screenshots: "No Webull credentials on file — save app key/secret in Profile first") is plain secondary text — no retry button, no "Open Profile" action despite the message telling the user to go there, no icon. Worse, the render guard `errorMessage && candles.length === 0` (ChartView.tsx:241) means a failed refresh over existing candles surfaces nothing at all — the chart just silently goes stale. Violates State Coverage ("actionable errors") and A11y (no `role="alert"`).
- **Location:** `apps/desktop/src/features/chart/ChartView.tsx:241-257` · `ChartStore.ts:93-95`
- **Exact fix:** replace the error block with:
  ```tsx
  {errorMessage && candles.length === 0 ? (
    <div role="alert" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 16, textAlign: 'center' }}>
      <span className="text-secondary" style={{ fontSize: 'var(--fs-footnote)' }}>{errorMessage}</span>
      <button onClick={() => store.loadCandles()} style={{ color: 'var(--app-accent)', fontSize: 'var(--fs-footnote)', fontWeight: 600, minHeight: 44, padding: '0 16px' }}>
        Retry
      </button>
    </div>
  ) : null}
  ```
  and when `candles.length > 0`, route `errorMessage` to the existing toast component (`.toast` / `--toast-anim` in components.css) instead of dropping it.

### [P1] — Loading state is a bare spinner; no skeleton, no aria status
- **What/Why:** A spinner centered over an empty black rect is the lowest-effort loading treatment; the bar (skeletons > spinners) wants a chart-shaped skeleton so the layout pre-commits. The `Spinner` renders a bare `<span>` with no `role="status"`/`aria-label`, so screen readers announce nothing during load.
- **Location:** `apps/desktop/src/features/chart/ChartView.tsx:227-240` · `apps/desktop/src/design/components/Spinner.tsx:6-8`
- **Exact fix:** in Spinner: `<span role="status" aria-label="Loading" className={...} />`. In ChartView, when `isLoading && candles.length === 0`, render a skeleton instead: 24 vertical bars of pseudo-random heights (seeded constant array) with `background: var(--app-surface-elevated); borderRadius: 2; opacity: 0.5` and a `skeleton-pulse` keyframe (`@keyframes skeleton-pulse { 50% { opacity: 0.25 } }`, `animation: skeleton-pulse 1200ms ease-in-out infinite`), respecting `@media (prefers-reduced-motion: reduce) { animation: none }`.

### [P1] — ~20 hardcoded hexes duplicate tokens that already exist in tokens.css
- **What/Why:** tokens.css L20–33 already defines `--chart-sma/ema/vwap/bb-outer/bb-middle/rsi/macd/macd-signal/candle-up/candle-down/axis-label/grid`. Yet `OVERLAY_COLORS` (ChartView.tsx:16–23), RSI `#ffd60a` (L81), MACD `#30d158/#ff453a/#0a84ff/#ff9f0a` (L94–99), stoch (L112–113), ATR `#40cbe0` (L129), `COLORS` (CandleChart.tsx:34–40), volume rgba hexes (CandleChart.tsx:259), pane text/guide colors (IndicatorPane.tsx:50,115) are all hardcoded. Any palette change requires editing 5 files and is guaranteed to drift. Direct Consistency violation.
- **Location:** `apps/desktop/src/features/chart/ChartView.tsx:16-23,81,94-99,112-113,129` · `CandleChart.tsx:34-40,259` · `IndicatorPane.tsx:50,115`
- **Exact fix:** resolve tokens once at chart creation (lightweight-charts needs concrete strings, so read computed values, not `var()`):
  ```ts
  const css = getComputedStyle(container);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const COLORS = {
    candleUp: token('--chart-candle-up'),
    candleDown: token('--chart-candle-down'),
    axisLabel: token('--chart-axis-label'),
    grid: token('--chart-grid'),
    border: 'rgba(84, 84, 88, 0.4)',
  };
  ```
  For alpha variants (volume, guide lines), add tokens `--chart-volume-up: rgba(48,209,88,0.45)`, `--chart-volume-down: rgba(255,69,58,0.45)`, `--chart-guide: rgba(142,142,147,0.6)` to tokens.css and consume the same way; replace `OVERLAY_COLORS` entries with `token('--chart-sma')` etc. via a shared helper module (e.g. `chartColors.ts`).

### [P1] — Header hit targets are 27–31px, below the 44pt HIG minimum and WCAG 2.5.8's 24px floor
- **What/Why:** Interval chip: 12px font + `padding: 6px 10px` ≈ 27px tall (ChartView.tsx:186–191). Draw-tools and sliders buttons: 15px icon + `padding: 8` ≈ 31px (L203–209, DrawToolsMenu similar). Symbol button has zero padding — the clickable chevron is 11px (L147–153). On the phone-clone these are mouse targets; sub-44px targets on trading controls that switch data context are friction.
- **Location:** `apps/desktop/src/features/chart/ChartView.tsx:147-153,183-195,203-214`
- **Exact fix:** symbol button: add `padding: '10px 8px'` (min 44px height incl. text). Interval chip: `padding: '10px 14px'` (→ ~40px; add `minHeight: 36`). Icon buttons: `padding: 12` (→ 39px) or `width: 40; height: 40` with the 15px icon centered. Keep visual size identical by reducing chip background visual padding if needed — hit area can exceed the painted pill via a wrapping button.

### [P2] — Axis text below legibility floor: 9px panes, 10px main chart
- **What/Why:** `fontSize: 9` (IndicatorPane.tsx:51) and `fontSize: 10` (CandleChart.tsx:89) are under the iOS `--fs-caption2: 11px` minimum the rest of the app respects, and 9px monochrome-on-dark at 0.6 alpha is where traders misread prices. Typography violation.
- **Location:** `apps/desktop/src/features/chart/IndicatorPane.tsx:51` · `CandleChart.tsx:89`
- **Exact fix:** main chart `fontSize: 11`; panes `fontSize: 10` (absolute floor) and add `--fs-chart-axis: 10px` / `--fs-pane-axis: 10px` tokens if a sub-caption size is truly needed, so the deviation is at least named.

### [P2] — No hover, no focus-visible, no press state on any header control; menu pops with zero animation
- **What/Why:** The global `button` reset (base.css:58–69) defines `cursor: pointer` and nothing else — no `:hover` background, no `:focus-visible` ring, no `:active` state. Header buttons and menu items (`menu-item` has no hover rule at components.css:224–234) are interaction-dead visually. `.menu-dropdown` (components.css:206–217) has no `transition`/`animation` — it appears in one frame, where sheets/toasts elsewhere get `--sheet-anim`/`--toast-anim`. Motion and Platform violations; invisible keyboard focus is also an A11y failure.
- **Location:** `apps/desktop/src/design/base.css:58-69` · `apps/desktop/src/design/components/components.css:206-234` · `apps/desktop/src/features/chart/ChartView.tsx:147-214`
- **Exact fix:**
  ```css
  button:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 2px; border-radius: inherit; }
  .menu-item:hover { background: rgba(235, 235, 245, 0.08); }
  @keyframes menu-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } to { opacity: 1; transform: none; } }
  .menu-dropdown { animation: menu-in 150ms cubic-bezier(0.32, 0.72, 0, 1); }
  ```
  and for the two elevated-circle header buttons: `transition: background 150ms ease;` + `:hover { background: #31343f; }` (one step above `--app-surface-elevated`).

### [P2] — Accessible names and live regions missing across the chart header and states
- **What/Why:** Symbol button's accessible name is "SPY" — nothing says it opens symbol search. The interval chip announces "1m" with no role hint it's a menu. The error overlay has no `role="alert"`, the spinner no `role="status"`, and the chart canvas itself has no accessible summary — VoiceOver/NVDA users get a black box where the app's core data lives. DrawToolsMenu trigger lacks an aria-label pattern here (SlidersIcon button has one — good, L211 — apply the same everywhere).
- **Location:** `apps/desktop/src/features/chart/ChartView.tsx:147-153,182-202,227-257` · `CandleChart.tsx:230-241`
- **Exact fix:** symbol button: `aria-label={`Symbol ${symbol}. Change symbol`}` and `aria-hidden` on `<ChevronDownIcon>`. Interval Menu trigger: `aria-label={`Chart interval ${interval}`}` + `aria-haspopup="menu"`. Chart container (CandleChart.tsx:231): `role="img"` + `aria-label={candles.length ? `${symbol} ${interval} candlestick chart, last close ${Format.price(candles[candles.length-1].close)}` : `${symbol} chart, no data`}`. Error overlay: `role="alert"` (see P1 fix above).

### [P2] — 8pt-grid violations sprinkled through the header and pane geometry
- **What/Why:** `gap: 1` between last price and B/A (ChartView.tsx:156), chip `padding: 6px 10px` (6 breaks the 4pt sub-grid), MACD pane `height={84}` (84 = 8×10.5; siblings are 72) (L269), icon sizes 11 and 15 (L152,213) next to 8-grid icon sizes elsewhere, header `padding: '8px 12px'` where the screen token is `--pad-screen: 24`. Each is small; together they produce the slightly-off rhythm visible in the header's uneven right cluster.
- **Location:** `apps/desktop/src/features/chart/ChartView.tsx:142-143,152,156,188,213,269`
- **Exact fix:** `gap: 2` (or fold B/A into one line with 8px letter gap); chip `padding: '8px 12px'`; MACD pane `height={80}`; `ChevronDownIcon size={12}`, `SlidersIcon size={16}`; header `padding: '8px 16px'` and add tokens `--space-header-x: 16px` if 24 feels too wide for the dense bar.

### [P2] — No offline/stale-data affordance: a dead socket looks identical to a quiet market
- **What/Why:** `handleLiveQuote` (ChartStore.ts:124–162) simply stops being called when the socket drops; the last price, last candle, and B/A freeze with no "disconnected / reconnecting / delayed" badge. In a 0DTE trading context, silently stale prices are a correctness-adjacent UX hazard, not a nicety. State Coverage gap (offline state undesigned).
- **Location:** `apps/desktop/src/features/chart/ChartStore.ts:69,124-162` · `ChartView.tsx:155-178`
- **Exact fix:** surface the existing `QuoteSocket` connection state in ChartStore (`connection: 'live' | 'stale'`), and in the header quote block append, when stale: `<span style={{ fontSize: 'var(--fs-caption2)', color: 'var(--warning-orange)', fontWeight: 600 }}>● STALE</span>` next to the last price, plus auto-retry subscription on socket reconnect.

### [P3] — Guide-line creation mutates a prop parameter as a one-shot flag
- **What/Why:** `guideLines = undefined; // Only once, on the first line series.` (IndicatorPane.tsx:122) reassigns a destructured prop mid-loop to prevent duplicate price lines. It works by accident of series ordering: the first `line`-kind series gets the guides; reorder MACD/stoch series and the guides silently move or vanish. Consistency/robustness nit.
- **Location:** `apps/desktop/src/features/chart/IndicatorPane.tsx:111-123`
- **Exact fix:**
  ```ts
  let guidesDrawn = false;
  ...
  if (!guidesDrawn && guideLines && spec.kind === 'line') {
    for (const level of guideLines) { api.createPriceLine({ ... }); }
    guidesDrawn = true;
  }
  ```

### [P3] — No keyboard shortcuts for interval switching on a desktop chart
- **What/Why:** TradingView/thinkorswim users expect `1/5/3/H/D`-style interval keys and `Alt+R` reset; here interval changes require opening a mouse menu. A 0DTE scalper's core loop is symbol↔interval switching — every click costs ticks.
- **Location:** `apps/desktop/src/features/chart/ChartView.tsx:196-201` (only path to `selectInterval`)
- **Exact fix:** in ChartView, `useEffect` a `keydown` listener (ignore when `e.target` is input/textarea): keys `1,5,3,H,D` → `store.selectInterval('1m'|'5m'|'15m'|'1h'|'1d')`; document in the menu via trailing shortcut hints in the `Menu` items (`label: <span>1m <kbd>1</kbd></span>`).

## Quick wins vs structural work

**<1 hour:**
- `attributionLogo: false` in both createChart calls (P1 #1)
- Retry button + `role="alert"` on the empty-chart error (P1 #5, render half)
- `role="status"` on Spinner; aria-labels on symbol/interval/chart (P1 #6 half, P2 #11)
- Hover/focus-visible/menu-in CSS block (P2 #10)
- 8pt grid fixes: gap 2, chip padding, MACD pane 80, icon sizes 12/16 (P2 #12)
- Pane axis font 9→10, main 10→11 (P2 #9)
- `guidesDrawn` flag instead of prop mutation (P3 #14)

**Structural (refactor needed):**
- Crosshair + live OHLC legend overlay (P1 #3 — new state + subscription plumbing)
- Pane↔main x-range synchronization via `subscribeVisibleLogicalRangeChange` (P1 #4 — new props across 3 components)
- Token resolution helper (`chartColors.ts` reading `getComputedStyle`) + new alpha tokens in tokens.css, replacing ~20 hardcoded hexes across 3 files (P1 #7)
- Skeleton loading component replacing the spinner for empty loads (P1 #6)
- Stale-connection state threaded from QuoteSocket → ChartStore → header badge (P2 #13)
- Keyboard shortcut layer + menu shortcut hints (P3 #15)
- Fullscreen layout fix so the action bar no longer overlays the chart (P1 #2 — touches TradeScreen, outside this unit)
