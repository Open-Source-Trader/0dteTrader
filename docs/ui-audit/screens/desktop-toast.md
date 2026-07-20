# Screen d11: Toast overlay

- **App:** Desktop
- **Location:** `apps/desktop/src/features/trade/ToastView.tsx:11-28` (view), `apps/desktop/src/features/trade/TradeScreen.tsx:268` (mount), `apps/desktop/src/design/components/components.css:433-457` (`.toast` / `.toast-capsule`), `apps/desktop/src/design/base.css:129-138` (`toast-in` keyframes), `apps/desktop/src/design/tokens.css:65` (`--toast-anim`), `apps/desktop/src/features/trade/TradeStore.ts:390-399` (`showToast`, 3000ms auto-dismiss); iOS reference `apps/ios/0dteTrader/Features/Trade/ToastView.swift` + `TradeScreenView.swift:68-76`
- **Visual:** UNVERIFIED-VISUAL — transient overlay, not captured; reconstructed from code: capsule centered horizontally inside 430px frame (16px side insets), top edge at y=4 (overlapping the 44px NavBar), padding 10px 14px, 13px/500 footnote text + 14px icon with 6px gap, `--app-surface-elevated` (#282b35) fill, 1px border at 60% tint, radius 999px, shadow `0 0 6px rgba(0,0,0,0.45)`, entrance `translateY(-12px)→0` + fade over 200ms, disappears instantly at t=3000ms.
- **Scores:** Composition 7/10 · Typography 7/10 · Color 8/10 · Density 8/10 · DataViz 7/10 · Motion 5/10 · States 6/10 · Platform 5/10 · A11y 3/10 · Consistency 7/10 → **Overall 63/100**
- **Score justifications:**
  - Composition 7 — centered capsule with symmetric 16px insets is disciplined and matches iOS 1:1, but the 4px top offset is off the 8pt grid and parks the capsule on top of the NavBar title/buttons for its full 3s life (TradeScreen.tsx:268 + components.css:436).
  - Typography 7 — correct token use (`--fs-footnote` 13px, weight 500 mirrors iOS `.footnote.weight(.medium)`), but alert prices (`alert.price.toFixed(2)`, TradeScreen.tsx:121) render in proportional system-ui instead of the tabular/mono treatment all other prices get.
  - Color 8 — semantic tokens throughout (`--pnl-positive`/`--pnl-negative`/`--app-accent`), and meaning is never color-only (distinct icon per style, ToastView.tsx:13-18); tint-on-elevated contrast is comfortable (~7:1 for #30d158 on #282b35).
  - Density 8 — exactly one primary datum (message) plus one glyph; no chrome, no clutter; correct hierarchy for a transient confirmation.
  - DataViz 7 — no data-viz surface exists here; nothing mishandled, but price-bearing toasts ignore the app's price-formatting conventions (see Typography).
  - Motion 5 — entrance is 200ms with a 12px slide+fade (in range), but exit is a zero-duration DOM removal (TradeStore.ts:394-398) while iOS animates both ways (`TradeScreenView.swift:72,76`), and `ease-in-out` is the wrong curve shape for an entrance.
  - States 6 — three styles covered with icons; but toasts clobber each other (no queue), errors auto-vanish in 3s with no action or persistence, and there is no long-message bound.
  - Platform 5 — positioned correctly inside the phone frame with sane z-index, but `pointer-events: none` (components.css:442) makes it non-dismissible and unhoverable, and there is no keyboard or focus consideration.
  - A11y 3 — no `role="status"`/`aria-live` anywhere, so screen-reader users never hear order fills, rejections, or alert crossings; no `prefers-reduced-motion` handling (zero matches in the entire desktop CSS).
  - Consistency 7 — geometry/type/stroke faithfully clone the SwiftUI source (padding 14/10, 60% stroke, capsule, radius-6 shadow all match ToastView.swift:27-32), but two inline `style={{}}` props bypass the stylesheet and success/error styles borrow P&L tokens for order-status semantics.

## Findings

### [P1] — Toast exits with an instant pop; iOS animates both directions

- **What/Why:** `showToast` sets `toast: null` after 3000ms (TradeStore.ts:394-398), React unmounts the node, and the capsule vanishes in a single frame — no fade, no slide. The iOS original uses `.transition(.move(edge: .top).combined(with: .opacity))` + `.animation(.easeInOut(duration: 0.2))` (TradeScreenView.swift:72-76), so the clone is a visible fidelity regression on every single toast. Violates Motion (120–250ms eased, both directions). A hard cut on a surface the user is staring at reads as a glitch, not polish.
- **Location:** `apps/desktop/src/features/trade/TradeStore.ts:394-398`, `apps/desktop/src/features/trade/ToastView.tsx:20`, `apps/desktop/src/design/base.css:129-138`
- **Exact fix:**
  1. Add a leaving phase in `TradeStore.ts` (replace the dismiss block at :394-398):
     ```ts
     this.toastDismissTimer = setTimeout(() => {
       if (this.getState().toast?.id === toast.id) {
         this.set({ toast: { ...toast, leaving: true } });
         setTimeout(() => {
           if (this.getState().toast?.id === toast.id) this.set({ toast: null });
         }, 200);
       }
     }, 3000);
     ```
     and add `leaving?: boolean` to the `Toast` interface at TradeStore.ts:24-28.
  2. In `ToastView.tsx:20`, apply the state: `<div className={toast.leaving ? 'toast toast-leaving' : 'toast'} key={toast.id}>`.
  3. In `base.css` after :138, add:
     ```css
     @keyframes toast-out {
       from {
         opacity: 1;
         transform: translateY(0);
       }
       to {
         opacity: 0;
         transform: translateY(-12px);
       }
     }
     ```
     and in `components.css` after the `.toast` rule: `.toast.toast-leaving { animation: toast-out var(--toast-anim); }`.

### [P1] — No live region: order fills and rejections are invisible to screen readers

- **What/Why:** The toast is two plain `<div>`s with no `role`, no `aria-live` (ToastView.tsx:20-26). This component carries the app's most safety-critical feedback — "Buy MESU26 — Filled", "… — Rejected", price-alert crossings (TradeStore.ts:282-285, 353-356, 381-384; TradeScreen.tsx:121) — and assistive tech announces none of it. Violates Accessibility (VoiceOver/labels) and is a WCAG 4.1.3 Status Messages failure.
- **Location:** `apps/desktop/src/features/trade/ToastView.tsx:20`
- **Exact fix:** Change line 20 to:
  ```tsx
  <div
    className="toast"
    key={toast.id}
    role={toast.style === 'error' ? 'alert' : 'status'}
    aria-live={toast.style === 'error' ? 'assertive' : 'polite'}
  >
  ```

### [P2] — Toasts clobber each other; no queue

- **What/Why:** `showToast` unconditionally overwrites `state.toast` (TradeStore.ts:391-392). A fill toast from `handleOrderUpdate` (:381) can be wiped 200ms later by a `refreshTradingData` error toast (:305/:310), and a price alert (TradeScreen.tsx:121) can erase an order-rejection the user needed to read. The timer resets (:393), but the replaced message is simply lost. Violates State Coverage / Information Density (losing primary information).
- **Location:** `apps/desktop/src/features/trade/TradeStore.ts:390-399`
- **Exact fix:** Add a FIFO queue. At TradeStore.ts:72 add `private toastQueue: Toast[] = [];`, then replace `showToast` (:390-399) with:
  ```ts
  showToast(message: string, style: ToastStyle): void {
    this.toastQueue.push({ id: nextId++, message, style });
    if (this.getState().toast !== null) return; // one is already showing
    this.advanceToastQueue();
  }

  private advanceToastQueue(): void {
    const next = this.toastQueue.shift();
    if (!next) return;
    this.set({ toast: next });
    this.toastDismissTimer = setTimeout(() => {
      this.set({ toast: null });
      this.advanceToastQueue();
    }, 3000);
  }
  ```

### [P2] — Error toasts auto-dismiss in 3s with no persistence or action

- **What/Why:** A rejected order or a failed flatten gets the same 3000ms lifetime as "Order cancelled." (TradeStore.ts:398 — one hardcoded duration for all styles). Errors are the one message class a user may need to re-read or act on; 3s is below the ~5s norm for error notifications, and `pointer-events: none` (components.css:442) forbids even a manual dismiss/hover-to-pause. Violates State Coverage (actionable errors) and Platform Fidelity.
- **Location:** `apps/desktop/src/features/trade/TradeStore.ts:398`, `apps/desktop/src/design/components/components.css:442`
- **Exact fix:**
  1. Style-dependent duration, TradeStore.ts:398: `}, style === 'error' ? 5000 : 3000);` (pass `style` into the timeout closure — `toast.style`).
  2. Make it dismissible: in `components.css:442` change `.toast` to `pointer-events: none;` → keep, but add `.toast .toast-capsule { pointer-events: auto; cursor: pointer; }`, and in `ToastView.tsx:21` add `onClick={() => tradeStore.dismissToast()}` (wire via prop), with a new `dismissToast()` in TradeStore that clears the timer and sets `toast: null`.

### [P2] — No `prefers-reduced-motion` handling anywhere in the desktop app

- **What/Why:** Zero matches for `prefers-reduced-motion` in `apps/desktop/src` — the 200ms slide+fade (and every other animation) plays regardless of the OS setting. Violates Motion (reduced-motion) and Accessibility. On a trading screen that toasts on every fill, this is a real vestibular-comfort gap.
- **Location:** `apps/desktop/src/design/base.css:129-138`, `apps/desktop/src/design/tokens.css:65`
- **Exact fix:** Append to `base.css`:
  ```css
  @media (prefers-reduced-motion: reduce) {
    :root {
      --toast-anim: 1ms linear;
      --sheet-anim: 1ms linear;
    }
  }
  ```
  (Driving both through their existing tokens fixes toast and sheet motion with one rule; no TSX changes needed.)

### [P3] — Entrance uses `ease-in-out`; entrances should decelerate

- **What/Why:** `--toast-anim: 200ms ease-in-out` (tokens.css:65) accelerates at the start of the drop-in, which reads sluggish; Apple-style entrances use a decelerate curve. The project already ships the right curve for sheets (`--sheet-anim: 300ms cubic-bezier(0.32, 0.72, 0, 1)`, tokens.css:64). Note: iOS uses `.easeInOut` here too (TradeScreenView.swift:76), so this fix intentionally raises the bar above the source. Violates Motion polish.
- **Location:** `apps/desktop/src/design/tokens.css:65`
- **Exact fix:** `--toast-anim: 200ms cubic-bezier(0.32, 0.72, 0, 1);` — keep `ease-in-out` only for the `toast-out` keyframe added in the P1 exit fix (symmetric exit), or reuse the same curve for both for simplicity.

### [P3] — Inline `style={{}}` props bypass the component stylesheet

- **What/Why:** `ToastView.tsx:21-22` hardcodes `borderColor: color-mix(...)` and `color/display: flex` inline, so the toast's entire tinted-ring identity lives outside `components.css` and can't be themed/overridden per style (e.g. you can't give the error toast a tinted background without more inline JS). Violates Consistency (no one-off styles / token bypass pattern the audit flags app-wide).
- **Location:** `apps/desktop/src/features/trade/ToastView.tsx:21-22`
- **Exact fix:** Move to CSS classes. In ToastView.tsx:
  ```tsx
  <div className={`toast-capsule toast-${toast.style}`}>
    <span className="toast-icon"><Icon size={14} /></span>
  ```
  In `components.css` after :457 add:
  ```css
  .toast-icon {
    display: flex;
  }
  .toast-success {
    border-color: color-mix(in srgb, var(--pnl-positive) 60%, transparent);
  }
  .toast-success .toast-icon {
    color: var(--pnl-positive);
  }
  .toast-error {
    border-color: color-mix(in srgb, var(--pnl-negative) 60%, transparent);
  }
  .toast-error .toast-icon {
    color: var(--pnl-negative);
  }
  .toast-info {
    border-color: color-mix(in srgb, var(--app-accent) 60%, transparent);
  }
  .toast-info .toast-icon {
    color: var(--app-accent);
  }
  ```
  and delete the `TINTS` map (ToastView.tsx:4-8).

### [P3] — `top: 4px` is an off-grid magic number that sits the capsule on the NavBar

- **What/Why:** `.toast { top: 4px }` (components.css:436) is off the 8pt grid, and since the toast is absolutely positioned against the TradeScreen root (TradeScreen.tsx:168, `position: relative`) rather than the content area, the ~37px-tall capsule occupies y=4–41, visually covering the 44px NavBar's title and icon buttons for 3s. (`pointer-events: none` saves the taps, not the pixels.) iOS does the same overlay (`padding(.top, 4)`, TradeScreenView.swift:71), so this is parity — but it's a shared compositional wart worth fixing on both platforms. Violates Composition (8pt grid, layering).
- **Location:** `apps/desktop/src/design/components/components.css:436`, `apps/desktop/src/features/trade/TradeScreen.tsx:267-268`
- **Exact fix:** Either snap to grid and accept the overlap: `top: 8px;` — or drop the toast below the NavBar: `top: calc(var(--h-navbar) + 8px);` (uses the existing `--h-navbar: 44px` token, tokens.css:62). Prefer the latter: the capsule then floats over the chart, which is non-interactive at its top edge, instead of over live NavBar buttons.

### [P3] — Prices inside toast text render in proportional type

- **What/Why:** Alert toasts interpolate `alert.price.toFixed(2)` (TradeScreen.tsx:121) and order toasts interpolate contract symbols/status into a 13px proportional string (ToastView.tsx:25). Every other price in the app uses monospaced/tabular figures; a toast that says "Alert: MES crossed 6124.75" breaks that discipline and can jitter when a queued toast with a different-width number replaces it. Violates Typography (tabular figures for ALL prices) and Consistency.
- **Location:** `apps/desktop/src/features/trade/TradeScreen.tsx:121`, `apps/desktop/src/features/trade/ToastView.tsx:25`
- **Exact fix:** In `components.css` add `.toast .toast-capsule { font-variant-numeric: tabular-nums; }` (one declaration, no TSX change; keeps the system font while stabilizing digits).

## Quick wins vs structural work

**Quick wins (<1 hour each):**

- Add `role`/`aria-live` to the toast div (P1 #2) — 3 lines in ToastView.tsx:20.
- Add the `prefers-reduced-motion` media query driving `--toast-anim`/`--sheet-anim` (P2 #5).
- Swap `--toast-anim` to the decelerate curve (P3 #6) — one token.
- Move the two inline styles into `.toast-success/-error/-info` CSS classes (P3 #7).
- `top: calc(var(--h-navbar) + 8px)` (P3 #8) — one declaration.
- `font-variant-numeric: tabular-nums` on the capsule (P3 #9) — one declaration.
- Style-dependent error duration `5000` vs `3000` (half of P2 #4) — one expression in TradeStore.ts:398.

**Structural work (needs refactor/design decision):**

- Exit animation (P1 #1) — requires a `leaving` state threaded through `TradeStore`, the `Toast` type, `ToastView`, and new keyframes; touches store timing logic.
- Toast queue (P2 #3) — changes `showToast` semantics in `TradeStore`; must be coordinated with the exit-animation work since both own the dismiss timer.
- Click-to-dismiss / hover-pause (rest of P2 #4) — needs a new `dismissToast()` store method, prop drilling into `ToastView`, and pointer-event CSS changes; also raises the design question of whether iOS gains the same tap-to-dismiss.
