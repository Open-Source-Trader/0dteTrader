# Screen d9: Order confirm sheet

- **App:** Desktop
- **Location:** `apps/desktop/src/features/trade/OrderConfirmSheet.tsx` (whole file; key refs: sheet body L30-44, detail card L67-150, error/retry L127-149, buttons L152-185); shell `apps/desktop/src/design/components/Sheet.tsx:15-30`; styles `apps/desktop/src/design/components/components.css:114-149`, `apps/desktop/src/design/base.css:140-156`; state `apps/desktop/src/features/trade/TradeStore.ts:274-297`
- **Visual:** UNVERIFIED-VISUAL — sheet could not be triggered (no broker credentials, BUY disabled); layout reconstructed mathematically from code: phone-content = 932 − 59 (status bar) − 34 (home indicator) = 839px; `.sheet-panel.medium` = 48% → ~403px tall, 430px wide; content column = 390px wide (20px side padding), success-state content ≈ 353px (grabber 13 + title 24 + summary 18 + card ~170 + buttons 52 + 4×16 gaps + 12 bottom pad), leaving ~50px slack — one warning row (+26px) fits, two warnings (~405px) overflow into a scrollbar-hidden scroll region.
- **Scores:** Composition 6/10 · Typography 5/10 · Color 5/10 · Density 6/10 · DataViz 5/10 · Motion 5/10 · States 5/10 · Platform 4/10 · A11y 4/10 · Consistency 5/10 → **Overall 50/100**
- **Score justifications:**
  - Composition 6: 20/16/12px rhythm mostly on-grid and CTA anchored via `marginTop: auto` (L152), but card gap 10px (L72) and 5px grabber (L48) break the 8pt grid, and the 50/50 button split (L153-154) gives the primary money action no dominance.
  - Typography 5: correct SF-token ramp (`--fs-title3/subheadline/footnote`) with a bold 20px title, but every numeric (est. price, buying power, quantity, contract symbol, L78-108) renders in proportional system-ui — the iOS design system mandates monospaced/tabular price figures.
  - Color 5: semantic tokens used throughout (L26, L40, L74), but white CTA text measures ~2.6:1 on `--buy-green` #19b85b and ~4.3:1 on `--sell-red` #e13a43 against the 4.5:1 AA bar for 17px/600 text.
  - Density 6: right primary-vs-secondary split of rows, but the two decision-critical numbers (est. price, est. buying power) are demoted to 60%-opacity secondary text identical in weight to "Quantity" — no hierarchy among facts.
  - DataViz 5: no chart on this screen; the only async affordance is a 14px spinner + text (L84-90) where the bar is skeleton rows that match the resolved layout.
  - Motion 5: sheet-up + backdrop 300ms `cubic-bezier(0.32,0.72,0,1)` (tokens.css:64) is a faithful iOS curve, but zero press states on any button, a label↔spinner swap that shifts CTA width (L183), and no reduced-motion handling.
  - States 5: loading/error/success all exist and the error has a retry, but the retry re-fetches the preview after a _submit_ failure (L144 vs TradeStore.ts:289), loading is a spinner not a skeleton, and there is no offline state.
  - Platform 4: Escape (Sheet.tsx:18) and backdrop-click dismiss work; missing focus trap, initial focus, focus return, Enter-to-confirm, hover styles, and `:focus-visible` rings anywhere in the app CSS.
  - A11y 4: buy/sell meaning is not color-only (label text present) and targets are 52px ≥ 44pt; but no `role="dialog"`/`aria-modal`/`aria-labelledby`, no `aria-live` for preview/error, spinner has no `role="status"`, CTA contrast fails AA.
  - Consistency 5: tokens used for color/size, but the whole file is inline `style={{}}` (12 blocks), duplicating the existing `.trade-action-button` class (components.css:331-341) and `.grouped-row` pattern with one-off `DetailRow` (L14-21); magic numbers 40/5/3/14/13/10/12/16/20 throughout.

## Findings

### [P1] — Sheet can be dismissed mid-submission while the order may still fill

- **What/Why:** backdrop click (Sheet.tsx:26), Escape (Sheet.tsx:18) and Cancel (L162) all call `cancelArmedOrder()` unconditionally. While `isSubmitting` is true, the order request is in flight (`confirmArmedOrder`, TradeStore.ts:275-293); dismissing the sheet clears `armedTicket` but not the network call — the user believes they cancelled an order that can still fill. Violates State Coverage / Platform Fidelity in the most safety-critical flow in the app.
- **Location:** `apps/desktop/src/features/trade/OrderConfirmSheet.tsx:30`, `:162`; `apps/desktop/src/design/components/Sheet.tsx:18,26`
- **Exact fix:** guard every dismiss path. L30: `onDismiss={() => { if (!isSubmitting) tradeStore.cancelArmedOrder(); }}`. L153 Cancel button: add `disabled={isSubmitting}` and `opacity: isSubmitting ? 0.35 : 1` to its inline style. Destructure `isSubmitting` is already available from L25.

### [P1] — White CTA label fails WCAG AA on both side colors

- **What/Why:** Color & Contrast. 17px/600 text is below WCAG "large text" (18.66px bold), so it needs 4.5:1. Measured from tokens: white on `--buy-green` #19b85b = **2.59:1** (fail by 42%); white on `--sell-red` #e13a43 = **4.32:1** (fail). This is the primary money button.
- **Location:** `apps/desktop/src/features/trade/OrderConfirmSheet.tsx:171-174`
- **Exact fix:** darken the fill via color-mix at the usage site, keeping the semantic token as the base. L171: `background: ticket.side === 'buy' ? 'color-mix(in srgb, var(--buy-green) 70%, #000)' : 'color-mix(in srgb, var(--sell-red) 90%, #000)'` (yields ~5.0:1 and ~5.2:1). Better long-term: add `--buy-green-cta: #0d8043` and `--sell-red-cta: #c93038` to `tokens.css:10-11` and reference those.

### [P1] — "Retry" after a failed order submission re-fetches the preview instead of resubmitting

- **What/Why:** State Coverage. `confirmArmedOrder`'s catch writes the _submit_ error into `previewError` (TradeStore.ts:289) while `preview` stays non-null; the sheet then renders the submit error with a Retry button wired to `loadPreview()` (L144) — the button does not retry the action that failed, and a stale (possibly repriced) preview remains Confirm-able next to the error.
- **Location:** `apps/desktop/src/features/trade/OrderConfirmSheet.tsx:138-148`; `apps/desktop/src/features/trade/TradeStore.ts:287-289`
- **Exact fix:** make Retry context-sensitive at L144: `onClick={() => void (preview ? tradeStore.confirmArmedOrder() : tradeStore.loadPreview())}` and change the label to `{preview ? 'Retry order' : 'Retry'}`. Also clear the stale preview on submit failure — TradeStore.ts:289: `this.set({ previewError: errorMessage(error), preview: null });`

### [P1] — Sheet has no dialog semantics or focus management

- **What/Why:** Accessibility + Platform Fidelity. The sheet is a plain `<div>` pair: no `role="dialog"`, `aria-modal`, `aria-labelledby`, no initial focus, no focus trap, no focus return on close — keyboard and screen-reader users get a backdrop div followed by loose buttons.
- **Location:** `apps/desktop/src/design/components/Sheet.tsx:24-29`
- **Exact fix:**

```tsx
const panelRef = useRef<HTMLDivElement>(null);
useEffect(() => {
  const prev = document.activeElement as HTMLElement | null;
  panelRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  return () => prev?.focus();
}, []);
// on the panel:
<div ref={panelRef} className={`sheet-panel ${detent}`} role="dialog" aria-modal="true" aria-label="Confirm order">
```

and pass `aria-label` via a new optional prop; in OrderConfirmSheet L56 give the title `id="order-confirm-title"` and use `aria-labelledby="order-confirm-title"` instead.

### [P1] — Loading state is a spinner + text; resolves with a layout jump

- **What/Why:** State Coverage / Motion. During `isPreviewLoading` the card shows one spinner row (L84-90); when the preview resolves, 3+ rows (contract, price, buying power, warnings) materialize at once, growing the card ~70px and shoving the CTA row down. Bar: skeletons that match the final layout, no shift.
- **Location:** `apps/desktop/src/features/trade/OrderConfirmSheet.tsx:84-90`
- **Exact fix:** replace the spinner block with three skeleton rows mirroring the resolved rows:

```tsx
{isPreviewLoading ? (
  <>
    {[0, 1, 2].map((i) => (
      <div key={i} style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span className="skeleton" style={{ width: 88 + i * 12, height: 14 }} />
        <span className="skeleton" style={{ width: 64, height: 14 }} />
      </div>
    ))}
  </>
) : ...
```

plus in `base.css`: `.skeleton { border-radius: 4px; background: var(--app-surface-elevated); animation: skeleton-pulse 1200ms ease-in-out infinite; }` and `@keyframes skeleton-pulse { 50% { opacity: 0.55; } }`.

### [P1] — No tabular/monospaced figures for any price or quantity

- **What/Why:** Typography. `Format.price(...)` values (L104-108), the contract symbol (L102) and quantity (L78) render in proportional system-ui; the project's own design system (AppTypography.swift monospaced price fonts; `--font-mono` in tokens.css:42) exists but is never applied here. Numbers also won't align across the label/value rows.
- **Location:** `apps/desktop/src/features/trade/OrderConfirmSheet.tsx:14-21, 102-108`
- **Exact fix:** in `DetailRow` (L18): `<span className="text-secondary" style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>`; apply the same style to the contract-symbol span at L102.

### [P2] — Submitting spinner is rendered at 35% opacity

- **What/Why:** Motion / States. While submitting, `confirmEnabled` is false so L172 applies `opacity: 0.35` to the button that contains the white spinner — the busiest, most important moment of the flow is rendered dimmed, reading as "broken/disabled" instead of "working".
- **Location:** `apps/desktop/src/features/trade/OrderConfirmSheet.tsx:172, 180-183`
- **Exact fix:** L172: `opacity: confirmEnabled || isSubmitting ? 1 : 0.35,`

### [P2] — No hover, press, or focus-visible feedback on any button

- **What/Why:** Platform Fidelity (desktop) / Motion. Cancel, Confirm and Retry (L138-184) have no `:hover` and no `:active` style — the iOS analog (dim-on-touch) and the desktop analog (hover brighten + focus ring) are both absent; only `menu-item` has an `:active` rule in the whole stylesheet (components.css:240).
- **Location:** `apps/desktop/src/features/trade/OrderConfirmSheet.tsx:138-184`; `apps/desktop/src/design/base.css:58-69`
- **Exact fix:** give both buttons a shared class (e.g. `className="confirm-btn"` on L153/166) and add to `components.css`:

```css
.confirm-btn {
  transition:
    filter 120ms ease-out,
    opacity 120ms ease-out;
}
.confirm-btn:hover:not(:disabled) {
  filter: brightness(1.12);
}
.confirm-btn:active:not(:disabled) {
  filter: brightness(0.88);
}
.confirm-btn:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
}
```

### [P2] — Enter does not confirm; only Escape is wired

- **What/Why:** Platform Fidelity. Desktop users expect Enter = primary action in a modal; Sheet.tsx only binds Escape (L17-21). In a speed-critical 0DTE flow this is the difference between one keystroke and a mouse hunt.
- **Location:** `apps/desktop/src/features/trade/OrderConfirmSheet.tsx:29-44`; `apps/desktop/src/design/components/Sheet.tsx:16-22`
- **Exact fix:** add inside `OrderConfirmSheet`:

```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && confirmEnabled) void tradeStore.confirmArmedOrder();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [confirmEnabled, tradeStore]);
```

### [P2] — Fixed 48% detent + hidden scrollbar: 2+ warnings overflow invisibly

- **What/Why:** Composition / State Coverage. Reconstructed math: sheet = 403px; success content with two warning rows ≈ 405px → the CTA row scrolls 2px+ out of view inside `overflowY: auto` + `.hide-scrollbar` (L41-43), which suppresses the only scroll affordance. Content-sized sheets (iOS detents size to content) don't have this failure mode.
- **Location:** `apps/desktop/src/features/trade/OrderConfirmSheet.tsx:41-43`; `apps/desktop/src/design/components/components.css:141-143`
- **Exact fix:** components.css:141-143: replace `.sheet-panel.medium { height: 48%; }` with `.sheet-panel.medium { height: auto; max-height: 78%; }`. Keep `overflowY: 'auto'` as the fallback for the max-height case.

### [P2] — No `prefers-reduced-motion` handling anywhere

- **What/Why:** Motion / Accessibility. `sheet-up`, `backdrop-in`, `spinner-rotate` (base.css:123-156) all run unconditionally; the sheet slide is exactly the class of motion vestibular settings exist for.
- **Location:** `apps/desktop/src/design/base.css:123-156`
- **Exact fix:** append to base.css:

```css
@media (prefers-reduced-motion: reduce) {
  .sheet-panel,
  .sheet-backdrop,
  .toast {
    animation-duration: 1ms;
  }
  .spinner {
    animation-duration: 1600ms;
  }
}
```

### [P2] — Loading/error transitions are invisible to assistive tech

- **What/Why:** Accessibility. The preview loading row, the resolved preview, and the error text (L84-149) mutate silently; `Spinner` (Spinner.tsx:7) is a bare `<span>` with no `role="status"`.
- **Location:** `apps/desktop/src/features/trade/OrderConfirmSheet.tsx:84-149`; `apps/desktop/src/design/components/Spinner.tsx:7`
- **Exact fix:** wrap the card's dynamic region: L67 div gets `aria-live="polite"`; error span L129 gets `role="alert"`; Spinner.tsx:7: add `role="status"` and `aria-label="Loading"` to the span.

### [P3] — Warning icon centers against wrapped multi-line text

- **What/Why:** Polish. `alignItems: 'center'` (L114) vertically centers the 13px triangle against the whole wrapped warning block; iOS `Label` aligns the glyph to the first line. With a 2-line warning the icon floats at mid-height.
- **Location:** `apps/desktop/src/features/trade/OrderConfirmSheet.tsx:110-122`
- **Exact fix:** L114: `alignItems: 'flex-start'`, and on the icon L120: `<WarningIcon size={13} style={{ marginTop: 2 }} />`.

### [P3] — Title and CTA repeat "Confirm Buy"; the CTA carries no decision data

- **What/Why:** Information Density / "holy shit" bar. L57 title and L183 button are the identical string; meanwhile the number the user is actually confirming (est. price) sits in 60%-opacity secondary text at L104. Robinhood-style: the button itself states the commitment.
- **Location:** `apps/desktop/src/features/trade/OrderConfirmSheet.tsx:56-58, 183`
- **Exact fix:** L183: `{isSubmitting ? <Spinner white /> : \`${sideDisplayName(ticket.side)} ${ticket.request.quantity} · ~${preview ? Format.price(preview.resolved.price) : '—'}\``} (button is only enabled when `preview` is non-null, so the price is always present at press time).

### [P3] — Inline one-off styles bypass existing component classes; card row ramp is inconsistent

- **What/Why:** Consistency. The Confirm button hand-rolls (L166-179) exactly what `.trade-action-button` already defines (components.css:331-341); `DetailRow` (L14-21) is a one-off parallel to `.grouped-row`/`.row-value` (components.css:400-418); the "Contract" row alone uses `--fs-subheadline` (L98) while its siblings use default 17px body; the sheet's inner div re-paints `var(--app-background)` (L40) over the panel's own `var(--app-surface)` (components.css:128), making the panel token dead. Magic numbers with no spacing tokens: 40/5/3 (L47-49), gap 16/10/12/8/6 (L38, 72, 85, 115, 152), padding 20/12/16 (L39, 73), 14px spinner (L86), 13px icon (L120) — 10px and 5px break the 8pt grid.
- **Location:** `apps/desktop/src/features/trade/OrderConfirmSheet.tsx:14-21, 40, 47-49, 98, 166-179`
- **Exact fix:** L166: `className="trade-action-button"` and keep only the per-instance overrides inline (`background`, `opacity`); in tokens.css add `--space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px;` and swap L38 `gap: 16` → `gap: 'var(--space-4)'`, L72 `gap: 10` → `gap: 'var(--space-3)'` (also fixes the grid break), L39 `padding: '0 var(--space-5) var(--space-3)'`; L98 drop the `fontSize` override so all card rows use 17px body.

## Quick wins vs structural work

**Landable in <1 hour:**

- Guard dismiss during submit (P1 #1) — one condition + one `disabled`.
- CTA contrast color-mix (P1 #2) — one line.
- Context-sensitive Retry + clear stale preview (P1 #3) — two lines.
- Submitting-spinner opacity (P2 #7) — one expression.
- `tabular-nums`/mono on values (P1 #6) — two style props.
- Enter-to-confirm (P2 #9) — one `useEffect`.
- Warning icon alignment (P3 #13) — two properties.
- `aria-live`/`role="alert"`/`role="status"` (P2 #12) — three attributes.
- prefers-reduced-motion block (P2 #11) — one media query.

**Needs refactor / cross-file design work:**

- Dialog semantics + focus trap/return in `Sheet.tsx` (P1 #4) — touches every sheet consumer.
- Skeleton loading state (P1 #5) — new `.skeleton` primitive + per-row widths matched to resolved layout.
- Content-sized medium detent (P2 #10) — change `.sheet-panel.medium` sizing and re-verify every medium sheet.
- Hover/press/focus system (P2 #8) — introduce shared button classes; reconcile with `.trade-action-button`.
- Spacing token scale + inline-style cleanup (P3 #15) — new tokens, then sweep this file (and siblings) off inline `style={{}}`.
- Data-bearing CTA label (P3 #14) — product decision on label format, then string change.
