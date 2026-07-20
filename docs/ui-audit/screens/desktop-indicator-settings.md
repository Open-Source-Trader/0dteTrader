# Screen d14: Indicator settings sheet

- **App:** Desktop
- **Location:** `apps/desktop/src/features/chart/IndicatorSettingsView.tsx` (whole file; key refs :19 Sheet, :20-28 inline-style wrapper, :161 hardcoded MACD label) · supporting: `apps/desktop/src/design/components/Sheet.tsx`, `Toggle.tsx`, `Stepper.tsx`, `components/components.css:89-431`, `tokens.css`
- **Visual:** screenshot `docs/ui-audit/shots/07-indicator-settings.png` (860×1864 @2x of the 430×932 frame; EMA/VWAP/Volume on, one Period row visible, ~20% dead space below the Sub-Panes card)
- **Scores:** Composition 6/10 · Typography 7/10 · Color 7/10 · Density 7/10 · DataViz 6/10 · Motion 5/10 · States 7/10 · Platform 5/10 · A11y 4/10 · Consistency 6/10 → **Overall 60/100**
- **Score justifications:**
  - Composition 6: grouped-list structure is clean and iOS-true, but 22px section gap breaks the 8pt grid, separators run full-bleed instead of 16px-inset, and the large detent leaves ~180px of dead black at the bottom with no footer.
  - Typography 7: correct SF scale via tokens (17px body rows, 13px uppercase footnote headers, 600 inline title); no tabular figures needed for integer params; desktop has no zoom/Dynamic-Type equivalent — fixed px everywhere.
  - Color 7: all colors tokenized, measured contrast passes (label-secondary ≈5.9:1 on surface, accent "Done" ≈5.5:1); one semantic leak — toggle "on" uses `--pnl-positive` (a P&L token) instead of a control-state green.
  - Density 7: 10 settings in 2 sections is right-sized; nothing is competing, but rows carry no series-color cue so the user can't map a row to a chart line.
  - DataViz 6: no charts on this screen (nothing to penalize on axes/gridlines); loses points because the chart-color tokens (`--chart-sma`…`--chart-rsi`, tokens.css:21-30) exist yet the sheet shows no legend chips bridging settings → visualization.
  - Motion 5: sheet slide (300ms `cubic-bezier(0.32,0.72,0,1)`) and toggle 200ms transitions are in range, but parameter rows pop in/out with zero transition and no `prefers-reduced-motion` handling exists anywhere in the design system.
  - States 7: needs no loading/error/offline states (pure local form); stepper disabled-at-bounds state exists (opacity 0.35); missing a "Reset to Defaults" escape hatch and long-range steppers have no direct-entry path.
  - Platform 5: Escape + backdrop dismiss work and the 44px navbar is right, but hit targets fail the 44pt bar (stepper 32px tall, toggle 31px, "Done" ~22px), no grabber, no focus ring styling, no focus trap.
  - A11y 4: every switch is an unnamed `role="switch"` button (screen reader hears "switch, on" ×10 with no label), steppers announce generic "Decrement/Increment", sheet has no `role="dialog"`/`aria-modal`, focus is never moved into the sheet.
  - Consistency 6: mostly shared classes, but an inline `style={{}}` block overrides the Sheet's own background/flex (IndicatorSettingsView.tsx:20-28), "MACD (12, 26, 9)" hardcodes params every other row makes editable, and 22px/10px/0.4px one-off values sit outside any token.

## Findings

### [P1] — All 10 toggles are unlabeled switches for assistive tech

- **What/Why:** `Toggle` renders `<button role="switch" aria-checked>` with no `aria-label`/`aria-labelledby` and no text content (only a `<span className="knob">`). A screen reader announces "switch, on" ten times with no way to know which is SMA vs ATR. Violates Accessibility (WCAG 4.1.2 name-role-value).
- **Location:** `apps/desktop/src/design/components/Toggle.tsx:9-17`; call sites `IndicatorSettingsView.tsx:44,64,84,91,101,143,163,170,217`
- **Exact fix:** add a required label prop to `Toggle.tsx`:

```tsx
interface ToggleProps {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
}
export function Toggle({ on, onChange, label }: ToggleProps) {
  return (
    <button
      className={`toggle${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <span className="knob" />
    </button>
  );
}
```

and pass it at each call site, e.g. `IndicatorSettingsView.tsx:44` → `<Toggle label="SMA" on={settings.smaEnabled} onChange={(on) => patch({ smaEnabled: on })} />`, `:64` → `label="EMA"`, `:84` → `label="VWAP"`, `:91` → `label="Volume"`, `:101` → `label="Bollinger Bands"`, `:143` → `label="RSI"`, `:163` → `label="MACD"`, `:170` → `label="Stochastic"`, `:217` → `label="ATR"`.

### [P1] — Sheet has no dialog semantics, no focus management

- **What/Why:** `Sheet` renders two plain `<div>`s. No `role="dialog"`, no `aria-modal`, no accessible name, focus stays on whatever opened it, and Tab can walk into the obscured chart behind the panel. Escape works (Sheet.tsx:16-22) but keyboard users on desktop get a broken modal contract. Violates Accessibility + Platform Fidelity.
- **Location:** `apps/desktop/src/design/components/Sheet.tsx:24-29`
- **Exact fix:**

```tsx
interface SheetProps {
  detent?: 'large' | 'medium';
  onDismiss: () => void;
  label: string;
  children: ReactNode;
}

export function Sheet({ detent = 'large', onDismiss, label, children }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onDismiss} aria-hidden="true" />
      <div
        ref={panelRef}
        className={`sheet-panel ${detent}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </div>
    </>
  );
}
```

(add `useRef` to the React import on line 1) and update the call site `IndicatorSettingsView.tsx:19` → `<Sheet detent="large" onDismiss={onDismiss} label="Indicator settings">`. Add to `components.css` after line 135: `.sheet-panel:focus { outline: none; }`.

### [P1] — Primary controls fail the 44pt hit-target bar

- **What/Why:** stepper buttons are 47×32px (components.css:304-318: 94px/2 wide, 32px tall), the toggle is 51×31px (:273-275), and "Done" is a bare text button ~50×22px (:89-92) — all under the 44×44pt HIG minimum this phone-frame clone is held to. The screenshot confirms the −/+ glyph rows are visually cramped at 32px tall inside 64px rows. Violates Platform Fidelity + Accessibility.
- **Location:** `apps/desktop/src/design/components/components.css:273-281, 304-312, 89-92`
- **Exact fix:** keep the iOS-accurate visuals, extend the hit areas invisibly. Append to `components.css`:

```css
/* Extend hit areas to ≥44px without changing the iOS visuals */
.stepper button {
  position: relative;
}
.stepper button::after {
  content: '';
  position: absolute;
  inset: -6px -4px; /* 44px tall, ~55px wide clickable */
}
.toggle {
  position: relative;
}
.toggle::after {
  content: '';
  position: absolute;
  inset: -7px -2px; /* 45px tall, 55px wide clickable */
}
.navbar-text-button {
  display: flex;
  align-items: center;
  min-height: 44px;
  margin: -11px 0; /* absorb into the 44px navbar without growing it */
  padding: 0 2px;
}
```

### [P2] — Parameter rows mount/unmount with zero transition

- **What/Why:** toggling EMA/Stochastic/etc. conditionally renders rows (`{settings.emaEnabled ? <div className="grouped-row">…`) — React removes them instantly, so the card height snaps and every row below jumps. In the screenshot flow this is a 64px instant layout shift mid-sheet. iOS animates Form row insertion with a spring; the bar is 120–250ms eased. Violates Motion & Micro-interactions.
- **Location:** `apps/desktop/src/features/chart/IndicatorSettingsView.tsx:47-59, 67-79, 107-133, 146-158, 176-212, 220-232`
- **Exact fix:** tag the conditional rows and animate them in. Change each conditional row's class, e.g. line 48 → `<div className="grouped-row param-row">` (apply to lines 48, 68, 109, 120, 147, 178, 189, 200, 221), then append to `components.css`:

```css
.param-row {
  animation: param-row-in 200ms cubic-bezier(0.32, 0.72, 0, 1);
}
@keyframes param-row-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
```

### [P2] — No `prefers-reduced-motion` support anywhere

- **What/Why:** the sheet slide-up (`--sheet-anim: 300ms`, tokens.css:64), backdrop fade, toggle knob slide (200ms, components.css:279,296) and every other animation run at full strength for users who request reduced motion. Zero `@media (prefers-reduced-motion)` blocks exist in `apps/desktop/src/design/`. Violates Motion + Accessibility.
- **Location:** `apps/desktop/src/design/tokens.css:64`; `apps/desktop/src/design/base.css` (no media query present)
- **Exact fix:** append to `apps/desktop/src/design/base.css`:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
}
```

### [P2] — Inline `style={{}}` block overrides the Sheet's own tokens

- **What/Why:** lines 20-28 hand-write `background: var(--app-background)` plus a flex column that `.sheet-panel` already provides (components.css:128-134) — silently changing the sheet background from `--app-surface` (#1a1c24) to `--app-background` (#0b0c10). It works, but it's a one-off bypass of the component system: the next screen that forgets it gets a different-colored sheet. Violates Consistency (no one-off styles).
- **Location:** `apps/desktop/src/features/chart/IndicatorSettingsView.tsx:20-28`
- **Exact fix:** append to `components.css`:

```css
/* Grouped-form sheet content: darker grouped background over the sheet surface */
.sheet-body-fill {
  background: var(--app-background);
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
```

and replace lines 20-28 with `<div className="sheet-body-fill">`.

### [P2] — MACD parameters are hardcoded into the label, uneditable

- **What/Why:** every other indicator exposes its parameters (SMA/EMA/Bollinger/RSI/Stoch/ATR all get steppers), but MACD ships a fixed string "MACD (12, 26, 9)" (line 161). The magic numbers live in a display string rather than in `IndicatorSettings` (indicatorSettings.ts has no `macdFast/Slow/Signal` fields), so the label can silently drift from the calculation and the user can't tune it. Inconsistent UX + Consistency violation.
- **Location:** `apps/desktop/src/features/chart/IndicatorSettingsView.tsx:161`; `apps/desktop/src/features/chart/indicatorSettings.ts:10,31`
- **Exact fix:** add to the interface in `indicatorSettings.ts` (after line 10): `macdFastPeriod: number; macdSlowPeriod: number; macdSignalPeriod: number;` and to `DEFAULT_INDICATOR_SETTINGS` (after line 31): `macdFastPeriod: 12, macdSlowPeriod: 26, macdSignalPeriod: 9,`. Then replace lines 160-165 with:

```tsx
<div className="grouped-row">
  <span>MACD</span>
  <span className="row-value">
    <Toggle label="MACD" on={settings.macdEnabled} onChange={(on) => patch({ macdEnabled: on })} />
  </span>
</div>;
{
  settings.macdEnabled ? (
    <>
      <div className="grouped-row param-row">
        <span>Fast Period: {settings.macdFastPeriod}</span>
        <span className="row-value">
          <Stepper
            value={settings.macdFastPeriod}
            min={2}
            max={50}
            onChange={(value) => patch({ macdFastPeriod: value })}
          />
        </span>
      </div>
      <div className="grouped-row param-row">
        <span>Slow Period: {settings.macdSlowPeriod}</span>
        <span className="row-value">
          <Stepper
            value={settings.macdSlowPeriod}
            min={2}
            max={200}
            onChange={(value) => patch({ macdSlowPeriod: value })}
          />
        </span>
      </div>
      <div className="grouped-row param-row">
        <span>Signal Period: {settings.macdSignalPeriod}</span>
        <span className="row-value">
          <Stepper
            value={settings.macdSignalPeriod}
            min={2}
            max={50}
            onChange={(value) => patch({ macdSignalPeriod: value })}
          />
        </span>
      </div>
    </>
  ) : null;
}
```

(The chart's MACD calculation must then read these fields instead of its own constants.)

### [P2] — Stepper aria-labels are generic "Decrement"/"Increment"

- **What/Why:** with up to three steppers on screen (Stochastic), a screen reader user hears "Decrement, button" three times with no parameter association. Violates Accessibility.
- **Location:** `apps/desktop/src/design/components/Stepper.tsx:19,25`
- **Exact fix:** add a `label` prop describing the parameter and derive both buttons' names:

```tsx
interface StepperProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  onChange: (value: number) => void;
}
```

with `aria-label={`Decrease ${label}`}` (line 19) and `aria-label={`Increase ${label}`}` (line 25). Call sites pass e.g. `label="EMA period"` (IndicatorSettingsView.tsx:51-56), `label="Bollinger width"`, `label="%K smoothing"`, etc.

### [P2] — No series-color chips: rows don't map to chart lines

- **What/Why:** TradingView's indicator panel shows each series in its line color; here every row is identical white text, so a user toggling "SMA" has no idea it's the orange line. The exact tokens already exist (`--chart-sma: #ff9f0a`, `--chart-ema: #64d2ff`, `--chart-vwap: #bf5af2`, `--chart-rsi: #ffd60a`, `--chart-macd: #0a84ff`, tokens.css:21-30) and are unused on this screen. Violates Information Density (missing primary association) and DataViz (legend discipline).
- **Location:** `apps/desktop/src/features/chart/IndicatorSettingsView.tsx:42,62,82,88,99,141,161,168,215` (row labels)
- **Exact fix:** append to `components.css`:

```css
.indicator-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 8px;
  vertical-align: 1px;
}
.indicator-dot.sma {
  background: var(--chart-sma);
}
.indicator-dot.ema {
  background: var(--chart-ema);
}
.indicator-dot.vwap {
  background: var(--chart-vwap);
}
.indicator-dot.bb {
  background: var(--chart-bb-middle);
}
.indicator-dot.rsi {
  background: var(--chart-rsi);
}
.indicator-dot.macd {
  background: var(--chart-macd);
}
.indicator-dot.stoch {
  background: var(--chart-sma);
}
.indicator-dot.atr {
  background: var(--chart-ema);
}
```

then change each label, e.g. line 42 → `<span><span className="indicator-dot sma" />SMA</span>`, line 62 → `ema`, line 82 → `vwap`, line 99 → `bb`, line 141 → `rsi`, line 161 → `macd`, line 168 → `stoch`, line 215 → `atr`. (Volume row :88 gets no dot — it's a pane, not a line.) Meaning is text-first, color is redundant encoding, so a11y is preserved.

### [P2] — No visible keyboard focus ring on dark theme

- **What/Why:** the design system defines no `:focus-visible` style anywhere (only `input { outline: none }`, base.css:75). On an Electron desktop app keyboard users depend on the UA default outline, which is thin low-contrast blue-on-#1a1c24 and disappears entirely on the custom-styled toggle/stepper buttons. Violates Platform Fidelity (desktop keyboard) + Accessibility.
- **Location:** `apps/desktop/src/design/base.css:58-69` (button reset); no focus rule exists in `components.css`
- **Exact fix:** append to `base.css`:

```css
:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.toggle:focus-visible,
.stepper button:focus-visible {
  outline-offset: 3px;
}
```

### [P3] — Section rhythm breaks the 8pt grid (22px gap, 10px row padding)

- **What/Why:** `.grouped-list` uses `gap: 22px` (components.css:377) and rows use `padding: 10px 16px` (:405) — 22 and 10 sit off the 8pt grid the rest of the sheet follows (16/24/32 paddings, 44px rows). Visible in the screenshot as a slightly-too-tight 22px band between the two cards vs the 24px outer padding.
- **Location:** `apps/desktop/src/design/components/components.css:373-378, 400-409`
- **Exact fix:** line 377 → `gap: 24px;`; line 405 → `padding: 8px 16px;` (the 44px `min-height` still governs, so rendered row height is unchanged and every value is on-grid).

### [P3] — Separators run full-bleed instead of iOS's 16px leading inset

- **What/Why:** `.grouped-row + .grouped-row { border-top: 0.5px solid var(--app-border) }` paints edge-to-edge (confirmed in the screenshot — the hairlines touch both card edges). iOS grouped-list separators inset 16px from the leading edge to align with the label text. Violates Platform Fidelity.
- **Location:** `apps/desktop/src/design/components/components.css:411-413`
- **Exact fix:**

```css
.grouped-row + .grouped-row {
  border-top: none;
  background: linear-gradient(var(--app-border), var(--app-border)) 16px 0 / calc(100% - 16px) 0.5px
    no-repeat;
}
```

### [P3] — Sheet has no grabber and ~20% dead space with no footer

- **What/Why:** the large detent (`top: 10px`, components.css:137-139) leaves a ~180px void below the Sub-Panes card (screenshot: content ends at ~80% of frame height) and no grabber cue that this is a sheet at all. A footer row both fills the void with purpose and fixes the missing reset affordance (State Coverage). Violates Composition + Platform Fidelity.
- **Location:** `apps/desktop/src/design/components/Sheet.tsx:27`; `apps/desktop/src/features/chart/IndicatorSettingsView.tsx:234-235`
- **Exact fix:** grabber — append to `components.css`:

```css
.sheet-panel::before {
  content: '';
  flex: none;
  width: 36px;
  height: 5px;
  border-radius: 3px;
  background: rgba(235, 235, 245, 0.3);
  margin: 5px auto 0;
}
```

Reset footer — add a third section after line 234's closing `</div>`:

```tsx
<div className="grouped-section">
  <div className="section-card">
    <button className="grouped-row button-row" onClick={() => onChange(DEFAULT_INDICATOR_SETTINGS)}>
      Reset to Defaults
    </button>
  </div>
</div>
```

with `import { DEFAULT_INDICATOR_SETTINGS } from './indicatorSettings';` added to the import on line 6.

### [P3] — Toggle "on" state borrows the P&L-green token

- **What/Why:** `.toggle.on` uses `--pnl-positive` (#30d158, components.css:283-285) — a token reserved for profit/loss semantics. It happens to match iOS system green today, but the next time someone retunes P&L green for contrast, every switch in the app changes color. Violates Consistency (semantic token discipline).
- **Location:** `apps/desktop/src/design/components/components.css:283-285`; token `apps/desktop/src/design/tokens.css:14`
- **Exact fix:** add to `tokens.css` (after line 37): `--control-tint: #30d158; /* iOS systemGreen dark — switches, not P&L */` and change components.css:284 → `background: var(--control-tint);`.

### [P3] — 198-tap ranges with no direct value entry

- **What/Why:** SMA/EMA period spans 2…200 in steps of 1 (IndicatorSettingsView.tsx:53-55, 72-74) — worst case 198 taps to reach a value, no long-press acceleration, no typing. Robinhood/TradingView-class polish is tap-the-value-to-type. Violates State Coverage (no fast path) / "zero friction" bar.
- **Location:** `apps/desktop/src/features/chart/IndicatorSettingsView.tsx:51-56, 71-77`
- **Exact fix (minimal):** make the label an editable field. Replace line 49 with:

```tsx
<span>
  Period:{' '}
  <input
    className="param-input"
    type="number"
    min={2}
    max={200}
    value={settings.emaPeriod}
    onChange={(e) => {
      const v = Math.round(Number(e.target.value));
      if (v >= 2 && v <= 200) patch({ emaPeriod: v });
    }}
    aria-label="EMA period"
  />
</span>
```

plus CSS in `components.css`:

```css
.param-input {
  width: 44px;
  font: inherit;
  font-variant-numeric: tabular-nums;
  color: var(--label-primary);
  border-bottom: 0.5px solid var(--app-border);
  text-align: right;
}
```

(Repeat per parameter row; a shared `ParamStepper` component is the structural version.)

## Quick wins vs structural work

**Landable in <1 hour:**

- P1 toggle labels (prop + 9 call sites)
- P1 dialog semantics + focus-on-open in `Sheet.tsx`
- P1 hit-area pseudo-elements (pure CSS)
- P2 `param-row` enter animation (class rename + keyframes)
- P2 reduced-motion media query (one CSS block)
- P2 stepper `label` prop for aria-labels
- P2 `:focus-visible` ring (one CSS block)
- P3 8pt-grid fixes (22→24, 10→8), separator inset, grabber, `--control-tint` token

**Needs refactors:**

- P2 inline-style wrapper → shared `sheet-body-fill` class (touches the design-system contract; every Sheet consumer should adopt it)
- P2 MACD editable params (schema change in `IndicatorSettings`, defaults, chart calculation must consume the new fields, iOS parity change in `IndicatorSettings.swift` + `IndicatorSettingsView.swift:45`)
- P2 series-color chips (needs dot component + deciding pane-vs-line treatment for Volume; small but a design-system addition)
- P3 direct numeric entry (a real `ParamStepper` component with clamp/blur/keyboard semantics shared across all 10 rows, iOS parity)
- P3 Reset to Defaults (quick on desktop, but must ship with iOS parity to stay a clone)
