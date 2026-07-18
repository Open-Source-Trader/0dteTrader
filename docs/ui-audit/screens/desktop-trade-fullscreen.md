# Screen d5: Trade screen — Layout A (fullscreen)
- **App:** Desktop
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx` (fullscreen branch L188–210, NavBar L169–185, sheets L271–291, `canTrade` L149–152), `apps/desktop/src/features/trade/FloatingTradeButtons.tsx` (whole file), with direct dependencies `apps/desktop/src/design/components/TradeActionButton.tsx`, `apps/desktop/src/design/components/NavBar.tsx`, `apps/desktop/src/design/tokens.css`, `apps/desktop/src/design/base.css`, `apps/desktop/src/design/components/components.css`, `apps/desktop/src/features/trade/PositionsStrip.tsx`, and the chart error state it hosts at `apps/desktop/src/features/chart/ChartView.tsx:241-257`
- **Visual:** screenshot `docs/ui-audit/shots/08-trade-fullscreen.png` (860×1864 @2x; chart in no-credentials error state, BUY/SELL disabled). Verified at native resolution incl. a 380×160 crop of the button row.
- **Scores:** Composition 6/10 · Typography 5/10 · Color 4/10 · Density 6/10 · DataViz 4/10 · Motion 3/10 · States 4/10 · Platform 3/10 · A11y 4/10 · Consistency 4/10 → **Overall 43/100**
- **Score justifications:**
  - Composition 6 — Button row is symmetric (2×~181px, 16px gap, 20px insets) and the 52px targets are right, but `bottom:12` + `gap:10` (TradeScreen.tsx:201,204) break the 8pt grid and the strip's 12px inset (PositionsStrip.tsx:42) doesn't align with the buttons' 20px inset.
  - Typography 5 — SELL/BUY headline 17/600 is correct, but position prices/P&L render in proportional sans despite a `--font-mono` token (PositionsStrip.tsx:58-69), and the error copy wraps an orphan word ("first") at 13px.
  - Color 4 — Error text passes (≈6.3:1), but white on `--buy-green` #19b85b is 2.59:1 — fails even the 3:1 large-text floor on the app's primary CTA; SELL on #e13a43 is 4.27:1 (passes only as large text).
  - Density 6 — Fullscreen layout is intentionally sparse and the positions strip overlays without reflowing the chart; acceptable, though the error state leaves ~80% of the canvas dead with no hierarchy.
  - DataViz 4 — Error state shows plain text over an empty canvas while stale user drawings (vertical rule + path, visible in screenshot) still render; loading is a spinner, no skeleton.
  - Motion 3 — Only sheets/toasts have keyframes; trade buttons have zero transition/press state, the layout toggle swaps instantly, sheets unmount with no exit animation, no `prefers-reduced-motion` anywhere.
  - States 4 — Error text is passive (names Profile but offers no action), disabled BUY/SELL never say why, loading = spinner not skeleton, no offline handling at screen level.
  - Platform 3 — Grep of `apps/desktop/src/design` finds no `:hover` and no `:focus-visible` anywhere; only `cursor:pointer` (base.css:63); navbar hit areas are icon-sized (~20px); no keyboard support.
  - A11y 4 — `aria-label`s exist on all icon/trade buttons, but the layout toggle lacks `aria-pressed`, disabled buttons don't announce a reason, there are no focus rings, and targets are <44pt.
  - Consistency 4 — Colors are tokenized, but geometry is inline magic numbers everywhere (TradeScreen.tsx:168,189,196-205; FloatingTradeButtons.tsx:12; PositionsStrip.tsx:17-24) and navbar icon sizes disagree (22 vs 20).

## Findings

### [P1] — BUY label contrast 2.59:1 on `--buy-green` fails WCAG even for large text
- **What/Why:** Color&Contrast. White 17px/600 "BUY" on `#19b85b`: relative luminance of the fill ≈ 0.356 → contrast = 1.05/0.406 ≈ **2.59:1**, below the 3:1 large-text minimum and far below 4.5:1. SELL on `#e13a43` is 4.27:1 — passes only because 17px/600 counts as large text. The primary action of a trading app should not be the weakest-contrast element on screen; in the screenshot the dimmed-disabled state degrades it further.
- **Location:** `apps/desktop/src/design/tokens.css:10` (token), consumed at `apps/desktop/src/design/components/components.css:331-341` and `apps/desktop/src/features/trade/FloatingTradeButtons.tsx:19-24`
- **Exact fix:** Add a button-specific darker green in `tokens.css` (keep `--buy-green` for accents/chart):
  ```css
  --buy-green-button: #0e7a3c; /* white text = 5.3:1, passes 4.5:1 */
  --sell-red-button: #c9242e;  /* white text = 5.0:1, passes 4.5:1 */
  ```
  and in `FloatingTradeButtons.tsx` use `color="var(--sell-red-button)"` / `color="var(--buy-green-button)"`.

### [P1] — Disabled state is `opacity: 0.35`, so chart content bleeds through the primary buttons
- **What/Why:** Color&Contrast + State Coverage + DataViz. `TradeActionButton` dims by setting `opacity: 0.35` on the whole button (TradeActionButton.tsx:18). Because the buttons float over the live chart (TradeScreen.tsx:196-209), 65% transparency lets whatever is beneath show through — verified in the screenshot: a user drawing (white "W"-shaped path) and a vertical chart rule are visible *through* the disabled SELL button (crop of region x60–440, y1640–1800). Translucent primary CTAs over a data-dense canvas will look broken in every session, not just this one.
- **Location:** `apps/desktop/src/design/components/TradeActionButton.tsx:18`
- **Exact fix:** Keep the button opaque; dim via solid colors instead:
  ```tsx
  style={{
    background: isEnabled ? color : `color-mix(in srgb, ${color} 30%, var(--app-surface))`,
    color: isEnabled ? '#fff' : 'rgba(255, 255, 255, 0.45)',
    transition: 'background 150ms ease-out, transform 80ms ease-out',
  }}
  ```

### [P1] — Chart error state is a dead-end: names the fix ("Profile") but provides no action
- **What/Why:** State Coverage. The no-credentials error (ChartView.tsx:241-257) renders a single 13px `text-secondary` centered string — "No Webull credentials on file — save app key/secret in Profile first" — with no icon, no CTA, and it wraps leaving the orphan word "first" on line two (visible in screenshot). State-coverage bar: actionable errors. A first-run user hits exactly this state and is stranded; the profile sheet is one tap away via the navbar person icon but nothing connects the two.
- **Location:** `apps/desktop/src/features/chart/ChartView.tsx:241-257` (hosted by the fullscreen branch at `TradeScreen.tsx:190-195`)
- **Exact fix:** Replace the bare text block with an actionable empty state (add an `onOpenProfile?: () => void` prop to `ChartView`, pass `() => setShowProfile(true)` from TradeScreen.tsx:190):
  ```tsx
  {errorMessage && candles.length === 0 ? (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 }}>
      <PersonCircleIcon size={32} />
      <span className="text-secondary" style={{ fontSize: 'var(--fs-subheadline)', textAlign: 'center', maxWidth: 300 }}>
        {errorMessage}
      </span>
      {onOpenProfile ? (
        <button className="button-primary" style={{ width: 200 }} onClick={onOpenProfile}>
          Open Profile
        </button>
      ) : null}
    </div>
  ) : null}
  ```

### [P1] — Desktop platform layer is inert: no hover, no focus rings, anywhere
- **What/Why:** Platform Fidelity + Accessibility. A repo-wide grep of `apps/desktop/src/design` for `:hover|:focus` returns zero matches; the only pointer affordance is `cursor:pointer` (base.css:63) and `cursor:default` for disabled (base.css:68). On a mouse-driven desktop clone, buttons (including SELL/BUY, navbar icons, chips) give zero hover feedback and keyboard users get no focus indicator — WCAG 2.4.7 focus-visible failure.
- **Location:** `apps/desktop/src/design/base.css:58-69`, `apps/desktop/src/design/components/components.css:94-98, 331-341`
- **Exact fix:** Append to `components.css`:
  ```css
  .trade-action-button:hover:not(:disabled) { filter: brightness(1.12); }
  .trade-action-button:active:not(:disabled) { transform: scale(0.97); }
  .navbar-icon-button:hover { opacity: 0.7; }
  button:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 2px; border-radius: var(--radius-chip); }
  ```

### [P1] — Navbar icon hit areas are ~20–22px, under half the 44pt minimum
- **What/Why:** Platform Fidelity + Accessibility. `.navbar-icon-button` (components.css:94-98) is a bare flex wrapper with no padding or min-size, so the clickable area equals the icon glyph: 22px profile (TradeScreen.tsx:173), 20px history (L176), 20px layout toggle (L181). HIG/desktop pointer guidance is ≥44×44pt (iOS) / ≥24px minimum (desktop WCAG 2.5.8); these fail both.
- **Location:** `apps/desktop/src/design/components/components.css:94-98`, used at `apps/desktop/src/features/trade/TradeScreen.tsx:172-183`
- **Exact fix:**
  ```css
  .navbar-icon-button {
    color: var(--app-accent);
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    height: 44px;
    margin: 0 -8px; /* keep visual spacing while enlarging the hit area */
  }
  ```

### [P2] — Disabled BUY/SELL never explain why
- **What/Why:** State Coverage + Accessibility. `canTrade` (TradeScreen.tsx:149-152) is false when no contract/future is selected — and, as in the screenshot, when credentials are missing and the chain never loads. The buttons just sit there dimmed; nothing tells the user what unlocks them. Screen readers get `aria-label="BUY"` + `disabled` with no reason.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:149-152, 208`; `apps/desktop/src/features/trade/FloatingTradeButtons.tsx:10-26`
- **Exact fix:** Pass a reason down and render it above the buttons:
  ```tsx
  // TradeScreen.tsx
  const disabledReason = chart.errorMessage
    ? 'Market data unavailable — check credentials in Profile'
    : trade.assetClass === 'option' && !chainStore.selectedContract
      ? 'Select an option contract to trade'
      : null;
  // FloatingTradeButtons.tsx — above the button row:
  {!isEnabled && disabledReason ? (
    <span role="status" className="text-secondary"
          style={{ fontSize: 'var(--fs-caption)', textAlign: 'center' }}>
      {disabledReason}
    </span>
  ) : null}
  ```

### [P2] — Positions strip prices/P&L use proportional sans, ignoring the mono token
- **What/Why:** Typography. `--font-mono` exists (tokens.css:42-43) precisely for tabular figures, but the strip renders `{Format.price(position.avgPrice)}` and `{Format.signedPrice(position.unrealizedPnl)}` in the default sans (PositionsStrip.tsx:58-69). Numbers in horizontally-scrolling chips will jitter width as quotes tick, and the desktop clone diverges from iOS `AppTypography` monospaced price fonts.
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx:58-69`
- **Exact fix:** Add `fontFamily: 'var(--font-mono)'` to both spans (the `qty @ price` line at L58-60 and the P&L line at L61-70).

### [P2] — 8pt-grid violations and misaligned insets in the floating cluster
- **What/Why:** Composition&Proportion. The overlay stack uses `bottom: 12` and `gap: 10` (TradeScreen.tsx:201,204) — 10 is not on the 4/8pt rhythm; the positions rows inset at 12px (PositionsStrip.tsx:42,80) while the buttons inset at 20px (FloatingTradeButtons.tsx:12), so stacked left edges disagree by 8px; the buttons' bottom margin of 12px above the 34px home-indicator zone puts the button's visual bottom at an odd 46px from the frame edge.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:196-206`, `apps/desktop/src/features/trade/FloatingTradeButtons.tsx:12`, `apps/desktop/src/features/trade/PositionsStrip.tsx:42,80`
- **Exact fix:** `bottom: 16`, `gap: 8` in TradeScreen.tsx; change PositionsStrip row padding to `'0 20px'` (both occurrences) so chips and buttons share one inset.

### [P2] — Sheets unmount instantly: enter animation with no exit
- **What/Why:** Motion&Micro-interactions. All five sheets are conditionally rendered (TradeScreen.tsx:271-291); `.sheet-panel` animates in via `sheet-up 300ms cubic-bezier(0.32,0.72,0,1)` (components.css:130, tokens.css:64) but on dismiss the node is removed from the DOM in the same frame — a hard cut. Robinhood-class polish requires symmetric motion.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:271-291`, `apps/desktop/src/design/components/components.css:123-135`, `apps/desktop/src/design/base.css:140-147`
- **Exact fix:** Add a closing state to the shared `Sheet` component: on dismiss set `closing=true`, apply
  ```css
  .sheet-panel.closing { animation: sheet-down 220ms cubic-bezier(0.32, 0.72, 0, 1) forwards; }
  .sheet-backdrop.closing { animation: backdrop-out 220ms ease-in forwards; }
  ```
  with `@keyframes sheet-down { to { transform: translateY(100%); } }` and `@keyframes backdrop-out { to { opacity: 0; } }`, then call the real `onDismiss` from `onAnimationEnd`.

### [P2] — Layout toggle button doesn't announce its state
- **What/Why:** Accessibility. The toggle (TradeScreen.tsx:181-183) has a static `aria-label="Toggle layout"`; a screen-reader user can't tell which layout is active or what the press will do. The icon swap (split vs fullscreen glyph) is the only state signal, and it's visual-only.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:180-184`
- **Exact fix:**
  ```tsx
  <button className="navbar-icon-button" onClick={toggleLayout}
          aria-pressed={layout === 'split'}
          aria-label={layout === 'fullscreen' ? 'Switch to split layout' : 'Switch to fullscreen layout'}>
  ```

### [P2] — No `prefers-reduced-motion` handling anywhere
- **What/Why:** Motion&Micro-interactions + Accessibility. Sheet, backdrop, toast, spinner, and toggle animations (tokens.css:64-65; base.css:123-156; components.css:279,296) all run unconditionally. Vestibular-sensitive users get full 300ms sheet slides with no opt-out.
- **Location:** `apps/desktop/src/design/base.css:123-156`, `apps/desktop/src/design/components/components.css:279,296`
- **Exact fix:** Append to `base.css`:
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
  ```

### [P3] — Navbar icon sizes disagree: 22 vs 20
- **What/Why:** Consistency. `PersonCircleIcon size={22}` (TradeScreen.tsx:173) next to `ClockIcon size={20}` (L176) and `LayoutSplitIcon size={20}` (L182) — a 2px optical mismatch in one toolbar; SF Symbols convention is one size per bar.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:173,176,182`
- **Exact fix:** Standardize on `size={22}` for all three (person.circle, clock, and layout glyphs optically match at 22).

### [P3] — Floating buttons have no elevation; busy chart pixels touch the CTA edge
- **What/Why:** DataViz + Composition. The buttons sit directly on the chart canvas with no shadow or scrim (FloatingTradeButtons.tsx:12; `.trade-action-button` components.css:331-341 has no `box-shadow`). With candles/drawings scrolling beneath (and bleed-through per the P1 above), the cluster visually merges into the chart. In the screenshot the vertical chart rule runs unbroken into the button row.
- **Location:** `apps/desktop/src/design/components/components.css:331-341`
- **Exact fix:** `.trade-action-button { box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45); }` (disabled state keeps the shadow — elevation, not color, should separate the layer).

### [P3] — Stale drawings render on an empty error-state chart
- **What/Why:** State Coverage + DataViz. In the screenshot the chart has zero candles (credentials error) yet still paints a vertical rule and a freehand path from the drawings layer — floating marks with no data to anchor to, one of which lands on the SELL button. Drawings persisting across a symbol/data outage without an "anchored to nothing" treatment reads as a rendering bug.
- **Location:** rendered via `apps/desktop/src/features/trade/TradeScreen.tsx:190-195` → `CandleChart`/`DrawingLayer`; error state at `apps/desktop/src/features/chart/ChartView.tsx:241`
- **Exact fix:** In `ChartView`, gate the drawing layer on data: `{candles.length > 0 ? <DrawingLayer … /> : null}` (or pass `isEmpty` into `CandleChart` to suppress `DrawingLayer` when `candles.length === 0`).

### [P3] — Inline-style token bypasses concentrate in this screen
- **What/Why:** Consistency. The fullscreen cluster is styled by ad-hoc inline objects — root container (TradeScreen.tsx:168), layout wrapper (L189), overlay stack (L196-205), button row (FloatingTradeButtons.tsx:12), chip style object (PositionsStrip.tsx:17-24) — duplicating geometry that has no token home (`--pad-screen: 24px` exists at tokens.css:63 but is unused here; insets are 12/20). Every future spacing change becomes a multi-file grep.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:168,189,196-205`, `apps/desktop/src/features/trade/FloatingTradeButtons.tsx:12`
- **Exact fix:** Add to `components.css` and use the classes:
  ```css
  .trade-overlay { position: absolute; left: 0; right: 0; bottom: 16px; display: flex; flex-direction: column; gap: 8px; }
  .floating-trade-buttons { display: flex; gap: 16px; padding: 0 20px; }
  ```
  Replace the inline objects at the cited lines with `className="trade-overlay"` / `className="floating-trade-buttons"`.

## Quick wins vs structural work

**Landable in <1 hour:**
- Darker button fills `--buy-green-button`/`--sell-red-button` (contrast fix)
- Opaque disabled state via `color-mix` instead of `opacity: 0.35`
- 44px navbar hit areas + hover/focus-visible CSS block
- `fontFamily: 'var(--font-mono)'` on the two PositionsStrip price spans
- Grid fixes: `bottom:16`, `gap:8`, unify strip/buttons padding at 20px
- `aria-pressed` + dynamic label on the layout toggle; unify icon sizes at 22
- `box-shadow` on `.trade-action-button`; `prefers-reduced-motion` media query

**Needs refactor / plumbing:**
- Actionable chart error state (new `onOpenProfile` prop threaded ChartView ← TradeScreen, or a shared "open profile" event)
- Disabled-reason caption (derive reason from chart/trade/chain stores, pass through FloatingTradeButtons, keep in sync with `canTrade` gate)
- Sheet exit animations (closing state + `onAnimationEnd` in the shared `Sheet` component, all five call sites)
- Suppressing the drawing layer on empty/error charts (touches CandleChart/DrawingLayer data flow)
- Extracting the inline-style cluster into CSS classes with real spacing tokens (tokens.css has no spacing scale today — add `--space-1..6` first)
