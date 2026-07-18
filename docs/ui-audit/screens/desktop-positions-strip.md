# Screen d8: Positions/Orders Strip
- **App:** Desktop
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx` (whole file, 141 lines; chipStyle :17-24, positions row :39-75, orders row :77-106, dialogs :108-138); tokens `apps/desktop/src/design/tokens.css`; base styles `apps/desktop/src/design/base.css`; iOS parity source `apps/ios/0dteTrader/Features/Trade/PositionsStripView.swift`
- **Visual:** UNVERIFIED-VISUAL — captured account had no positions/orders, so only the collapsed (zero-height) strip was visible. Populated states reconstructed from code: frame 430px wide; row content width 406px (430 − 2×12px padding, :42/:80); chip ≈ 132px wide × ≈ 60px tall (padding 7px top/bottom + 12px symbol line + 2px gap + 11px qty line + 2px gap + 12px P&L line, :18/:51-70) → ~3.0 chips visible, 4th chip scrolls with **no visual affordance** (scrollbar hidden via `.hide-scrollbar`, base.css:84).
- **Scores:** Composition 6/10 · Typography 5/10 · Color 7/10 · Density 7/10 · DataViz 5/10 · Motion 3/10 · States 5/10 · Platform 3/10 · A11y 4/10 · Consistency 5/10 → **Overall 50/100**
- **Score justifications:**
  - Composition 6 — 8px inter-chip gap + 12px side padding are on-grid (:42), but 7px chip padding, 2px inner gaps and 6px row gap (:18/:38/:51) break the 8pt grid, and position chips (~60px) vs order chips (~40px) are vertically unmatched siblings.
  - Typography 5 — correct caption/caption2 scale and 600-weight hierarchy (:53/:63), but all prices/P&L render in proportional sans with no `tabular-nums`, so ticking P&L jitters horizontally — violating the project's own documented rule (AppTypography.swift:3-4, "Prices use monospaced digits so ticking quotes don't shift layout").
  - Color 7 — semantic P&L tokens used correctly and measured AA-pass on the surface: `--pnl-positive` #30d158 ≈ 8.4:1, `--pnl-negative` #ff453a ≈ 4.9:1 on #1a1c24 (:65-66); secondary text rgba(235,235,245,.6) ≈ 5.9:1 ✓; +/- signs give color-independent meaning; only the hairline border is near-invisible (~1.2:1).
  - Density 7 — good 3-tier chip hierarchy (symbol semibold → secondary qty@avg → colored P&L), ~60px tall chip is appropriately dense for a strip; order chip keeps cancel action inline without crowding.
  - DataViz 5 — no charts here, but no skeletons for loading, no scroll-edge fade, and an 11px unlabeled spinner as the only live-state indicator (:56).
  - Motion 3 — zero transitions: no hover, no press/active state, no focus ring; the strip appears/disappears instantly, shifting the entire trade panel layout; spinner spins with no `prefers-reduced-motion` handling (grep: zero occurrences in `apps/desktop/src`).
  - States 5 — destructive actions are gated by well-labeled confirmation dialogs (:108-138) and working symbols get a spinner (:56), but no loading skeleton, no error state, and empty = silent collapse with layout jump.
  - Platform 3 — desktop fundamentals missing: no `:hover`, no `:focus-visible` anywhere in the codebase, 17×17px cancel target (:101), no Escape/backdrop-dismiss on dialogs, "tap to flatten" copy (:49).
  - A11y 4 — `aria-label`s present on both buttons (:49/:99) which is above average, but invisible keyboard focus, sub-24px hit target, unlabeled spinner, non-`aria-hidden` SVG icons, no reduced-motion.
  - Consistency 5 — near-verbatim iOS parity (verified against PositionsStripView.swift) and token-based colors/fonts, but the whole component is inline `style={{}}` (shared `chipStyle` object :17), uses `--radius-card` (10px) where a `--radius-chip` (8px) token exists (tokens.css:58), and magic numbers 7/2/6/11/17/0.5px throughout.

## Findings

### [P1] — No hover, focus-visible, or press state on any interactive chip
- **What/Why:** The position chip is a `<button>` (:45) and the cancel control is a `<button>` (:95), but there is no `:hover`, `:active`, or `:focus-visible` styling for them — a codebase-wide grep for `focus-visible` in `apps/desktop/src` returns zero hits. On a desktop Electron app this means keyboard users cannot see focus at all (WCAG 2.4.7 failure) and mouse users get zero tactile feedback — dead-feeling UI, the opposite of the Robinhood fluid-motion bar. Violates Motion and Platform Fidelity.
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx:45-50,95-102`; reset at `apps/desktop/src/design/base.css:58-65`
- **Exact fix:** Move chips to a real class and add states. In `apps/desktop/src/design/components/components.css` append:
  ```css
  .pos-chip { transition: transform 120ms cubic-bezier(0.32, 0.72, 0, 1), background 120ms ease; }
  .pos-chip:hover { background: var(--app-surface-elevated); }
  .pos-chip:active { transform: scale(0.97); }
  .pos-chip:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 2px; }
  ```
  In PositionsStrip.tsx:17-24 replace `chipStyle` usage with `className="pos-chip"` on both chips (keep the layout props in the class), and add `className="pos-chip"` (or a `.pos-chip-icon` variant with `:hover { color: var(--label-primary); }`) to the cancel button at :95.

### [P1] — Prices and P&L not tabular: ticking values jitter chip width
- **What/Why:** `Format.signedPrice(position.unrealizedPnl)` (:69) and the qty@avg line (:59) render in `system-ui` proportional figures. `unrealizedPnl` ticks live; glyph widths differ (e.g. "1" ≈ 5.6px vs "0" ≈ 7.3px at 12px), so every tick shifts the P&L width and, since chips are content-sized, resizes the chip and reflows the row — visible jitter on the most important number. The project's own typography contract (AppTypography.swift:3-4) mandates monospaced digits for exactly this reason; the only `tabular-nums` usage in the entire desktop app is the chart axis (ChartView.tsx:162,172). Violates Typography.
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx:58-70`
- **Exact fix:** Add `fontVariantNumeric: 'tabular-nums'` to both numeric spans:
  - :58 — `<span className="text-secondary" style={{ fontSize: 'var(--fs-caption2)', fontVariantNumeric: 'tabular-nums' }}>`
  - :62-68 — add `fontVariantNumeric: 'tabular-nums'` to the P&L span's style object.
  - Also :88-93 order-chip lines are static text, but add it there too for alignment consistency.

### [P1] — Cancel-order button is a 17×17px hit target
- **What/Why:** The cancel button wraps only `<XCircleFillIcon size={17} />` with `style={{ display: 'flex' }}` (:95-102) — no padding, so the clickable area is exactly 17×17px. WCAG 2.5.8 (AA) requires ≥24×24px; the iOS 44pt convention the rest of the app follows (alert buttons are 44px, components.css:185) suggests 44px. This is the single most dangerous control on the screen (cancels a live order) and it has the smallest target. Violates A11y and Platform Fidelity.
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx:95-102`
- **Exact fix:** Give the button padding so the target is ≥32px while keeping the 17px glyph:
  ```tsx
  <button
    className="text-secondary"
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '-4px -6px', padding: '4px 6px', minWidth: 29, minHeight: 25 }}
    onClick={() => setOrderPendingCancel(order)}
    aria-label="Cancel order"
  >
  ```
  (negative margin keeps chip outer padding at 7/10px; net target ≈ 29×25px). Better: `padding: 8` with `margin: -8px -8px -8px 0` for a 33×33px target.

### [P1] — Infinite spinner animation ignores prefers-reduced-motion
- **What/Why:** The working-symbol spinner (:56) uses `animation: spinner-rotate 0.8s linear infinite` (components.css:106) and there is not one `prefers-reduced-motion` media query in the desktop codebase. A perpetually rotating element next to every working order is exactly the class of motion vestibular-disorder users must be able to disable (WCAG 2.3.3 / 2.2.2). Violates Motion and A11y.
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx:56`; `apps/desktop/src/design/components/components.css:101-107`
- **Exact fix:** In `components.css` after the `.spinner.white` block (:109-112) add:
  ```css
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; border-top-color: rgba(235, 235, 245, 0.25); border-right-color: var(--label-secondary); }
    .pos-chip { transition: none; }
  }
  ```
  (static quarter-ring still reads as "pending" without motion).

### [P2] — Strip appears/disappears with no transition, shifting the whole trade panel
- **What/Why:** Both rows render conditionally (`positions.length > 0 ? ... : null`, :39/:77). When the first position opens or the last one closes, the strip's ~60px height materializes/vanishes in one frame inside `TradePanel`'s flex column (TradePanel.tsx:58-68), and in TradeScreen the chart/panel split (`chartHeight`/`panelHeight`, TradeScreen.tsx:154-155) recomputes instantly — the entire screen jumps. Robinhood-grade polish requires animating this. Violates Motion and State Coverage.
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx:38-42,77-81`
- **Exact fix:** Always render the wrapper and animate height/opacity. Replace :37-39 with:
  ```tsx
  const visible = positions.length > 0 || openOrders.length > 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflow: 'hidden', maxHeight: visible ? 140 : 0, opacity: visible ? 1 : 0, transition: 'max-height 200ms cubic-bezier(0.32, 0.72, 0, 1), opacity 150ms ease' }}>
  ```
  (140px = two rows ≈ 60+6+40 + margin; reuse the existing `--sheet-anim` curve for consistency.)

### [P2] — Horizontally scrolling rows have no scroll affordance
- **What/Why:** Rows use `overflowX: 'auto'` + `.hide-scrollbar` (:41/:79), hiding the scrollbar with no replacement cue. From the reconstruction, ~3 position chips fill the 406px content width, so a user with 4+ positions has no way to discover the 4th except by accidentally scrolling. TradingView-density rule: hidden content needs an edge cue. Violates Information Density/DataViz.
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx:40-43,78-81`
- **Exact fix:** Add a right-edge fade mask to both row divs:
  ```tsx
  style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '0 12px',
    WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 24px), transparent)',
    maskImage: 'linear-gradient(to right, #000 calc(100% - 24px), transparent)' }}
  ```
  (iOS parity: PositionsStripView.swift:18 has the same gap — file a matching iOS fix.)

### [P2] — Confirmation dialogs are inaccessible: no role, no aria-modal, no Escape
- **What/Why:** `AlertDialog` (used at :108-138 for both destructive confirmations) renders plain `<div>`s with no `role="dialog"`, `aria-modal`, `aria-labelledby`, no focus trap, no initial focus on the cancel button, and no Escape-to-dismiss — a screen-reader user gets no announcement that a modal opened, and a keyboard user must Tab blindly through background content. On desktop, Escape-cancel is table stakes for a confirm dialog. Violates A11y and Platform Fidelity.
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx:108-138`; `apps/desktop/src/design/components/AlertDialog.tsx:17-34`
- **Exact fix:** In `AlertDialog.tsx`: add `role="dialog" aria-modal="true" aria-label={title}` to `.alert-card`; add `autoFocus` to the cancel-role button (`autoFocus={action.role === 'cancel'}` — iOS convention puts focus on the safe action); add a keydown effect:
  ```tsx
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);
  ```

### [P2] — Working-order spinner is invisible to assistive tech
- **What/Why:** `<Spinner size={11} />` (:56) renders `<span className="spinner">` (Spinner.tsx:7) with no `role="status"` or label, and the chip's `aria-label` (:49) says only "Position MNQ, tap to flatten" — a VoiceOver/NVDA user never learns an order is working against this position. Violates A11y and State Coverage.
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx:49,56`
- **Exact fix:** Change :49 to
  ```tsx
  aria-label={`Position ${position.symbol}${workingSymbols.includes(position.symbol) ? ', order working' : ''}, activate to flatten`}
  ```
  and in `Spinner.tsx:7` add `role="status" aria-label="Loading"` to the span.

### [P2] — Off-grid spacing: 7px, 6px, 2px values break the 8pt rhythm
- **What/Why:** Chip padding `7px 10px` (:18), wrapper `gap: 6` (:38) and inner `gap: 2` (:51/:87) are not multiples of 4. Individually invisible, but stacked they make chip height ≈ 60px (vs 64px on-grid) and row separation 6px (vs 8px), so the strip lands fractionally misaligned with the 4px/8px cadence the rest of the panel uses (TradePanel.tsx:62 uses gap 8). Violates Composition and Consistency. (Same values exist on iOS, PositionsStripView.swift:16,71,87 — this is a cross-platform design-token gap: no spacing tokens exist at all.)
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx:18,38,51,87`
- **Exact fix:** `padding: '8px 12px'` (:18), wrapper `gap: 8` (:38), inner `gap: 2` → keep 2px only as intra-label leading or bump to `gap: 4` (:51/:87). Reconstructed chip height becomes 64px — exactly 8×8.

### [P3] — "tap to flatten" is the wrong verb on a mouse/keyboard platform
- **What/Why:** `aria-label={`Position ${position.symbol}, tap to flatten`}` (:49) is iOS copy cloned verbatim; desktop assistive tech announces "tap". Violates Platform Fidelity.
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx:49`
- **Exact fix:** `aria-label={`Position ${position.symbol}, activate to flatten`}` (see P2-spinner fix for the combined string).

### [P3] — `--radius-chip` token exists but chips use `--radius-card`; chip style is a one-off inline object
- **What/Why:** `borderRadius: 'var(--radius-card)'` (10px, :20) while tokens.css:58 defines `--radius-chip: 8px`, which TradePanel uses for its menu chip (TradePanel.tsx:147). Two different chip radii on the same panel. Also the entire component bypasses `components.css` with a module-level `chipStyle` object (:17-24) — exactly the inline-style pattern the audit brief flags; there is no reusable `.chip` class even though two chip variants share the spread `{...chipStyle, ...}` (:85).
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx:17-24,85`; `apps/desktop/src/design/tokens.css:58-59`
- **Exact fix:** Create `.pos-chip` in `components.css` (see P1-focus fix) with `border-radius: var(--radius-chip); padding: 8px 12px; background: var(--app-surface); border: 0.5px solid var(--app-border);` and delete the `chipStyle` object; update both usages (:47,:85).

### [P3] — P&L shown without currency: "+125.00" is ambiguous (dollars vs points)
- **What/Why:** `Format.signedPrice(unrealizedPnl)` yields `+125.00` (:69, format.ts:8-11). On a futures desk, P&L is in dollars while the line above it (`@ 21450.25`) is in points — identical formatting for two different units on adjacent lines invites misreads at 0DTE speed. Violates Information Density.
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx:69`; `apps/desktop/src/design/format.ts:8-11`
- **Exact fix:** Add a currency variant in `format.ts`:
  ```ts
  signedCurrency(value: number): string {
    const text = Math.abs(value).toFixed(2);
    return value < 0 ? `-$${text}` : `+$${text}`;
  }
  ```
  and use `Format.signedCurrency(position.unrealizedPnl)` at :69. (Match in iOS Formatters.swift for parity.)

### [P3] — 0.5px hairline border at ~1.2:1 contrast, and it blurs under the app scale transform
- **What/Why:** `border: '0.5px solid color-mix(in srgb, var(--app-border) 50%, transparent)'` (:21) computes to ≈ rgba(84,84,88,0.33) on #1a1c24 — roughly 1.2:1, effectively invisible, so chips visually float without separation from the panel background that shares `--app-background`. Worse, the whole app is scaled with `transform: scale(var(--app-scale))` (base.css:33), so at non-integer scales a 0.5px hairline anti-aliases into mush. Violates Color (3:1 UI-boundary guideline) and polish.
- **Location:** `apps/desktop/src/features/trade/PositionsStrip.tsx:21`; `apps/desktop/src/design/base.css:29-35`
- **Exact fix:** Use a full-strength 1px token border: `border: '1px solid var(--app-border)'` (≈2.3:1, clearly visible) — or if the hairline look is kept for iOS parity, at minimum use full `--app-border` alpha instead of the 50% mix.

### [P3] — SVG icons are not aria-hidden
- **What/Why:** `svgProps` (icons.tsx:9-20) sets no `aria-hidden`/`role`, so `XCircleFillIcon` (:101) may be exposed as a stray graphic inside a button that already has `aria-label="Cancel order"` — redundant noise in the a11y tree. Violates A11y (minor).
- **Location:** `apps/desktop/src/design/icons.tsx:9-20`; usage `PositionsStrip.tsx:101`
- **Exact fix:** Add `aria-hidden: true` to the object returned by `svgProps` in `icons.tsx:10-20` (one-line, fixes every icon app-wide).

## Quick wins vs structural work

**Quick wins (<1 hour each):**
- P1 tabular-nums on the two numeric spans (two-line edit).
- P1 hover/focus/active `.pos-chip` CSS block + className swap.
- P1 cancel-button padding for ≥24px target.
- P1 `prefers-reduced-motion` media query for `.spinner`.
- P3 "tap" → "activate" aria-label; P3 `aria-hidden` in `svgProps`; P3 currency P&L formatter; P3 border alpha fix.
- P2 scroll-edge mask-image fade.
- P2 AlertDialog `role="dialog"`/`autoFocus`/Escape handler (one component, fixes all callers).
- P2 spinner `role="status"` + "order working" aria-label.

**Structural work:**
- P1/P2 spacing tokens: no spacing/radius/motion token system exists (values inlined in every feature); introducing `--space-1..--space-6` and migrating chips is a cross-app (desktop + iOS DesignSystem) effort.
- P2 animated show/hide of the strip: needs care with TradeScreen's split-height math (TradeScreen.tsx:154-155) so chart resize and strip animation don't fight; likely wants a layout-animation pass across the panel.
- P2/P3 iOS parity fixes (same off-grid values, same missing scroll cue in PositionsStripView.swift) should be designed once and applied to both platforms together.
