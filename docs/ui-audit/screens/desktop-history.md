# Screen d10: Trade history sheet
- **App:** Desktop
- **Location:** `apps/desktop/src/features/trade/HistoryView.tsx` (whole file, 194 lines); supporting: `apps/desktop/src/design/components/Sheet.tsx:24-29`, `apps/desktop/src/design/components/components.css:89-149`, `apps/desktop/src/design/tokens.css:3-66`, iOS parity ref `apps/ios/0dteTrader/Features/Trade/HistoryView.swift`
- **Visual:** screenshot `docs/ui-audit/shots/10-history.png` (empty state, verified)
- **Scores:** Composition 6/10 · Typography 7/10 · Color 8/10 · Density 6/10 · DataViz 4/10 · Motion 6/10 · States 4/10 · Platform 5/10 · A11y 5/10 · Consistency 5/10 → **Overall 56/100**
- **Score justifications:**
  - Composition 6 — 16px side margins align with `.navbar` padding and header row is `alignItems: baseline` (HistoryView.tsx:92), but the empty state pins content to the top leaving ~78% of the 922px sheet dead, and row padding `10px` (HistoryView.tsx:127) breaks the 8pt grid.
  - Typography 7 — P&L values correctly use `--font-mono` at `--fs-title3`/600 (HistoryView.tsx:101-104) on the modular scale, but error/empty copy inherits 17px body where iOS uses 15px subheadline, and detail rows run at 12px `--fs-caption`.
  - Color 8 — semantic tokens throughout (`--pnl-positive/negative`, `--label-secondary`); measured contrasts pass AA (green #30d158 ≈ 9.3:1, red #ff453a ≈ 5.5:1, secondary ≈ 6:1 on #0b0c10); docked for zero P/L rendered positive-green.
  - Density 6 — header separates primary value (20px mono) from secondary label (15px secondary) well, but a flat ungrouped list and an empty state that fills 2% of the viewport waste the sheet.
  - DataViz 4 — no chart on this screen (acceptable), but the loading state is a bare 18px spinner, not a skeleton, so the async-content bar is unmet.
  - Motion 6 — sheet entrance uses the shared `--sheet-anim` token (300ms cubic-bezier(0.32,0.72,0,1), components.css:130) which is correctly iOS-like; no `prefers-reduced-motion` handling and no press/hover states anywhere.
  - States 4 — loading = top-pinned spinner, error = dead text with no retry, empty = one line of copy, no offline distinction; three of four states are undesigned.
  - Platform 5 — Escape + backdrop-click dismiss work (Sheet.tsx:16-26), but no `role="dialog"`/`aria-modal`, no focus trap or initial focus, and the Done button's click target is text-sized (~44×20px).
  - A11y 5 — P/L meaning is not color-only (explicit +/- via `Format.signedPrice`, format.ts:8-11) and status is a text label, but async content has no `aria-live`, the dialog has no accessible name, and hit areas are sub-44px.
  - Consistency 5 — ~13 inline `style={{}}` objects with magic values (24/16/12/10/8/2) bypass `tokens.css`/component classes entirely; zero reusable classes for a screen that repeats one row component.

## Findings

### [P1] — Zero net P/L rendered in positive green
- **What/Why:** When there are no trades, `totalRealizedPnl` is `0` and `history.totalRealizedPnl >= 0` paints `+0.00` in `--pnl-positive` (#30d158) directly above "No orders yet." (confirmed in the screenshot). A neutral zero masquerading as a win violates truthful P/L semantics (Color & Contrast: meaning must be accurate, not just legible) and reads as a bug to a trader.
- **Location:** `apps/desktop/src/features/trade/HistoryView.tsx:105-108`
- **Exact fix:**
  ```tsx
  color:
    history.totalRealizedPnl === 0
      ? 'var(--label-primary)'
      : history.totalRealizedPnl > 0
        ? 'var(--pnl-positive)'
        : 'var(--pnl-negative)',
  ```

### [P1] — Error state is dead text with no recovery path
- **What/Why:** A failed `orderHistory()` fetch renders `{error}` as centered secondary text (HistoryView.tsx:80-84). No retry, no icon, no offline distinction — violates State Coverage ("actionable errors"). The user must dismiss and reopen the sheet to retry.
- **Location:** `apps/desktop/src/features/trade/HistoryView.tsx:39-52, 80-84`
- **Exact fix:** Extract the fetch into a callable `load()` and render a retry affordance:
  ```tsx
  const [loadKey, setLoadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    apiClient.orderHistory()
      .then((result) => { if (!cancelled) setHistory(result); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); });
    return () => { cancelled = true; };
  }, [apiClient, loadKey]);
  // ...
  {error !== null ? (
    <div className="text-secondary" style={{ padding: 24, textAlign: 'center' }}>
      <div>{error}</div>
      <button
        className="navbar-text-button"
        style={{ marginTop: 12, fontWeight: 600 }}
        onClick={() => { setHistory(null); setLoadKey((k) => k + 1); }}
      >
        Try Again
      </button>
    </div>
  ) : null}
  ```

### [P1] — Sheet has no dialog semantics or focus management
- **What/Why:** `Sheet` renders plain `<div>`s (Sheet.tsx:24-29): no `role="dialog"`, no `aria-modal`, no accessible name, focus stays on whatever triggered the sheet, and Tab escapes into the page behind the backdrop. Screen-reader and keyboard users get a visually modal but semantically invisible layer (Accessibility + Platform Fidelity).
- **Location:** `apps/desktop/src/design/components/Sheet.tsx:24-29` (consumed at `HistoryView.tsx:55`)
- **Exact fix:**
  ```tsx
  <div className={`sheet-panel ${detent}`} role="dialog" aria-modal="true" aria-label="History">
    {children}
  </div>
  ```
  Pass the title via a new `label: string` prop on `Sheet` (`<Sheet detent="large" label="History" …>`) instead of hardcoding. Add initial focus in `HistoryView`:
  ```tsx
  const doneRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { doneRef.current?.focus(); }, []);
  // <button ref={doneRef} className="navbar-text-button" onClick={onDismiss}>Done</button>
  ```

### [P1] — Empty state is one line of copy in a 922px-tall sheet
- **What/Why:** `No orders yet.` sits at `padding: 24` directly under the header (HistoryView.tsx:115-118), leaving ~700px (~78% of the sheet) as dead black space — visible in the screenshot where content ends at 22% viewport height. No glyph, no guidance, no CTA. This is the screen's only first-run impression and it is below the Robinhood/Apple bar (State Coverage + Composition: content should occupy the ~38% optical band, not hug the header).
- **Location:** `apps/desktop/src/features/trade/HistoryView.tsx:115-118`
- **Exact fix:**
  ```tsx
  {history.entries.length === 0 ? (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        minHeight: 320,
      }}
    >
      <span style={{ fontSize: 34, lineHeight: 1 }} aria-hidden>🕘</span>
      <span style={{ fontSize: 'var(--fs-headline)', fontWeight: 600 }}>No orders yet</span>
      <span className="text-secondary" style={{ fontSize: 'var(--fs-subheadline)', textAlign: 'center' }}>
        Filled, working, and rejected orders will appear here.
      </span>
    </div>
  ) : (
  ```
  (Replace the emoji with the app's SF-Symbol-equivalent asset — `clock.arrow.circlepath` — if an icon set exists; check `apps/desktop/src/design/components` first.)

### [P2] — Loading state: top-pinned spinner, no skeleton, breaks iOS parity
- **What/Why:** Loading renders an 18px `<Spinner>` at the top with `padding: 24` (HistoryView.tsx:74-78). The iOS source centers `ProgressView` in the full frame (HistoryView.swift:22-23), and the audit bar is skeletons > spinners: the layout jumps from empty to a two-row header + list when data lands.
- **Location:** `apps/desktop/src/features/trade/HistoryView.tsx:74-78`
- **Exact fix:** Minimum (parity): center it —
  ```tsx
  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320 }}>
    <Spinner size={18} />
  </div>
  ```
  Preferred: three skeleton rows matching final row geometry (44px tall, 10px vertical padding, 1px `--app-border` bottom) with a 1200ms shimmer, so first paint ≈ loaded layout.

### [P2] — Entire screen styled inline with magic numbers, bypassing the token system
- **What/Why:** 13 inline `style={{}}` objects (HistoryView.tsx:56-63, 73, 75, 81, 88-95, 97, 100-109, 121-129, 131, 132-140, 144-151, 155-158, 169-180) with literals `24`, `16`, `12`, `10`, `8`, `2` — `tokens.css` has no spacing scale, so every screen invents its own. Consistency criterion: no component reuse, no auditability, values drift (this file uses `10px` row padding; nothing else can).
- **Location:** `apps/desktop/src/features/trade/HistoryView.tsx:56-186`; `apps/desktop/src/design/tokens.css` (no spacing tokens)
- **Exact fix:** Add to `tokens.css`:
  ```css
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;
  --space-4: 16px; --space-6: 24px;
  ```
  and move the row/header/empty styles into `components.css` as `.history-summary`, `.history-row`, `.history-row-title`, `.history-row-detail`, `.history-empty`, then replace inline objects with classNames. Net effect: one place to change the list rhythm.

### [P2] — Net P/L summary scrolls away with the list
- **What/Why:** The "Net realized P/L" header row is inside the scrollable `sheet-body` (HistoryView.tsx:73, 86-113). With more than ~15 orders the running total — the single most important number on the screen — scrolls off. Density/hierarchy: the primary figure must be pinned.
- **Location:** `apps/desktop/src/features/trade/HistoryView.tsx:73, 86-113`
- **Exact fix:** Make the summary sticky:
  ```tsx
  style={{
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    padding: '12px 0',
    borderBottom: '1px solid var(--app-border)',
    position: 'sticky',
    top: 0,
    background: 'var(--app-background)',
    zIndex: 1,
  }}
  ```

### [P2] — `prefers-reduced-motion` ignored
- **What/Why:** `sheet-up` (300ms), `backdrop-in`, and the infinite `spinner-rotate` all run regardless of OS reduced-motion settings (components.css:101-107, 115-130, base.css:123-156). Motion criterion requires a reduced-motion path.
- **Location:** `apps/desktop/src/design/components/components.css:101-107, 119, 130`; `apps/desktop/src/design/base.css:123-156`
- **Exact fix:** Append to `base.css`:
  ```css
  @media (prefers-reduced-motion: reduce) {
    .sheet-panel, .sheet-backdrop, .spinner, .toast {
      animation-duration: 1ms;
      animation-iteration-count: 1;
    }
  }
  ```

### [P2] — "Done" button hit area is text-sized
- **What/Why:** `.navbar-text-button` (components.css:89-92) adds no padding, so the clickable region is ~44×20px — under the 44pt minimum the desktop clone claims to mirror (the navbar itself is 44px tall but the button doesn't fill it). Platform Fidelity + A11y hit-area gap.
- **Location:** `apps/desktop/src/design/components/components.css:89-92`
- **Exact fix:**
  ```css
  .navbar-text-button {
    color: var(--app-accent);
    font-size: var(--fs-body);
    min-height: 44px;
    min-width: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin: 0 -12px 0 0; /* keep visual alignment with 16px navbar padding */
    padding: 0 12px;
  }
  ```

### [P3] — Row metrics off the 8pt grid; trailing hairline under the last row
- **What/Why:** Rows use `gap: 2` and `padding: '10px 0'` (HistoryView.tsx:126-127) — 10px and 2px are off the 4pt base grid (should be 12 / 4). Also every row, including the last, draws `borderBottom` (HistoryView.tsx:128), leaving a dangling hairline at the list end.
- **Location:** `apps/desktop/src/features/trade/HistoryView.tsx:121-129`
- **Exact fix:** `gap: 4`, `padding: '12px 0'`, and drop the border on the final row:
  ```tsx
  style={{
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '12px 0',
    borderBottom: '1px solid var(--app-border)',
  }}
  // in the .map: style.borderBottom omitted when index === history.entries.length - 1,
  // or once extracted to CSS: `.history-row:last-child { border-bottom: none; }`
  ```

### [P3] — Error/empty copy at 17px body; iOS uses 15px subheadline
- **What/Why:** Both fallback texts inherit `--fs-body` 17px (HistoryView.tsx:81, 116 — no font-size set); the iOS counterpart renders them at `.subheadline` (HistoryView.swift:18). 17px secondary text for a peripheral message over-weights it in the hierarchy (Typography: modular-scale discipline + cross-platform parity).
- **Location:** `apps/desktop/src/features/trade/HistoryView.tsx:81, 116`
- **Exact fix:** add `fontSize: 'var(--fs-subheadline)'` to both fallback containers (or fold into the `.history-empty` class from the P2 token fix).

### [P3] — BUY/SELL side carries no color cue
- **What/Why:** The row title `BUY 1 MNQ…` is monochrome mono (HistoryView.tsx:132-143). Every other surface in the app encodes side via `--buy-green`/`--sell-red`; here side is the one attribute a trader scans for and it requires reading. Density/scannability nit — the "holy shit" version color-codes the side word only (text stays, so meaning isn't color-only).
- **Location:** `apps/desktop/src/features/trade/HistoryView.tsx:142`
- **Exact fix:**
  ```tsx
  <span style={{ color: entry.side === 'buy' ? 'var(--buy-green)' : 'var(--sell-red)' }}>
    {entry.side.toUpperCase()}
  </span>{' '}
  {entry.quantity} {entry.contractSymbol}
  ```
  (Confirm the side literal casing in `@0dtetrader/shared-types` — compare case-insensitively if it isn't normalized.)

## Quick wins vs structural work

**< 1 hour:**
- Zero-P/L neutral color (F1) — one ternary.
- Retry button on error state (F2) — ~15 lines, no new dependencies.
- `role="dialog"`/`aria-modal`/`aria-label` + initial focus (F3).
- Center the loading spinner / parity fix (F5 minimum version).
- Sticky summary header (F7) — four CSS properties.
- `prefers-reduced-motion` block (F8).
- Done-button hit area (F9).
- 12px→grid padding, last-row border, subheadline parity, side color cue (F10–F12).

**Structural (> 1 hour):**
- Spacing scale in `tokens.css` + extraction of `.history-*` classes (F6) — touches the design system; should be coordinated with the other screens that inline the same values.
- Skeleton loading rows with shimmer (F5 preferred version) — needs a shared `Skeleton` component other sheets will reuse.
- Designed empty state with a real icon asset (F4) — blocked on an SF-Symbol-equivalent icon set for desktop.
- Day-grouped sections in the list (noted in Density score; requires grouping logic + sticky section headers, and should land in iOS and desktop together to preserve parity).
