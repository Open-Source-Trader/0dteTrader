# Screen d16: Drawing layer + drawing toolbar
- **App:** Desktop
- **Location:** `apps/desktop/src/features/chart/DrawingLayer.tsx` (canvas overlay, :35-389), `apps/desktop/src/features/chart/DrawingToolbar.tsx` (tool dropdown, :24-78), `apps/desktop/src/features/chart/drawings.ts` (DrawingsStore, :40-189); host: `apps/desktop/src/features/chart/ChartView.tsx:181`; shared: `apps/desktop/src/design/components/Menu.tsx`, `apps/desktop/src/design/components/components.css:199-242`
- **Visual:** UNVERIFIED-VISUAL — drawing tools never exercised in captures; layout reconstructed from code (31px circular trigger in the 44px chart header, 200px-min dropdown with 11px/16px row padding, canvas overlay spanning the chart pane left of the price axis)
- **Scores:** Composition 6/10 · Typography 4/10 · Color 7/10 · Density 6/10 · DataViz 6/10 · Motion 3/10 · States 4/10 · Platform 5/10 · A11y 3/10 · Consistency 4/10 → **Overall 48/100**
- **Score justifications:**
  - Composition 6 — single compact dropdown in the header is the right TradingView pattern, and 11px/16px menu rows sit near the 8pt grid, but the 31px trigger is off-grid and price tags float at pane-left over candles instead of docking to the axis.
  - Typography 4 — menu rows use `--fs-body` correctly, but all canvas text is a hardcoded `10px ui-monospace, monospace` (DrawingLayer.tsx:183), below the smallest token (`--fs-caption2: 11px`) and off the `--font-mono` stack; an emoji (⏰) is used as a glyph instead of an icon.
  - Color 7 — accent `#568ff7` on `#0b0c10` ≈ 6.3:1 and alert `#ff9f0a` ≈ 9:1 both clear WCAG 3:1 UI / 4.5:1 text, and alerts are dash-coded (color-independent) — but every color is a hardcoded hex duplicating an existing token (`--app-accent`, `--warning-orange`, `--app-background`).
  - Density 6 — one toolbar button for six tools is admirably dense; the cost is that drawings, alerts, and drafts all share one accent color with no on-canvas legend or count, and price tags overlap the leftmost candles.
  - DataViz 6 — 1.25px lines, dashed alerts, and a 12%-alpha box fill show real gridline restraint; but tags render at 10px, handles are 10px white circles with no selection ring, and there is no crosshair/snapping readout while drafting.
  - Motion 3 — zero motion anywhere: the dropdown mounts instantly (no 120–250ms ease), the trigger has no hover/pressed transition, selections/drafts snap with no feedback, and `prefers-reduced-motion` is never consulted; worse, the canvas repaints every rAF forever.
  - States 4 — draft/selected/idle states exist in the store, but "Clear all drawings" executes in one click with no confirmation or undo (drawings.ts:149-161), corrupt localStorage silently wipes user work (drawings.ts:63-65), and there is no empty-state hint teaching the tools.
  - Platform 5 — Delete/Backspace/Escape and a crosshair cursor are correct desktop idioms, but there is no `:focus-visible` style anywhere in the design system (base.css), no hover cursor/highlight on drawings, no menu arrow-key navigation, and the trigger hit target is 31px vs the 44px bar it lives in.
  - A11y 3 — the canvas has no `role`/`aria-label`, no keyboard path exists to select or move a drawing, menu items are buttons without `role="menuitem"` and focus is never moved into or returned from the dropdown; the trigger's `aria-label` is the only accessible surface.
  - Consistency 4 — inline `style={{}}` on every element, five hardcoded hex/rgba values duplicating tokens, a hardcoded font stack instead of `--font-mono`, and the alert toast uses `toFixed(2)` while the canvas uses `Format.price` for the same number.

## Findings

### [P1] — "Clear all drawings" / Backspace delete are instant, unrecoverable data loss
- **What/Why:** Selecting the destructive menu row (or pressing Delete/Backspace with a selection) permanently erases annotations — including "Clear all drawings" wiping every trend line and alert for the symbol — with no confirmation and no undo. Violates State Coverage and Platform Fidelity; TradingView confirms bulk clears and every pro tool ships Cmd+Z. One mis-click in a 200px dropdown whose destructive row sits directly under the tool list (no separator) destroys analysis the user built over a session. Persisted immediately to localStorage (drawings.ts:160), so it is unrecoverable.
- **Location:** `apps/desktop/src/features/chart/drawings.ts:148-166`, `apps/desktop/src/features/chart/DrawingToolbar.tsx:59-75`
- **Exact fix:** Add an undo stack and a destructive separator. In `drawings.ts`:
  ```ts
  private history: { drawings: Drawing[]; alerts: PriceAlert[] }[] = [];

  private snapshot(): void {
    const { drawings, alerts } = this.getState();
    this.history.push({ drawings, alerts });
    if (this.history.length > 50) this.history.shift();
  }

  undo(): void {
    const prev = this.history.pop();
    if (!prev) return;
    this.set({ drawings: prev.drawings, alerts: prev.alerts, selectedId: null });
    this.persist();
  }
  ```
  Call `this.snapshot()` first inside `removeSelectedOrClear()`. In `DrawingLayer.tsx:325` add to `onKey`:
  ```ts
  if ((event.metaKey || event.ctrlKey) && event.key === 'z') {
    event.preventDefault();
    store.undo();
    return;
  }
  ```
  In `DrawingToolbar.tsx`, make the destructive item visually separated and confirmed:
  ```tsx
  onSelect: () => {
    if (selectedId) {
      store.removeSelectedOrClear();
    } else if (window.confirm('Clear all drawings and alerts for this symbol? (Cmd+Z to undo)')) {
      store.removeSelectedOrClear();
    }
  },
  ```

### [P1] — Canvas overlay is a black hole for keyboard and screen-reader users
- **What/Why:** Drawings exist only as pixels. The `<canvas>` has no `role`, no `aria-label`, no `tabIndex`; there is no keyboard way to select, nudge, or inspect a drawing (arrow keys do nothing), and `Menu` renders plain `<button>`s with no `role="menu"`/`menuitem`, no arrow-key navigation, and focus is never moved into the dropdown or returned on Escape (Menu.tsx:46-64). Violates Accessibility (no color-independent problem here, but total absence of non-pointer operation) and Platform Fidelity (keyboard). WCAG 2.1.1 (keyboard) failure.
- **Location:** `apps/desktop/src/features/chart/DrawingLayer.tsx:373-388`, `apps/desktop/src/design/components/Menu.tsx:46-64`
- **Exact fix:** Give the canvas a label and keyboard nudging in `DrawingLayer.tsx`:
  ```tsx
  <canvas
    ref={canvasRef}
    role="img"
    aria-label={`Chart drawings: ${drawings.length} shapes, ${alerts.length} alerts. Delete removes selection; arrow keys nudge it.`}
    // add to onKey in the keydown effect:
    // if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) {
    //   event.preventDefault(); store.nudgeSelected(event.key, event.shiftKey ? 10 : 1); return;
    // }
  ```
  Add to `drawings.ts`:
  ```ts
  nudgeSelected(key: string, steps: number): void {
    const { selectedId, drawings, alerts } = this.getState();
    if (!selectedId) return;
    const dPrice = (key === 'ArrowUp' ? 1 : key === 'ArrowDown' ? -1 : 0) * steps * 0.25; // tick
    const dTime = (key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0) * steps * 60; // 1m bucket
    this.set({
      drawings: drawings.map((d) =>
        d.id === selectedId
          ? { ...d,
              p1: { time: d.p1.time + dTime, price: d.p1.price + dPrice },
              p2: d.p2 ? { time: d.p2.time + dTime, price: d.p2.price + dPrice } : null }
          : d),
      alerts: alerts.map((a) => (a.id === selectedId ? { ...a, price: a.price + dPrice } : a)),
    });
    this.persist();
  }
  ```
  In `Menu.tsx`, add `role="menu"` to the dropdown, `role="menuitem"` to each button, `autoFocus` the first item on open, and on Escape call `(wrapRef.current?.querySelector('button') as HTMLElement)?.focus()` to return focus to the trigger.

### [P1] — Clicking anywhere inside a box drawing hijacks chart panning
- **What/Why:** The rect hit test treats the entire interior (plus 2px) as draggable (DrawingLayer.tsx:232-236) and the capture-phase `pointerdown` handler then `preventDefault()` + `stopPropagation()` (DrawingLayer.tsx:269-270), so any pan gesture that starts inside a box moves the box instead of the chart. On a 430px-wide phone-frame chart, a medium box makes a large region of the chart un-pannable — a functional bug masquerading as a feature. TradingView selects on border/edge proximity only; interior moves require the shape to already be selected.
- **Location:** `apps/desktop/src/features/chart/DrawingLayer.tsx:232-236`
- **Exact fix:** Hit-test the rect border, not the fill:
  ```ts
  if (drawing.kind === 'rect') {
    const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
    const onBorder =
      x >= left - HIT_DISTANCE && x <= right + HIT_DISTANCE &&
      y >= top - HIT_DISTANCE && y <= bottom + HIT_DISTANCE &&
      (Math.abs(x - left) <= HIT_DISTANCE || Math.abs(x - right) <= HIT_DISTANCE ||
       Math.abs(y - top) <= HIT_DISTANCE || Math.abs(y - bottom) <= HIT_DISTANCE);
    const alreadySelected = state.selectedId === drawing.id;
    if (onBorder || (alreadySelected && x >= left && x <= right && y >= top && y <= bottom)) {
      return { id: drawing.id, mode: 'whole' };
    }
    continue;
  }
  ```

### [P1] — Unconditional rAF render loop repaints the overlay every frame, forever
- **What/Why:** `draw()` re-runs on every `requestAnimationFrame` (DrawingLayer.tsx:80-105, 201) even with zero drawings, zero drafts, and a static chart — re-measuring pane size, clearing, and iterating state ~60×/s for the app's entire lifetime. On a phone-frame Electron app this is pure battery/CPU burn and competes with the quote-stream ticks. Violates Motion&Micro-interactions (rendering discipline) and is a latent perf P1.
- **Location:** `apps/desktop/src/features/chart/DrawingLayer.tsx:75-204`
- **Exact fix:** Render on demand. Keep the `draw` body but replace the loop with event-driven invalidation:
  ```ts
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; draw(); });
    };
    const unsubStore = store.subscribe(schedule);
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    chart.subscribeCrosshairMove(schedule); // covers live appends shifting geometry
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas.parentElement as Element);
    schedule();
    return () => {
      unsubStore();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule);
      chart.unsubscribeCrosshairMove(schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, series, store]);
  ```
  (`draw` unchanged; `Store.subscribe` already exists at `apps/desktop/src/core/observable.ts:14`.)

### [P2] — Every canvas style is a hardcoded hex/px duplicating a design token
- **What/Why:** `#568ff7` (= `--app-accent`), `#ff9f0a` (= `--warning-orange`), `#0b0c10` (= `--app-background`), `#fff`, `rgba(86, 143, 247, 0.12)`, and `10px ui-monospace, monospace` (tokens.css:40-43 defines `--font-mono`) are all literal constants at DrawingLayer.tsx:7-10, 131, 183, 187, 192. The tokens file was explicitly "extracted from iOS DesignSystem" — this module bypasses it, so a token change silently desynchronizes canvas from UI. Violates Consistency and Typography (10px is below the smallest scale step `--fs-caption2: 11px`).
- **Location:** `apps/desktop/src/features/chart/DrawingLayer.tsx:7-10, 131, 183-188, 192`
- **Exact fix:**
  ```ts
  const css = getComputedStyle(document.documentElement);
  const ACCENT = css.getPropertyValue('--app-accent').trim() || '#568ff7';
  const ALERT_COLOR = css.getPropertyValue('--warning-orange').trim() || '#ff9f0a';
  const TAG_TEXT = css.getPropertyValue('--app-background').trim() || '#0b0c10';
  const RECT_FILL = 'rgba(86, 143, 247, 0.12)'; // add --drawing-rect-fill to tokens.css and read it here
  ```
  (compute once inside the render effect), add to `tokens.css`: `--drawing-rect-fill: rgba(86, 143, 247, 0.12);`, and change the tag font to `ctx.font = '11px ui-monospace, "SF Mono", Menlo, monospace';` (matching `--fs-caption2` + `--font-mono`), growing the tag rect to `fillRect(4, y - 9, w, 18)` / `fillText(label, 8, y + 4)` to keep the 8px horizontal padding.

### [P2] — Drawing-tools trigger is a 31px target inside a 44px header bar
- **What/Why:** `padding: 8` + 15px icon = 31×31px (DrawingToolbar.tsx:34-44), below the 44pt HIG minimum this clone claims to mirror and below the `--h-navbar: 44px` bar it sits in (ChartView.tsx:180-181). No hover or `:focus-visible` style exists anywhere (`grep hover|focus base.css` → only `cursor` hits), so keyboard focus on the trigger is invisible — a WCAG 2.4.7 failure on the primary control of this feature.
- **Location:** `apps/desktop/src/features/chart/DrawingToolbar.tsx:33-45`, `apps/desktop/src/design/base.css` (no focus styles)
- **Exact fix:** In `DrawingToolbar.tsx` change the trigger to `padding: 10` and icon `size={16}` (36px visual, and give the wrapping flex div `padding: 4px 0` to reach a 44px hit area); in `base.css` add globally:
  ```css
  button:focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: 2px;
    border-radius: inherit;
  }
  button:hover:not(:disabled) { filter: brightness(1.15); }
  ```

### [P2] — Tool disarms after every shape; no hover feedback while editing
- **What/Why:** `commitDraft()`/`addHLine()` reset `tool: 'cursor'` after a single placement (drawings.ts:98, 118), so drawing three trend lines means reopening the dropdown three times — friction TradingView solved with tool persistence. Separately, in cursor mode the canvas has `pointerEvents: 'none'` (DrawingLayer.tsx:381) and nothing changes the cursor or strokes a highlight when hovering a shape/handle, so users discover draggability by accident. Violates Motion&Micro-interactions (no hover state) and the "zero friction" bar.
- **Location:** `apps/desktop/src/features/chart/drawings.ts:92-106, 109-122`, `apps/desktop/src/features/chart/DrawingLayer.tsx:374-383`
- **Exact fix:** Keep the tool armed until Escape/cursor is chosen — in `commitDraft()` and `addHLine()` remove `tool: 'cursor'` from the `set()` calls (Escape already calls `cancelDraft()` which resets the tool). For hover, attach a `pointermove` listener on the container in the existing capture-phase effect:
  ```ts
  const onHover = (event: PointerEvent) => {
    if (store.getState().tool !== 'cursor') return;
    const xy = canvasXY(event);
    const hit = xy && hitTest(xy.x, xy.y);
    containerEl.style.cursor = hit ? (hit.mode === 'whole' || hit.mode === 'alert' ? 'move' : 'grab') : '';
  };
  containerEl.addEventListener('pointermove', onHover);
  ```
  and render a hover state by tracking `hoverId` in a ref and stroking hovered shapes at `lineWidth = 2` (same width as selected) in `renderDrawing`.

### [P2] — Dropdown appears with zero motion; no reduced-motion support
- **What/Why:** `.menu-dropdown` toggles via conditional render (Menu.tsx:46) with no transition — it pops full-opacity in one frame. The design system already ships `--sheet-anim: 300ms cubic-bezier(0.32, 0.72, 0, 1)` and `--toast-anim` tokens (tokens.css:64-65) that nothing here uses, and `prefers-reduced-motion` is never referenced in the codebase. Violates Motion (120–250ms eased entrances are the bar).
- **Location:** `apps/desktop/src/design/components/components.css:206-222`, `apps/desktop/src/design/components/Menu.tsx:46-64`
- **Exact fix:** In `components.css`:
  ```css
  .menu-dropdown {
    /* existing rules… */
    transform-origin: top right;
    animation: menu-in 160ms cubic-bezier(0.32, 0.72, 0, 1);
  }
  @keyframes menu-in {
    from { opacity: 0; transform: scale(0.96) translateY(-4px); }
    to   { opacity: 1; transform: scale(1) translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .menu-dropdown { animation: none; }
  }
  ```

### [P3] — Emoji-as-icon (⏰) in the alert price tag
- **What/Why:** `priceTag(ctx, price, y, ALERT_COLOR, '⏰ ')` (DrawingLayer.tsx:172) relies on the platform emoji font inside a 10px monospace context — it renders inconsistently across OSes, inflates the measured tag width unpredictably, and clashes with the crisp custom SVG icon set used everywhere else (`design/icons`). Violates Consistency/Typography.
- **Location:** `apps/desktop/src/features/chart/DrawingLayer.tsx:172, 182-188`
- **Exact fix:** Drop the emoji and draw a 3×7px tick bar before the price instead:
  ```ts
  priceTag(ctx, price, y, ALERT_COLOR, /* alert = */ true);
  // inside priceTag:
  if (isAlert) { ctx.fillRect(4, y - 8, 3, 16); } // alert accent bar
  ctx.fillRect(isAlert ? 7 : 4, y - 8, w, 16);
  ctx.fillText(label, isAlert ? 11 : 8, y + 3.5);
  ```
  The dashed line already distinguishes alerts; the bar adds a second color-independent cue.

### [P3] — Same alert price formatted two different ways on screen
- **What/Why:** The canvas tag renders `Format.price(price)` (DrawingLayer.tsx:182) but the fired-alert toast renders `alert.price.toFixed(2)` (TradeScreen.tsx:121) — `4,850.25` on the chart vs `4850.25` in the toast for the same event. Violates Consistency.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:121`
- **Exact fix:** `tradeStore.showToast(\`Alert: ${symbol} crossed ${Format.price(alert.price)}\`, 'info');` (add the existing `Format` import from `../../design/format`).

### [P3] — Persistence is one-way fragile: quota errors throw, corruption wipes silently
- **What/Why:** `persist()` calls `localStorage.setItem` unguarded (drawings.ts:184-188) — a QuotaExceededError during a drag's `updateDrawing` (which persists on every pointermove, drawings.ts:134-139!) throws inside the move handler, breaking dragging. And the read path swallows corrupt JSON into "start clean" (drawings.ts:63-65), silently erasing a user's annotations with no recovery or notice. Also: persisting on every pointermove during a drag is O(n) JSON serialization per frame. Violates State Coverage.
- **Location:** `apps/desktop/src/features/chart/drawings.ts:134-139, 184-188, 63-65`
- **Exact fix:**
  ```ts
  private persist(): void {
    const { symbol, drawings, alerts } = this.getState();
    if (!symbol) return;
    try {
      localStorage.setItem(STORAGE_PREFIX + symbol, JSON.stringify({ drawings, alerts }));
    } catch {
      // Quota full or storage denied: keep in-memory state; drawings live for the session.
    }
  }
  ```
  and in `updateDrawing`/`updateAlertPrice` remove the `this.persist()` call, calling it once in the pointer-up path instead (add `store.persistNow()` — a public wrapper — invoked from `onUp` in DrawingLayer.tsx:309-313).

### [P3] — No keyboard shortcuts surfaced in the tool menu
- **What/Why:** TradingView's menu shows `Alt+T`, `Alt+R` etc.; here the menu rows are label-only (DrawingToolbar.tsx:14-21) and no shortcuts exist at all — the only way to switch tools is pointer. Given Delete/Escape already have keybindings, this is the missing third of the keyboard story. Violates Platform Fidelity.
- **Location:** `apps/desktop/src/features/chart/DrawingToolbar.tsx:14-21`, `apps/desktop/src/features/chart/DrawingLayer.tsx:324-336`
- **Exact fix:** Add `shortcut: string` to each TOOLS entry (`V, T, R, H, B, A`), render it in the row:
  ```tsx
  label: (<><Icon size={14} />{label}<span style={{ marginLeft: 'auto', fontSize: 'var(--fs-caption)', color: 'var(--label-secondary)' }}>{shortcut}</span></>),
  ```
  and in the DrawingLayer keydown effect: `if (!event.metaKey && !event.ctrlKey && !event.altKey) { const t = TOOL_KEYS[event.key.toLowerCase()]; if (t) store.setTool(t); }` with `const TOOL_KEYS: Record<string, DrawingTool> = { v: 'cursor', t: 'trend', r: 'ray', h: 'hline', b: 'rect', a: 'alert' };`.

## Quick wins vs structural work

**Landable in <1 hour:**
- Guard `persist()` with try/catch and toast-consistent `Format.price` in TradeScreen.tsx:121 (P3 ×2).
- Token-ize the five canvas colors + 11px tag font (P2, mechanical).
- `.menu-dropdown` entrance animation + `prefers-reduced-motion` block (P2, pure CSS).
- 36px trigger padding + global `:focus-visible`/hover rules in base.css (P2).
- Emoji → accent bar in the alert tag (P3).
- Keep tool armed after commit (two deleted lines in drawings.ts) (P2, half).

**Needs refactor / design decision:**
- Undo stack + clear-all confirmation (P1) — touches store, toolbar, and keyboard layer; needs a decision on history depth and toast-based undo vs `confirm()`.
- Keyboard nudging + canvas ARIA + Menu focus management/roles (P1) — Menu is shared by every screen; role/keyboard changes should be audited across consumers.
- Rect border-only hit testing (P1) — small code change but alters learned interaction; pair with hover cursor work.
- Event-driven redraw replacing the rAF loop (P1) — needs careful coverage of every invalidation source (pan, zoom, resize, live appends) to avoid stale-pixels regressions.
- Hover highlight state (P2) — adds a `hoverId` concept to the store/render loop.
- Shortcut system (P3) — should be a shared app-level shortcut registry, not a per-screen `Record`.
