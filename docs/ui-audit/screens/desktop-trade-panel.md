# Screen d7: Trade panel (Options/Futures, Call/Put, AUTO, expiration, qty stepper, Mid/Market, SELL/BUY)
- **App:** Desktop
- **Location:** `apps/desktop/src/features/trade/TradePanel.tsx` (whole file; key refs: root style :58-67, AUTO button :97-110, qty row :245-294, action row :317-330), state context `TradeStore.ts:107-114` (qty clamp), `ChainStore.ts:131,158,220` (errorMessage set, never rendered), container math `TradeScreen.tsx:154-155,260-262`, styles `apps/desktop/src/design/components/components.css:245-270,331-370`, tokens `apps/desktop/src/design/tokens.css`
- **Visual:** screenshots `docs/ui-audit/shots/05-trade-split.png` (bottom panel) and `docs/ui-audit/shots/11-buy-disabled.png` — both read; they confirm the disabled 0.35-opacity SELL/BUY state, the "No contract" AUTO cell, and row alignment.
- **Scores:** Composition 6/10 · Typography 6/10 · Color 4/10 · Density 7/10 · DataViz 5/10 · Motion 3/10 · States 3/10 · Platform 4/10 · A11y 4/10 · Consistency 5/10 → **Overall 46/100**
- **Score justifications:**
  - Composition 6: chart/panel split ≈63/34 (screenshot y≈1230/1864) is near the golden 62/38 and vertical gaps are a steady 8px, but qty row uses gap 10, action row gap 12, steppers are 30px, AUTO cell minHeight 34, panel bottom padding is 0 — off the 8pt grid in five places.
  - Typography 6: strike and qty use `--font-mono` (:156,:266) but the live bid×ask/mid readouts (:164-166,:237-239,:307-312) are proportional sans, so digits jitter on every tick; sizes are tokenized throughout (good).
  - Color 4: white-on-`--buy-green` #19b85b = 2.61:1 (needs ≥4.5:1), white-on-`--app-accent` #568ff7 AUTO chip = 3.15:1 at 12px, white-on-`--sell-red` #e13a43 = 4.30:1 — all fail WCAG AA for their size; disabled state compounds it (0.35 opacity, screenshot 11 shows near-illegible labels).
  - Density 7: hierarchy is right — primary CTA row 52px dominant, ticket controls secondary, indicative bid×ask/mid as tertiary caption; nothing is duplicated except the +1 chip (see findings).
  - DataViz 5: the panel's "viz" is quote readouts; they update silently with no tick flash, no skeletons, and a 14px spinner as the only loading affordance (:151).
  - Motion 3: zero transitions/press states on any panel control; segmented knobs snap; only global sheet/toast animations exist (grep: no `:hover`, no `transition` in any trade-panel-related CSS except toggle).
  - States 3: chain errors are swallowed (ChainStore.errorMessage written at :158/:220, rendered nowhere), futures loading has no indicator, disabled buttons give no reason, and at min split height the SELL/BUY row is clipped away entirely (P0 #1).
  - Platform 4: divider gets `cursor: ns-resize` and buttons get `cursor: pointer`, but no hover, no `:focus-visible`, no keyboard menu nav (Esc only, Menu.tsx:30-32), hit targets 28–34px vs 44pt HIG.
  - A11y 4: steppers and AUTO have `aria-label` (:107,:260,:286 — good), but AUTO lacks `aria-pressed`, Menu lacks `aria-haspopup`/`aria-expanded`/menu roles, disabled SELL/BUY is opacity-only with no announced reason.
  - Consistency 5: TradePanel hand-rolls inline styles in 12 places despite the token system; a `Stepper` component exists (`design/components/Stepper.tsx`) yet qty uses one-off circular buttons; `--buy-green` vs `--pnl-positive` are two competing greens.

## Findings

### [P0] — SELL/BUY row is clipped and unreachable at minimum split height
- **What/Why:** State coverage + composition. `TradeScreen.tsx:154` clamps `panelHeight` to `max(round(contentHeight × splitFraction), 120)` and drag clamps fraction to 0.25 (:246); content height ≈ 795px (932 − 59 status − 44 navbar − 34 home indicator) ⇒ min panel ≈ 199px. The panel's content needs ≈264px with an empty PositionsStrip (4 top pad + 32 segmented + 74 options block + 30 qty + 32 order-type + 52 actions + 5×8 gaps) and ≈334px once a position chip row appears. `TradePanel.tsx:66` sets `overflow: 'hidden'`, so at fraction ≤ ~0.33 the 52px SELL/BUY row is silently cut off — the primary action of the entire app disappears with no scroll and no visual cue.
- **Location:** `apps/desktop/src/features/trade/TradePanel.tsx:66`, `apps/desktop/src/features/trade/TradeScreen.tsx:154,246`
- **Exact fix:** In `TradeScreen.tsx:154` raise the floor to fit the ticket: `const panelHeight = Math.max(Math.round(contentHeight * splitFraction), 300);` and in `TradeScreen.tsx:246` raise the drag clamp: `setSplitFraction(Math.min(0.5, Math.max(0.34, drag.startFraction + delta)));`. In `TradePanel.tsx:66` change `overflow: 'hidden'` → `overflowY: 'auto'` as a safety net so the action row can never be clipped away.

### [P0] — Chain load failure kills SELL/BUY with zero in-panel feedback or recovery
- **What/Why:** State coverage. `ChainStore.errorMessage` is set on load/ensure failures (`ChainStore.ts:158,220`) but rendered by no component (grep confirms only the store references it). On failure the AUTO cell falls through to "No contract" (`TradePanel.tsx:169-171`), `canTrade` goes false (:52), and the buttons dim — the exact dead-end visible in screenshot 11 ("No contract" + greyed SELL/BUY, no reason, no retry). For a trade ticket this is ship-blocking: the user cannot act and is not told why or how to recover.
- **Location:** `apps/desktop/src/features/trade/TradePanel.tsx:150-172`, `apps/desktop/src/features/trade/ChainStore.ts:158,220`
- **Exact fix:** Render the error in place of the AUTO cell, before the `chain.isLoading` branch at `TradePanel.tsx:150`:
  ```tsx
  {chain.errorMessage ? (
    <button
      className="text-secondary"
      style={{ fontSize: 'var(--fs-caption)', display: 'flex', alignItems: 'center', gap: 6 }}
      onClick={() => void chainStore.load(chain.underlying)}
      aria-label={`Chain failed to load: ${chain.errorMessage}. Tap to retry`}
    >
      <span style={{ color: 'var(--pnl-negative)' }}>Chain unavailable — Retry</span>
    </button>
  ) : chain.isLoading ? (
  ```
  and add a `title={trade.assetClass === 'option' ? 'Select a contract to trade' : 'Select a futures contract to trade'}` on the disabled `TradeActionButton` (`TradeActionButton.tsx:16-24`, pass a new `disabledReason?: string` prop rendered as `title` + `aria-disabled`).

### [P1] — BUY label contrast 2.61:1, SELL 4.30:1 — both fail WCAG AA
- **What/Why:** Color & contrast. `.trade-action-button` sets white text on `--buy-green` #19b85b (relative luminance 0.353 ⇒ 2.61:1, needs ≥4.5:1 for 17px/600 text; even the 3:1 large-text bar fails) and on `--sell-red` #e13a43 (L 0.194 ⇒ 4.30:1, fails 4.5:1 since 17px semibold is below the 18.66px-bold large-text threshold). These are the two most important labels in the app.
- **Location:** `apps/desktop/src/design/components/components.css:331-341` (`color: #fff`), tokens `apps/desktop/src/design/tokens.css:10-11`
- **Exact fix:** Switch the label to the app background color (Robinhood uses dark text on its green): in `components.css:336` change `color: #fff;` → `color: #0b0c10;` (yields 7.5:1 on buy-green, 4.55:1 on sell-red). Keep `--buy-green`/`--sell-red` untouched since PositionsStrip/chart use the other green semantics.

### [P1] — AUTO active chip: white on accent = 3.15:1 at 12px, state is color-only
- **What/Why:** Color & a11y. `TradePanel.tsx:103-104` renders 12px/600 white text on `--app-accent` #568ff7 (L 0.284 ⇒ 3.15:1, needs 4.5:1) and the on/off state is conveyed by background color alone — no `aria-pressed`, no icon change.
- **Location:** `apps/desktop/src/features/trade/TradePanel.tsx:97-110`
- **Exact fix:** Change the color expression at :104 to `color: chain.isAutoMode ? '#0b0c10' : 'var(--label-primary)'` (6.2:1 on accent) and add to the button: `aria-pressed={chain.isAutoMode}` plus a state glyph: `{chain.isAutoMode ? <CheckmarkIcon size={11} /> : null}` before `AUTO` (import `CheckmarkIcon` from `../../design/icons`).

### [P1] — Disabled SELL/BUY is illegible and unexplained
- **What/Why:** States + contrast. `TradeActionButton.tsx:18` dims the whole button to `opacity: 0.35`, so on #0b0c10 the disabled label drops to ≈1.6:1 — screenshot 11 shows "SELL"/"BUY" as barely-visible smudges. Disabled controls are WCAG-exempt, but the design bar is not "exempt", it's legible + self-explanatory. Nothing says *why* they're disabled.
- **Location:** `apps/desktop/src/design/components/TradeActionButton.tsx:18`
- **Exact fix:** Replace wholesale opacity with a designed disabled surface:
  ```tsx
  style={{
    background: isEnabled ? color : 'var(--app-surface-elevated)',
    color: isEnabled ? '#0b0c10' : 'var(--label-secondary)',
  }}
  ```
  (drop the `opacity` property) and thread a `disabledReason` as `title` per finding #2. Disabled text then sits at 5.4:1 and matches the app's dimmed-button idiom (`.button-primary.dimmed` is the same-opacity offender — out of scope here but same fix applies).

### [P1] — Live prices render in proportional sans; digits jitter every tick
- **What/Why:** Typography + DataViz. Three quote readouts — AUTO mid (:164-166), futures mid (:237-239), bid×ask/mid (:307-312) — inherit `--font-sans`, while the strike/qty next to them use `--font-mono`. Quotes update live (`TradeScreen.tsx:85-91`) and every 30s (:96-102), so widths jump on each tick; the project itself mandates "tabular figures for ALL prices".
- **Location:** `apps/desktop/src/features/trade/TradePanel.tsx:164-166,237-239,307-312`
- **Exact fix:** Add to each of the three `<span>` styles: `fontFamily: 'var(--font-mono)'` (the mono stack is tabular); e.g. at :307: `style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-caption)', flex: 'none' }}`.

### [P1] — Off-grid geometry: gaps of 10/12, 30px steppers, 34px cell, bottom padding 0
- **What/Why:** Composition. The panel nails 8px vertical gaps (:61,:87,:113) then breaks the grid: qty row `gap: 10` (:245), order-type row `gap: 10` (:297), action row `gap: 12` (:317), stepper buttons `width/height: 30` (:251-252,:276-277), AUTO cell `minHeight: 34` (:140), qty value `minWidth: 36` (:269), root `padding: '4px 12px 0'` (:63) — bottom 0 leaves SELL/BUY touching the panel edge (screenshot confirms ~0 gap above the home-indicator zone). Row heights across the panel run 28/30/32/34/52 with no rhythm.
- **Location:** `apps/desktop/src/features/trade/TradePanel.tsx:63,140,245,251-252,269,276-277,297,317`
- **Exact fix:** All three `gap: 10`/`gap: 12` → `gap: 8`; stepper `width: 30, height: 30` → `width: 36, height: 36`; AUTO cell `minHeight: 34` → `minHeight: 36`; root padding → `padding: '8px 12px 12px'`; qty value `minWidth: 36` → `minWidth: 40`.

### [P1] — Hit targets 28–34px vs the 44pt minimum
- **What/Why:** Platform fidelity (the desktop frame clones iOS, and it is also the a11y floor for coarse pointers). Measured/computed: segmented 32px (`components.css:250`), steppers 30px (:251-252), AUTO chip ≈28px (`padding: '8px 12px'` + 12px text, :101), QuickChips ≈28px (`components.css:346` `padding: 8px 14px`), chip-buttons ≈30px (:359 `padding: 8px 10px`). Only the 52px action row clears the bar.
- **Location:** `apps/desktop/src/design/components/components.css:250,343-364`, `apps/desktop/src/features/trade/TradePanel.tsx:101,251-252`
- **Exact fix:** `components.css:250` `height: 32px` → `height: 36px`; `:346` `padding: 8px 14px` → `padding: 10px 16px`; `:359` `padding: 8px 10px` → `padding: 10px 12px`; steppers → 36px (finding #7); AUTO chip `padding: '8px 12px'` → `padding: '10px 14px'`. (36px is the dense-ticket compromise; 44px is the HIG ideal and should be the target if the panel floor from finding #1 is raised.)

### [P1] — Zero hover, focus, or press feedback on a mouse-driven desktop app
- **What/Why:** Platform + motion. Grep across `apps/desktop/src` finds no `:hover`, no `:focus-visible`, no `prefers-reduced-motion`. Only `:active` exists (`.menu-item`, `components.css:240`). Keyboard users get no focus ring (base.css kills outlines on inputs and UA button focus is unstyled), mouse users get no hover affordance, and tapping SELL/BUY gives no press state — dead-feeling controls.
- **Location:** `apps/desktop/src/design/components/components.css:255-270,331-349` (controls with no interaction states)
- **Exact fix:** Append to `components.css`:
  ```css
  .segment:hover, .quick-chip:hover, .chip-button:hover, .menu-item:hover { filter: brightness(1.18); }
  .trade-action-button:hover:not(:disabled) { filter: brightness(1.12); }
  .trade-action-button:active:not(:disabled), .quick-chip:active, .chip-button:active { transform: scale(0.97); transition: transform 120ms ease-out, filter 120ms ease-out; }
  button:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 2px; border-radius: inherit; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
  ```

### [P2] — Hand-rolled qty stepper ignores the existing `Stepper` component; `+1` chip duplicates `+`
- **What/Why:** Consistency + density. `design/components/Stepper.tsx` (94×32 two-segment iOS stepper, with disabled states) exists and is unused here; TradePanel instead hand-codes two 30px circles (:249-289). And `QuickChip title="+1"` (:291) performs exactly what the `+` button does — four increment controls in one row, three of which (+, +1) overlap.
- **Location:** `apps/desktop/src/features/trade/TradePanel.tsx:249-293`, `apps/desktop/src/design/components/Stepper.tsx`
- **Exact fix:** Delete the two circular buttons and the `+1` chip; render `<Stepper value={trade.quantity} onDecrement={() => tradeStore.addQuantity(-1)} onIncrement={() => tradeStore.addQuantity(1)} decrementDisabled={trade.quantity <= 1} />` (adjust props to Stepper.tsx's actual signature) and keep only `+5`/`+10` QuickChips. Note the stepper never disables `−` at qty 1 today — `TradeStore.setQuantity` silently clamps (`TradeStore.ts:109`), so the user gets zero feedback at the floor; `decrementDisabled` fixes that.

### [P2] — Menu has no popup semantics, focus management, or arrow-key navigation
- **What/Why:** A11y + platform. `Menu.tsx:43` toggles on a plain `div onClick`; the trigger exposes no `aria-haspopup`/`aria-expanded`; the dropdown is a bare `div` of buttons with no `role="menu"`/`role="menuitem"`; Esc closes (:30-32) but ↑/↓ do nothing and focus never enters the menu — keyboard users must Tab through every item blind, and screen readers announce a disembodied button list. Expiration menus can hold 5+ rows, strike menus 30+.
- **Location:** `apps/desktop/src/design/components/Menu.tsx:43-63`
- **Exact fix:** On the trigger wrapper at :43 add `role="button" aria-haspopup="menu" aria-expanded={open}`; on the dropdown at :47 add `role="menu"` and on each item `role="menuitem"`; extend the `onKey` handler with `if (event.key === 'ArrowDown') wrapRef.current?.querySelector<HTMLButtonElement>('.menu-item')?.focus();` and add `onKeyDown` on the dropdown for ArrowUp/ArrowDown (`e.currentTarget.querySelectorAll('.menu-item')` index stepping) plus Escape returning focus to the trigger.

### [P2] — Segmented knob snaps instantly; no tick feedback on price changes
- **What/Why:** Motion. `.segment.selected` (`components.css:266-270`) swaps background/font-weight with no transition — three segmented controls on this panel all pop. Separately, quote readouts change value silently; Robinhood/TradingView flash green/red on ticks, which is the single cheapest "holy shit" detail a trading panel can have.
- **Location:** `apps/desktop/src/design/components/components.css:255-270`, `apps/desktop/src/features/trade/TradePanel.tsx:307-312`
- **Exact fix:** Add `.segment { transition: background-color 180ms cubic-bezier(0.32, 0.72, 0, 1); }` (reuse the sheet easing token) and add a tick-flash to the bid×ask span via a tiny hook: key the span on the quote values (`key={`${selectedQuote.bid}-${selectedQuote.ask}`}`) and define
  ```css
  @keyframes quote-flash { from { background: rgba(86, 143, 247, 0.25); } to { background: transparent; } }
  .quote-readout { animation: quote-flash 250ms ease-out; border-radius: 4px; padding: 2px 4px; }
  ```

### [P3] — One-off pill: AUTO chip hand-codes what `.quick-chip` already is
- **What/Why:** Consistency. `TradePanel.tsx:98-105` inlines `fontSize/fontWeight/padding/borderRadius: 999/background` — a byte-for-byte restatement of `.quick-chip` (`components.css:343-349`) plus the active variant. Two sources of truth for one pill; a radius or padding change will drift.
- **Location:** `apps/desktop/src/features/trade/TradePanel.tsx:97-110`, `apps/desktop/src/design/components/components.css:343-349`
- **Exact fix:** Add `.quick-chip.active { background: var(--app-accent); color: #0b0c10; }` to `components.css` and replace the inline-styled button with `<button className={\`quick-chip${chain.isAutoMode ? ' active' : ''}\`} …>`.

### [P3] — Quote readout pops in/out, resizing the Mid/Market segmented control
- **What/Why:** Composition. The bid×ask span (:306-313) renders only `selectedQuote ? … : null`; when the first quote lands (or a contract is deselected) the `flex: 1` segmented control visibly shrinks/grows — a layout shift in the row directly above the CTA. Same pattern in the futures row (:236-240).
- **Location:** `apps/desktop/src/features/trade/TradePanel.tsx:306-313,236-240`
- **Exact fix:** Always render the span with a placeholder: replace the conditional with `<span className="text-secondary" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-caption)', flex: 'none', minWidth: 96, textAlign: 'right', visibility: selectedQuote ? 'visible' : 'hidden' }}>` (drop `visibility` once a quote exists, keeping `minWidth` so width changes only with content).

### [P3] — Divider grabber and horizontal padding drift from screen rhythm
- **What/Why:** Platform + consistency. The drag divider (`TradeScreen.tsx:223-258`) is pointer-only: no `role="separator"`, no `aria-valuenow`, no keyboard resize — and its 48×5 grabber uses `--app-border` at 65% alpha, nearly invisible against `--app-surface` (measured in screenshot: the pill reads as a faint smudge). Separately, the panel pads 12px (:63) while the NavBar pads 16px (`components.css:62`) and `--pad-screen` is 24 — three competing page margins on one screen.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:223-258`, `apps/desktop/src/features/trade/TradePanel.tsx:63`
- **Exact fix:** On the divider div add `role="separator" aria-orientation="horizontal" aria-valuenow={Math.round(splitFraction * 100)} tabIndex={0}` and an `onKeyDown` mapping ArrowUp/ArrowDown to `setSplitFraction(f => Math.min(0.5, Math.max(0.34, f ± 0.02)))`; change the grabber background to `'var(--label-secondary)'`; align the panel to the navbar: `padding: '8px 16px 12px'`.

### [P3] — Two greens, two reds: `--buy-green` ≠ `--pnl-positive`
- **What/Why:** Consistency + color semantics. Tokens define `--buy-green` #19b85b for action buttons and `--pnl-positive` #30d158 for P/L (tokens.css:10,14) — in the same panel a position chip can glow #30d158 above a #19b85b BUY, two visibly different "good" greens (same for #e13a43 vs #ff453a). Apple/Robinhood ship exactly one green per semantic.
- **Location:** `apps/desktop/src/design/tokens.css:10-15`
- **Exact fix:** Decide one action green (recommend `--buy-green: #0f9d4a`-family darkened fill per finding #3 with `#0b0c10` text) and keep `--pnl-positive` for text-only P/L; then document in tokens.css: `/* buy-green = filled CTAs only; pnl-positive = text/glyphs only */` and grep-audit usages so neither leaks into the other role.

## Quick wins vs structural work

**< 1 hour (verbatim from findings):**
- #3 button label color `#fff` → `#0b0c10` (one line, components.css:336)
- #4 AUTO `aria-pressed` + dark active text (TradePanel.tsx:103-107)
- #5 designed disabled state (TradeActionButton.tsx:18)
- #6 mono font on the three quote spans
- #7 grid fixes: gaps → 8, steppers → 36, padding → `8px 12px 12px`
- #9 hover/focus/press CSS block (append to components.css)
- #13 shared `.quick-chip.active` class
- #14 reserve quote-readout width with `minWidth`/`visibility`
- #16 tokens.css comment + grabber color

**Structural (needs refactor/design decision):**
- #1 panel-height floor + `overflowY: auto` (touches split-layout math and drag clamps in TradeScreen)
- #2 in-panel chain error + retry (new error UI branch; needs a designed error row, ideally shared with ChartView's error style)
- #10 Stepper component adoption + removing the `+1` chip (changes panel row layout)
- #11 Menu keyboard/focus model (real focus management, roving tabindex — touches every Menu consumer)
- #12 sliding segmented knob + quote tick-flash (knob slide requires re-architecting SegmentedControl to a moving indicator; flash needs a quote-diff hook)
- #15 divider as a full `role="separator"` widget with keyboard control
- #16 green/red semantic unification across tokens and all consumers
