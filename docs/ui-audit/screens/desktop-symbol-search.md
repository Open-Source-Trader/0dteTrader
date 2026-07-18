# Screen d13: Symbol search sheet
- **App:** Desktop
- **Location:** `apps/desktop/src/features/chart/SymbolSearchView.tsx` (whole file, esp. L47–56 sheet/nav, L57–82 search bar, L84–117 list); supporting: `apps/desktop/src/design/components/Sheet.tsx:24-29`, `NavBar.tsx:10-18`, `apps/desktop/src/design/tokens.css`, `apps/desktop/src/design/base.css:71-89`, `apps/desktop/src/design/components/components.css:114-149,372-431`; iOS counterpart `apps/ios/0dteTrader/Features/Chart/SymbolSearchView.swift`
- **Visual:** screenshot `docs/ui-audit/shots/06-symbol-search.png` (860×1864 = 2× 430×932 frame, verified)
- **Scores:** Composition 7/10 · Typography 7/10 · Color 8/10 · Density 7/10 · DataViz n/a (no charts — excluded) · Motion 5/10 · States 6/10 · Platform 5/10 · A11y 4/10 · Consistency 6/10 → **Overall 55/90 applicable = 61/100**
- **Score justifications:**
  - Composition 7: Clean iOS grouped-list rhythm — 16px screen margins, section headers inset 32px align exactly with 32px row-text inset, 44px rows, 22px section gaps all on/derived from the 4pt grid; loses points for off-grid 6px gap / 10px padding in the search bar (SymbolSearchView.tsx:62-64) and a grabber-less sheet.
  - Typography 7: Token-driven scale (`--fs-headline` 17/600 title, `--fs-body` rows, `--fs-footnote` uppercase +0.4px section headers, components.css:380-386) — a correct, restrained 3-level hierarchy; no tabular figures needed (no prices); no Dynamic-Type/zoom handling (fixed 430×932 scale transform only).
  - Color 8: All-semantic tokens; measured contrast passes — placeholder/`label-secondary` on `--app-surface-elevated` ≈ 5.2:1 (≥4.5), accent `#568ff7` "Close" on background ≈ 6.1:1, checkmark on elevated ≈ 4.4:1 (icon needs only 3:1); selection is icon-shape + color, not color-only.
  - Density 7: 44px single-line rows are right for a picker and 31 symbols stay scannable in 4 sections, but rows carry zero secondary context (no instrument names), so the list is sparse in *information* while long in *scroll*.
  - DataViz n/a: No charts, axes, or tooltips on this screen; excluded from the overall.
  - Motion 5: Sheet enter uses a good iOS-like `300ms cubic-bezier(0.32,0.72,0,1)` (tokens.css:64), but there are no press/hover states, no row stagger, and no `prefers-reduced-motion` handling anywhere in the desktop app (grep: zero matches).
  - States 6: The "Use X" custom row elegantly doubles as the no-results state and Enter works; missing: invalid-symbol error path, keyboard focus state, and any pressed state.
  - Platform 5: Escape + backdrop dismiss and `autoFocus` are correct desktop behavior, but the entire desktop codebase has zero `:hover`/`:focus-visible` styles, no arrow-key list navigation, and no focus trap — it behaves like a touch screenshot, not a desktop app.
  - A11y 4: No `role="dialog"`/`aria-modal`, no label on the search input (placeholder only), `outline: none` on inputs with no replacement (base.css:71-77), selected state not exposed to AT, no focus trap. Fundamentally keyboard/SR-hostile.
  - Consistency 6: Good reuse of `Sheet`/`NavBar`/`grouped-*` classes, but the screen's core layout is inline `style={{}}` bypasses including `borderRadius: 10` that ignores the existing `--radius-input` token, and the SECTIONS list is copy-pasted between iOS and desktop (drift risk).

## Findings

### [P1] — Zero focus indication: `outline: none` on inputs, no `:focus-visible` anywhere in the app
- **What/Why:** Violates Accessibility + Platform Fidelity and WCAG 2.4.7 (Focus Visible). `base.css:71-77` strips input outlines; a repo-wide grep for `:focus`/`:focus-visible`/`prefers-reduced-motion` in `apps/desktop/src` returns zero matches, so keyboard users get no visible focus on the search input, rows, or Close button. On a screen whose entire job is keyboard-first (autoFocus + Enter), this is ship-blocking for a desktop app.
- **Location:** `apps/desktop/src/design/base.css:71-77` (input reset), absence across `apps/desktop/src/design/components/components.css`
- **Exact fix:** In `components.css` add:
  ```css
  button:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: 2px;
    border-radius: var(--radius-chip);
  }
  .grouped-row:focus-visible { outline-offset: -2px; }
  ```

### [P1] — Sheet is not a dialog to assistive tech: no role, no aria-modal, no focus trap
- **What/Why:** Violates Accessibility + Platform Fidelity. `Sheet.tsx:24-29` renders plain `<div>`s; screen readers never learn a modal opened, and Tab cycles into the chart behind the sheet. Escape handling (Sheet.tsx:16-22) is the only correct piece.
- **Location:** `apps/desktop/src/design/components/Sheet.tsx:24-29`
- **Exact fix:**
  ```tsx
  <div className="sheet-backdrop" onClick={onDismiss} />
  <div className={`sheet-panel ${detent}`} role="dialog" aria-modal="true" aria-label="Symbol">
    {children}
  </div>
  ```
  plus a focus trap in the existing `useEffect`: on mount, `panel.querySelector('input, button')?.focus()`, and a `keydown` handler that wraps Tab/Shift+Tab between the panel's first/last focusable elements; on unmount, restore focus to the element that opened the sheet.

### [P1] — Rows are inert: no hover and no pressed state on any list row
- **What/Why:** Violates Motion & Micro-interactions + Platform Fidelity. `.grouped-row` (components.css:400-409) has no `:hover` or `:active` rule — unlike `.menu-item:active` (components.css:240-242), which proves the pattern exists but wasn't applied. On desktop, pointer hover feedback is table stakes; in the iOS clone it also loses the UITableView touch-highlight parity.
- **Location:** `apps/desktop/src/design/components/components.css:400-409`
- **Exact fix:**
  ```css
  .grouped-row:hover { background: rgba(118, 118, 128, 0.12); }
  .grouped-row:active { background: rgba(118, 118, 128, 0.24); }
  ```

### [P1] — Enter commits raw free text instead of the top visible match
- **What/Why:** Violates State Coverage (error path) + zero-friction bar. SymbolSearchView.tsx:77-79: typing `SP` + Enter selects the literal symbol "SP" (an invalid instrument that will land the chart in an error/empty state) even though "SPY" is right there as the first filtered row. The iOS version has the same latent issue but no hardware Enter, so it ships only on desktop.
- **Location:** `apps/desktop/src/features/chart/SymbolSearchView.tsx:77-79`
- **Exact fix:**
  ```tsx
  onKeyDown={(event) => {
    if (event.key !== 'Enter' || !normalizedQuery) return;
    const firstMatch = SECTIONS.flatMap((s) => filtered(s.symbols))[0];
    select(firstMatch ?? normalizedQuery);
  }}
  ```

### [P2] — Search input has no accessible name; selection state not exposed
- **What/Why:** Violates Accessibility (WCAG 4.1.2 / 1.3.1). The `<input>` (SymbolSearchView.tsx:70-80) relies on `placeholder="Symbol"` as its only name — placeholders are not labels and disappear on input. The current-symbol checkmark (L106-110) is visual-only; AT users can't tell which row is selected.
- **Location:** `apps/desktop/src/features/chart/SymbolSearchView.tsx:70-80, 103-112`
- **Exact fix:** Add `aria-label="Search symbols"` and `autoComplete="off"` to the input; on each row add `aria-current={symbol === currentSymbol ? 'true' : undefined}`; give the checkmark span `aria-hidden="true"` and add a visually-hidden "current symbol" text, or add `role="listbox"` on `.sheet-body` and `role="option" aria-selected={symbol === currentSymbol}` on rows.

### [P2] — Inline-style bypasses, including ignoring the existing radius token
- **What/Why:** Violates Consistency (token discipline). The root layout div (L48), search wrapper padding `4px 16px 8px` (L57), and the entire search-bar block (L58-68) are inline `style={{}}` one-offs; `borderRadius: 10` (L66) hardcodes a value that already exists as `var(--radius-input)` in tokens.css:56. With no spacing tokens in the project, every inline number is an un-auditable magic value.
- **Location:** `apps/desktop/src/features/chart/SymbolSearchView.tsx:48, 57-68`
- **Exact fix:** Move to `components.css`:
  ```css
  .symbol-search { background: var(--app-background); flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .symbol-search-field { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; margin: 4px 16px 8px; background: var(--app-surface-elevated); border-radius: var(--radius-input); }
  .symbol-search-field input { flex: 1; text-transform: uppercase; }
  ```
  and replace the three inline blocks with `className="symbol-search"` / `className="symbol-search-field"` (keeping `MagnifierIcon`/`TextCursorIcon` inline color overrides, which are legitimate token references).

### [P2] — No keyboard navigation through results
- **What/Why:** Violates Platform Fidelity. A desktop symbol picker (Bloomberg/TradingView pattern: type → arrow-down → enter) requires mouse-clicking a row here; ArrowUp/ArrowDown do nothing. Combined with P1-4, the keyboard flow dead-ends.
- **Location:** `apps/desktop/src/features/chart/SymbolSearchView.tsx:70-117`
- **Exact fix:** Track `const [activeIndex, setActiveIndex] = useState(0)` over the flattened visible rows; in the input's `onKeyDown`, `ArrowDown`/`ArrowUp` clamp `activeIndex ± 1`, Enter selects `rows[activeIndex]`; add `className={i === activeIndex ? 'grouped-row kb-active' : 'grouped-row'}` and CSS `.grouped-row.kb-active { background: rgba(118, 118, 128, 0.16); }`; reset `activeIndex` to 0 whenever `normalizedQuery` changes.

### [P2] — Rows show ticker only: no instrument names, no disambiguation
- **What/Why:** Violates Information Density (context hierarchy). "SPY", "MES", "GC" with no subtitle ("SPDR S&P 500 ETF Trust", "Micro E-mini S&P 500", "Gold Futures") forces memorized-ticker knowledge on a screen whose purpose is *discovery*. The row has 44px of height spending ~20px on whitespace — room exists for a two-line row (17px primary + 13px `--fs-footnote` secondary) without changing the rhythm.
- **Location:** `apps/desktop/src/features/chart/SymbolSearchView.tsx:103-112`
- **Exact fix:** Extend `SymbolSection.symbols` to `{ ticker: string; name: string }[]` and render:
  ```tsx
  <button className="grouped-row" key={s.ticker} onClick={() => select(s.ticker)}>
    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
      <span>{s.ticker}</span>
      <span style={{ fontSize: 'var(--fs-footnote)', color: 'var(--label-secondary)' }}>{s.name}</span>
    </span>
    ...
  ```
  (and raise row `min-height` to 56px for two-line rows in `components.css:404`).

### [P2] — Hidden scrollbar + no scroll affordance: half the list is invisible with no hint
- **What/Why:** Violates Information Density / discoverability. `hide-scrollbar` (base.css:84-89) removes the only scroll cue; in the verified screenshot the "LTC" row is clipped mid-glyph at the bottom edge and "Futures Roots"/"Stocks" sections are entirely unreachable-looking. iOS gets away with it via the scroll indicator appearing on touch; desktop shows nothing ever.
- **Location:** `apps/desktop/src/design/base.css:83-89` applied at `SymbolSearchView.tsx:84`
- **Exact fix:** Add a bottom fade to the list container:
  ```css
  .sheet-body.grouped-list { -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 40px), transparent); mask-image: linear-gradient(to bottom, #000 calc(100% - 40px), transparent); }
  ```
  and/or drop `hide-scrollbar` on desktop and style a 3px thumb: `.sheet-body::-webkit-scrollbar { width: 3px; } .sheet-body::-webkit-scrollbar-thumb { background: var(--label-secondary); border-radius: 2px; }`.

### [P3] — Sheet has no grabber handle (iOS parity gap)
- **What/Why:** Violates Consistency with iOS sheets, which render a 36×5pt grabber atop `.presentationDetents`. The sheet panel (components.css:123-139) jumps straight to content; the screenshot confirms no grabber. Small, but it's the kind of detail that makes the clone feel like iOS rather than a div.
- **Location:** `apps/desktop/src/design/components/Sheet.tsx:27` + `apps/desktop/src/design/components/components.css:123-139`
- **Exact fix:**
  ```css
  .sheet-panel::before { content: ''; flex: none; align-self: center; width: 36px; height: 5px; border-radius: 3px; background: rgba(235, 235, 245, 0.3); margin: 6px 0 0; }
  ```

### [P3] — Off-grid search-bar internals: 6px gap, 10px padding
- **What/Why:** Violates Composition (4pt/8pt grid). SymbolSearchView.tsx:62-64 uses `gap: 6` and `padding: '0 10px'`; every surrounding value (16px margins, 36px height, 22px section gaps) is 4pt-aligned. Unmeasurable by eye but it's exactly the class of drift a token system exists to prevent.
- **Location:** `apps/desktop/src/features/chart/SymbolSearchView.tsx:62-64`
- **Exact fix:** `gap: 8`, `padding: '0 12px'` (or the `.symbol-search-field` CSS from the P2 consistency finding, which already uses 8/12).

### [P3] — No reduced-motion handling for the 300ms sheet slide
- **What/Why:** Violates Motion (reduced-motion support). `sheet-up`/`backdrop-in` run unconditionally (components.css:119-130, base.css:140-155); vestibular-sensitive users get a full-screen 300ms translate with no opt-out. Grep confirms zero `prefers-reduced-motion` in the app.
- **Location:** `apps/desktop/src/design/base.css:140-155`
- **Exact fix:**
  ```css
  @media (prefers-reduced-motion: reduce) {
    .sheet-panel, .sheet-backdrop { animation: backdrop-in 150ms ease-out; }
  }
  ```

### [P3] — SECTIONS duplicated verbatim across iOS and desktop
- **What/Why:** Violates Consistency (single source of truth). SymbolSearchView.tsx:11-20 and SymbolSearchView.swift:17-23 hardcode the same 31-symbol, 4-section list in two languages; adding a symbol requires two edits that *will* drift. `packages/shared-types` exists in the monorepo for exactly this.
- **Location:** `apps/desktop/src/features/chart/SymbolSearchView.tsx:11-20` vs `apps/ios/0dteTrader/Features/Chart/SymbolSearchView.swift:17-23`
- **Exact fix:** Move the list to `packages/shared-types/src/symbols.ts` (`export const SYMBOL_SECTIONS = [...] as const`), generate or hand-sync the Swift array from it (build-phase script or checked-in generated file), and import it in the TSX. If shared codegen is out of scope, at minimum colocate it in `apps/desktop/src/features/chart/symbolSections.ts` so the screen file holds view code only.

### [P3] — Checkmark at 14px is small for the primary selected-state glyph
- **What/Why:** Violates Composition (hierarchy). The only state indicator on the screen (SymbolSearchView.tsx:107-109) renders at 14px next to 17px body text; iOS's own checkmark in this context renders at ~17pt with medium weight. It reads as a footnote instead of the answer to "which one is active".
- **Location:** `apps/desktop/src/features/chart/SymbolSearchView.tsx:108`
- **Exact fix:** `<CheckmarkIcon size={17} />` and add `display: 'flex'` (or `alignItems: 'center'`) to the wrapping `.row-value` span so the larger glyph stays optically centered.

## Quick wins vs structural work

**< 1 hour (CSS/props only):**
- `:focus-visible` rules (P1-1) — one CSS block.
- Row `:hover`/`:active` states (P1-3) — two CSS lines.
- `aria-label`/`autoComplete`/`aria-current` on input + rows (P2-5) — props only.
- Enter-selects-first-match (P1-4) — 4-line logic change.
- Token swap + off-grid fixes in search bar (P2-6, P3-11) — class extraction, 15 min.
- Sheet grabber (P3-10) — one `::before` rule.
- Reduced-motion media query (P3-12) — one block.
- Checkmark 14→17px (P3-14) — one prop.
- Scroll fade mask (P2-9 partial) — one CSS rule.

**Structural (refactor / cross-platform):**
- Focus trap + dialog semantics + focus restore in the shared `Sheet` component (P1-2) — touches every sheet in the app; needs testing across all callers.
- Arrow-key navigation with active-row model (P2-7) — introduces list-state machinery; should be built as a reusable hook if other pickers follow.
- Instrument names/subtitles (P2-8) — requires a symbol-metadata source (static map or API), data the app doesn't currently have.
- Shared symbol-list source in `packages/shared-types` with iOS sync (P3-13) — build tooling / codegen decision.
- Real scrollbar treatment replacing `hide-scrollbar` globally (P2-9) — design decision affecting every scroll view in the clone.
