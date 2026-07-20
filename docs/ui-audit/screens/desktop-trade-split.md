# Screen d6: Trade screen — Layout B (split) + draggable divider

- **App:** Desktop
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx` (split branch L211–263; divider L222–258; split math L154–155); `apps/desktop/src/core/storage/SettingsStore.ts:25-34`; parity ref `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:174-250`
- **Visual:** screenshot `docs/ui-audit/shots/05-trade-split.png` (860×1864 = 430×932 @2x, verified against code: divider band at y≈0.663 → panelFraction ≈ 0.35 ≈ stored default 0.34 ✓)
- **Scores:** Composition 7/10 · Typography 7/10 · Color 5/10 · Density 7/10 · DataViz 6/10 · Motion 4/10 · States 5/10 · Platform 6/10 · A11y 3/10 · Consistency 5/10 → **Overall 55/100**
- **Score justifications:**
  - Composition 7 — chart:panel ≈ 507:270 = 1.88:1 vs golden 1.618:1 (default fraction 0.34); divider band is a clean full-width seam but 18px tall, off the 8pt grid.
  - Typography 7 — split branch itself renders no text; panel content inherits token fonts (`--fs-footnote`/`--fs-headline`); screenshot shows consistent sizing, no tabular-figure violations visible in this branch.
  - Color 5 — divider grabber `--app-border` rgba(84,84,88,0.65) on `--app-surface` #1a1c24 resolves to ≈ #404044 on #1a1c24 → contrast ≈ 1.55:1, needs ≥3:1 for a UI control affordance; only interactive hint in the seam is nearly invisible.
  - Density 7 — panel packs 6 control rows into ~270px without crowding (screenshot), but the chart's 64% of viewport is fully dead in the error state with one small centered line of text.
  - DataViz 6 — this branch only frames the chart; in the verified screenshot the chart region shows zero skeleton/axis/chrome in the credentials-error state, just a bare y-axis line and the TradingView logo.
  - Motion 4 — layout toggle and split resize snap instantly (no transition anywhere in L211–263); divider has no hover/active feedback; only the `ns-resize` cursor is correct.
  - States 5 — clamps (0.25–0.5, min 120/100) and persistence work; but no loading skeleton for the split panes, and the dominant error state is a non-actionable dead-end.
  - Platform 6 — pointer capture + frame-scale correction (L237–240) and `touchAction:'none'` are genuinely good desktop work; missing hover style, focus ring, and keyboard operation.
  - A11y 3 — `aria-label` on a plain `<div>` (L234) is a no-op: no `role`, no `tabIndex`, no `aria-valuenow`, no keyboard control — the splitter is invisible to AT and keyboard users.
  - Consistency 5 — entire split branch is inline `style={{}}` (L212–263) bypassing the CSS-class/token system used by `NavBar` et al.; magic numbers 18/48/5/2.5/120/100/0.25/0.5 (values do match iOS 1:1 — parity good, tokenization bad).

## Findings

### [P1] — Divider is keyboard-inaccessible and semantically empty

- **What/Why:** The splitter is a `<div>` with `aria-label` but no `role`, no `tabIndex`, no value attributes, and pointer-only handlers (Accessibility, Platform Fidelity). Screen readers announce nothing (aria-label on a role-less div is ignored), and keyboard users cannot resize the panel at all — a core layout feature of Layout B is unreachable. WCAG 4.1.2 (Name/Role/Value) violation.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:223-254`
- **Exact fix:** Replace the divider opening tag and add a key handler:
  ```tsx
  <div
    role="separator"
    aria-orientation="horizontal"
    aria-label="Resize trade panel"
    aria-valuenow={Math.round(splitFraction * 100)}
    aria-valuemin={25}
    aria-valuemax={50}
    tabIndex={0}
    style={{ /* unchanged */ }}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 0.05 : 0.01;
      let next: number | null = null;
      if (event.key === 'ArrowUp') next = Math.min(0.5, splitFraction + step);
      if (event.key === 'ArrowDown') next = Math.max(0.25, splitFraction - step);
      if (next !== null) {
        event.preventDefault();
        setSplitFraction(next);
        settingsStore.splitFraction = next;
      }
    }}
    onPointerDown={/* unchanged */}
  ```

### [P1] — Grabber handle contrast ≈1.55:1, fails 3:1 UI-component minimum

- **What/Why:** `--app-border` rgba(84,84,88,0.65) composited over `--app-surface` #1a1c24 yields ≈ rgb(64,64,68) on rgb(26,28,36): relative luminance 0.048 vs 0.013 → 1.55:1 (Color & Contrast). The grabber is the _only_ visual affordance for the drag control; in the screenshot it is barely perceptible. WCAG 1.4.11 requires ≥3:1 for UI components.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:255-257`
- **Exact fix:**
  ```tsx
  <div style={{ width: 48, height: 5, borderRadius: 2.5, background: 'var(--label-secondary)' }} />
  ```
  `--label-secondary` rgba(235,235,245,0.6) over `--app-surface` ≈ rgb(152,152,153) → ≈ 4.7:1 on #1a1c24. (Note: iOS `TradeScreenView.swift:226-228` has the identical defect with `Color.appBorder` — fix both to keep parity.)

### [P1] — No hover or active-drag feedback on the divider (desktop pointer platform)

- **What/Why:** The only desktop affordance is `cursor: 'ns-resize'` (Motion & Micro-interactions, Platform Fidelity). A 430px-wide, 18px-tall interactive strip gives zero visual response on hover or while dragging — Robinhood/TradingView bars always light up the active splitter.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:223-258`
- **Exact fix:** Extract the inline styles to a class so pseudo-states are possible. In `apps/desktop/src/design/components/components.css` add:
  ```css
  /* --- Split-layout divider (Layout B) --- */
  .split-divider {
    height: 18px;
    flex: none;
    background: var(--app-surface);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: ns-resize;
    touch-action: none;
  }
  .split-divider .grabber {
    width: 48px;
    height: 5px;
    border-radius: 2.5px;
    background: var(--label-secondary);
    transition: background 150ms ease-out;
  }
  .split-divider:hover .grabber,
  .split-divider.dragging .grabber,
  .split-divider:focus-visible .grabber {
    background: var(--label-primary);
  }
  .split-divider:focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: -2px;
  }
  ```
  In `TradeScreen.tsx` use `<div className="split-divider">` + `<div className="grabber" />`, and toggle a `dragging` class from `dragRef.current !== null` state.

### [P2] — Layout toggle and resize snap with zero motion

- **What/Why:** Switching Layout A↔B and every drag tick jump heights instantly (Motion & Micro-interactions). The app already defines `--sheet-anim: 300ms cubic-bezier(0.32,0.72,0,1)` in `tokens.css:64` but the split branch uses no transition; target is 120–250ms eased. No `prefers-reduced-motion` handling anywhere in the branch.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:213` (chart wrapper), `:260` (panel wrapper)
- **Exact fix:** Track dragging in state (`const [dragging, setDragging] = useState(false)`, set true in `onPointerDown`, false in `onPointerUp`/`onPointerCancel`), then on both pane wrappers:
  ```tsx
  style={{
    height: chartHeight, flex: 'none', display: 'flex', flexDirection: 'column',
    transition: dragging ? 'none' : 'height 200ms cubic-bezier(0.32, 0.72, 0, 1)',
  }}
  ```
  and in `components.css`: `@media (prefers-reduced-motion: reduce) { .split-divider .grabber { transition: none; } }` plus a global rule disabling the height transition under the same media query.

### [P2] — Split branch is 100% inline styles + 8 magic numbers, several off the 8pt grid

- **What/Why:** `DIVIDER_HEIGHT = 18` (L20), grabber 48×5 radius 2.5 (L256), clamps 0.25/0.5 (L246), mins 120/100 (L154–155) — none tokenized, all inline (Consistency). 18px, 5px, 2.5px, and 100px all break the 8pt/4pt grid (should be 16 or 20; 4 or 6; 2; 96 or 104). The rest of the design system lives in `tokens.css` + `components.css`; this branch bypasses both.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:20,154-155,212-263`
- **Exact fix:** Move layout values into tokens (`apps/desktop/src/design/tokens.css`, Geometry section after L63):
  ```css
  --h-divider: 20px;
  --divider-grabber-w: 48px;
  --divider-grabber-h: 4px;
  ```
  use the `.split-divider` class from the P1 fix above (`height: var(--h-divider)`), change `DIVIDER_HEIGHT` to read 20 (grid-correct), grabber to 48×4 radius 2, and chart min from 100 → 96: `Math.max(contentHeight - panelHeight - DIVIDER_HEIGHT, 96)`. Mirror the same token values in iOS `TradeScreenView.swift:223,226-228` to preserve parity.

### [P2] — Chart error state is a dead-end occupying 64% of the screen

- **What/Why:** Verified screenshot: the split layout's dominant pane shows only "No Webull credentials on file — save app key/secret in Profile first" as centered secondary text — no button, no link, no skeleton (State Coverage). `TradeScreen` already owns the Profile sheet (`showProfile`, L39, opened at L172–174, rendered L288–290) but the split branch (L214–219) wires no recovery action into the chart region.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:214-219` (+ error view inside `ChartView`, outside this unit)
- **Exact fix:** Add an action prop to `ChartView` and pass it here:
  ```tsx
  <ChartView
    store={chartStore}
    drawingsStore={drawingsStore}
    onSymbolSearch={() => setShowSymbolSearch(true)}
    onIndicatorSettings={() => setShowIndicatorSettings(true)}
    onOpenProfile={() => setShowProfile(true)}
  />
  ```
  and in ChartView's error branch render under the message: `<button className="navbar-text-button" onClick={onOpenProfile}>Open Profile</button>` (accent `#568ff7`, 17px, ≥44px hit area). Same treatment in iOS `ChartView` error state.

### [P2] — Unthrottled `setSplitFraction` on every pointermove re-renders the whole screen

- **What/Why:** `onPointerMove` (L242–247) sets React state per event → full `TradeScreen` re-render including `ChartView` and `TradePanel` subtrees at pointer-event frequency (can exceed 120Hz), each triggering chart resize layout (Motion/performance). TradingView-class apps throttle splitter updates to rAF.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:242-247`
- **Exact fix:**
  ```tsx
  const rafRef = useRef(0);
  // inside onPointerMove, replace the setSplitFraction line with:
  const fraction = Math.min(0.5, Math.max(0.25, drag.startFraction + delta));
  cancelAnimationFrame(rafRef.current);
  rafRef.current = requestAnimationFrame(() => setSplitFraction(fraction));
  ```

### [P3] — Default split 0.34 misses golden-ratio proportion

- **What/Why:** Default `splitFraction` 0.34 over a ~795px content area → panel 270px, chart 507px → chart:panel = 1.88:1; golden ratio 1.618:1 is hit at fraction 0.382 (panel 304px). Measurable composition gap against the stated design bar; 0.382 sits comfortably inside the PRD's 0.25–0.5 clamp.
- **Location:** `apps/desktop/src/core/storage/SettingsStore.ts:28`
- **Exact fix:** `if (!Number.isFinite(stored) || stored <= 0) return 0.38;` (and the same default in `apps/ios/0dteTrader/Core/Storage/SettingsStore.swift:41-46`).

### [P3] — `onPointerCancel` unhandled: interrupted drags leak drag state and never persist

- **What/Why:** If the pointer is cancelled (OS gesture, touch cancel), `dragRef.current` stays non-null and the user's resize is silently discarded without writing `settingsStore.splitFraction` (State Coverage edge).
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:248-253`
- **Exact fix:** Extract the up-handler and reuse: `const endDrag = () => { if (dragRef.current) { dragRef.current = null; settingsStore.splitFraction = splitFraction; } };` then `onPointerUp={endDrag} onPointerCancel={endDrag}`.

### [P3] — NavBar icon sizes inconsistent: 22 vs 20

- **What/Why:** `PersonCircleIcon size={22}` (L173) vs `ClockIcon size={20}` (L176) and layout icons `size={20}` (L182) — visible in the screenshot as a slightly larger leading profile glyph; one-off value breaks the icon-size rhythm (Consistency).
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:173`
- **Exact fix:** `<PersonCircleIcon size={20} />`.

## Quick wins vs structural work

**<1 hour:**

- Grabber color → `var(--label-secondary)` (P1, one line at L256).
- `role="separator"` + `tabIndex` + `aria-valuenow` + ArrowUp/Down keyboard handler (P1, ~20 lines at L223–254).
- `onPointerCancel={endDrag}` (P3, L248–253).
- PersonCircleIcon 22 → 20 (P3, L173).
- Default fraction 0.34 → 0.38 (P3, `SettingsStore.ts:28`).
- Height transition gated on `dragging` state (P2, L213/L260).

**Structural:**

- Extract divider to `.split-divider`/`.grabber` classes in `components.css` with hover/focus/dragging states + `--h-divider`/`--divider-grabber-*` tokens, mirrored into iOS `TradeScreenView.swift` for parity (P1 hover + P2 tokenization + grid correction 18→20).
- Actionable chart error CTA — requires a new `onOpenProfile` prop through `ChartView` and a matching iOS change (P2).
- rAF-throttled drag updates (P2) — touches the drag ref plumbing and should be verified against the frame-scale correction math.
