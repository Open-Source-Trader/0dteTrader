# Screen d1: Phone shell (430×932 frame, status bar, home indicator, session-restore spinner)

- **App:** Desktop (Electron/React fixed 430×932 phone-frame clone of the iOS app)
- **Location:** `apps/desktop/src/RootView.tsx:34-63` (frame + state switch), `apps/desktop/src/main.tsx:10-15` (scale), `apps/desktop/src/design/components/StatusBar.tsx:11-29`, `apps/desktop/src/design/components/Spinner.tsx:6-8`, `apps/desktop/src/design/base.css:15-56` (body, `#root`, `.phone-frame`, `.phone-content`), `apps/desktop/src/design/components/components.css:4-53` (status bar, island, home indicator) and `:101-112` (spinner), `apps/desktop/src/design/tokens.css`
- **Visual:** screenshot `docs/ui-audit/shots/02-login.png` (860×1864 = 2× of the 430×932 frame; shows status bar, Dynamic Island, home indicator over the login screen). The session-restore spinner state is **UNVERIFIED-VISUAL — screenshot captures the login state, not the `checking` state; spinner layout reconstructed from `RootView.tsx:38-53` (content region 932−59−34 = 839px tall, block centered at y ≈ 479 logical: 22px spinner + 12px gap + 13px label).**
- **Scores:** Composition 7/10 · Typography 6/10 · Color 6/10 · Density 8/10 · DataViz 5/10 · Motion 4/10 · States 5/10 · Platform 6/10 · A11y 3/10 · Consistency 5/10 → **Overall 55/100**
- **Score justifications:**
  - **Composition 7:** Exact 430×932 logical frame, island horizontally centered (`components.css:23-28`), home indicator centered; measured in the shot — island 250×72px @2× = 125×36 ✓, indicator bar 280×10px @2× = 140×5 ✓. Docked for corner radius 24px vs. real iPhone 14 Pro Max ~47.3pt (screenshot corners read as a card, not a device) and chrome occupying 59+34 = 93/932 = 10.0% of viewport (acceptable, real iOS is ~9.5%).
  - **Typography 6:** Time is `16px`/600 with `letter-spacing: 0.2px` (`components.css:16-18`) — a one-off size that matches no `--fs-*` token; real iOS status-bar time is 17pt SF Pro Semibold. Spinner label correctly uses `--fs-footnote` (`RootView.tsx:50`). No Dynamic Type/zoom equivalent anywhere (frame is transform-scaled, user font-size preferences are ignored).
  - **Color 6:** Chrome uses `--label-primary`/bg tokens correctly and the time/glyphs pass AA (~16:1). Docked for spinner track `rgba(235,235,245,0.25)` on `#0b0c10` ≈ 2.1:1 — below the 3:1 WCAG bar for UI components (`components.css:104`).
  - **Density 8:** Shell chrome is appropriately minimal — one line of chrome top and bottom, content gets 90% of the frame; nothing superfluous rendered. Matches the real device's information budget.
  - **DataViz 5:** No dataviz on this screen (N/A); scored at midpoint because the loading state uses a bare spinner with no skeleton/placeholder content, which is the dataviz-adjacent discipline this screen could demonstrate.
  - **Motion 4:** Spinner is `0.8s linear infinite` (`components.css:106`) — linear rotation is fine for spinners, but there is no `prefers-reduced-motion` handling anywhere, and the `checking → login` root-state swap is an instant hard cut with zero transition (`RootView.tsx:38-60`).
  - **States 5:** The `checking` state exists and is labeled ("Restoring session…"), which is above average — but it has no timeout/failure path (spinner forever if the token refresh hangs), no offline state, and the spinner-vs-skeleton choice is defensible only because the restore is expected <1s.
  - **Platform 6:** Cosmetic chrome mimicry is convincing (island, glyphs, indicator all present and aligned in the shot), but corner radius is half the real device's, the clock polls every 10s so it can sit up to 10s behind the minute, the spinner is a CSS border-arc rather than an iOS-style ProgressView, and there's no desktop-side window chrome/min-size handling in `main.tsx`.
  - **A11y 3:** Decorative status bar is not `aria-hidden` (screen reader announces "10:47" + three unlabeled SVGs), the spinner/restore state has no `role="status"`/`aria-live`, `base.css:75` sets `outline: none` on inputs with no `:focus-visible` replacement, and the whole app ignores `prefers-reduced-motion`.
  - **Consistency 5:** Shell metrics are magic numbers — 59/28/14/125/36/140/5/34px in `components.css`, `size={22}` and inline `style={{...}}` block in `RootView.tsx:40-47`, `16px` time font — none tokenized in `tokens.css` despite the tokens file explicitly claiming to be the geometry source of truth.

## Findings

### [P1] — Session-restore spinner spins forever with no timeout or failure path

- **What/Why:** If `authStore.start()` hangs (server unreachable, stalled token refresh), the user stares at "Restoring session…" indefinitely. Violates State Coverage (actionable errors, designed failure states). There is no elapsed-time escalation, no retry, no "check your connection" — the only way out is killing the app.
- **Location:** `apps/desktop/src/RootView.tsx:38-53`
- **Exact fix:** Track elapsed time and escalate after 8s:

```tsx
const [slowRestore, setSlowRestore] = useState(false);
useEffect(() => {
  if (state !== 'checking') return;
  const t = setTimeout(() => setSlowRestore(true), 8000);
  return () => clearTimeout(t);
}, [state]);
```

and inside the `checking` branch, below the label:

```tsx
{
  slowRestore && (
    <>
      <span className="text-secondary" style={{ fontSize: 'var(--fs-footnote)' }}>
        Taking longer than expected — check your connection.
      </span>
      <button className="link-button" onClick={() => void container.authStore.start()}>
        Retry
      </button>
    </>
  );
}
```

### [P1] — No `prefers-reduced-motion` handling; spinner animates unconditionally

- **What/Why:** `animation: spinner-rotate 0.8s linear infinite` runs regardless of OS reduced-motion settings; vestibular-sensitive users get an indefinite spinning element with no opt-out. Violates Motion & Accessibility. Same gap exists for `toast-in`/`sheet-up` keyframes in `base.css:129-156`, which the shell imports globally.
- **Location:** `apps/desktop/src/design/components/components.css:106`, `apps/desktop/src/design/base.css:123-156`
- **Exact fix:** append to `base.css`:

```css
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
    border-top-color: rgba(235, 235, 245, 0.25); /* static full ring */
  }
  .sheet,
  .toast,
  .sheet-backdrop {
    /* whatever classes consume these */
    animation-duration: 0.01ms !important;
  }
}
```

### [P1] — Restore state and decorative chrome are invisible/hostile to assistive tech

- **What/Why:** The cosmetic status bar (time + three SVG glyphs) is announced by screen readers as "10:47" plus three unlabeled graphics on every state change, while the actual loading state ("Restoring session…") is not announced at all because it's a plain `<div>` with a `<span>`. Violates Accessibility (labels, focus/announcement order, color-independent meaning).
- **Location:** `apps/desktop/src/design/components/StatusBar.tsx:20-28`, `apps/desktop/src/RootView.tsx:39-53`
- **Exact fix:** in `StatusBar.tsx:20`: `<div className="status-bar" aria-hidden="true">`. In `RootView.tsx:39`: add `role="status"` and `aria-live="polite"` to the checking-state wrapper div, and give the spinner `aria-hidden="true"` (the text label carries the meaning):

```tsx
<div role="status" aria-live="polite" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
```

### [P2] — Frame corner radius 24px is half the real device's ~47px

- **What/Why:** `.phone-frame { border-radius: 24px }` — an iPhone 14 Pro Max has a ~47.33pt continuous corner radius. In the screenshot the frame corners read as a generic rounded card, instantly breaking the "this is an iPhone" illusion the island/status bar work to create. Violates Platform Fidelity and Composition.
- **Location:** `apps/desktop/src/design/base.css:44`
- **Exact fix:** `border-radius: 47px;` (and if a bezel is added per the P3 below, the outer bezel gets `border-radius: 55px` ≈ 47 + 8px bezel).

### [P2] — Root-state transitions are hard cuts; no crossfade between checking → login → trade

- **What/Why:** `RootView.tsx:38-60` swaps entire screens instantly. iOS `RootView.swift` at minimum benefits from SwiftUI's default transitions; the lock overlay there explicitly uses `.transition(.opacity)` (`RootView.swift:76`). A 200ms opacity crossfade on state change is the difference between "web page" and "app." Violates Motion (120–250ms eased).
- **Location:** `apps/desktop/src/RootView.tsx:38-60`
- **Exact fix:** key the content wrapper by state and add a CSS transition:

```tsx
<div className="phone-content state-fade" key={state}>
```

```css
@keyframes state-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.state-fade {
  animation: state-fade-in 200ms ease-out;
}
```

### [P2] — Status bar clock polls every 10s and can lag the minute boundary

- **What/Why:** `setInterval(..., 10_000)` (`StatusBar.tsx:15`) fires on a 10s cadence unrelated to wall-clock minutes, so the displayed time can be up to 10 seconds stale — visibly wrong in a trading app whose users watch the clock. Violates Platform Fidelity (the real status bar is minute-accurate).
- **Location:** `apps/desktop/src/design/components/StatusBar.tsx:14-17`
- **Exact fix:** schedule to the next minute boundary:

```tsx
useEffect(() => {
  let interval: ReturnType<typeof setInterval>;
  const delay = 60_000 - (Date.now() % 60_000);
  const timeout = setTimeout(() => {
    setNow(new Date());
    interval = setInterval(() => setNow(new Date()), 60_000);
  }, delay);
  return () => {
    clearTimeout(timeout);
    clearInterval(interval);
  };
}, []);
```

### [P2] — Spinner is a border-arc, not an iOS-style indicator; track contrast 2.1:1 < 3:1

- **What/Why:** The CSS `border-top-color` arc (`components.css:104-106`) is a Material/web idiom; iOS `ProgressView` is a 12-tick radial spinner — the desktop clone's stated goal is fidelity to the SwiftUI app. Additionally the static track `rgba(235,235,245,0.25)` on `#0b0c10` computes to ≈ 2.1:1, below WCAG's 3:1 minimum for UI components. Violates Platform Fidelity + Color & Contrast.
- **Location:** `apps/desktop/src/design/components/components.css:101-112`
- **Exact fix:** raise the track to `rgba(235, 235, 245, 0.35)` (≈ 2.9:1 — or `0.4` for ≈ 3.4:1, safely over) and, for iOS fidelity, render 12 ticks with staggered opacity:

```css
.spinner {
  border: none;
  background: conic-gradient(from 0deg, var(--label-secondary) 0%, rgba(235, 235, 245, 0.05) 100%);
  -webkit-mask: radial-gradient(
    farthest-side,
    transparent calc(100% - 2.5px),
    #000 calc(100% - 2px)
  );
  mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px));
  animation: spinner-rotate 0.8s linear infinite;
}
```

(gradient-fade ring reads far closer to iOS than a single colored arc; keep `.white` variant overriding the gradient stops with white.)

### [P2] — Status bar metrics are all magic numbers; time font off-token

- **What/Why:** Height 59px (real device: 54pt), padding `14px 28px 0`, time `16px/600/0.2px`, island `125×36 @ top:11`, glyphs `gap: 7px` (off the 4pt grid) — every number is inline in the stylesheet with no token, and 16px matches no `--fs-*` step. Violates Consistency (token system) and Composition (7px glyph gap breaks the grid).
- **Location:** `apps/desktop/src/design/components/components.css:4-37`
- **Exact fix:** add to `tokens.css`:

```css
--h-status-bar: 59px; /* or 54px to match device */
--w-island: 125px;
--h-island: 36px;
--w-home-indicator: 140px;
--h-home-indicator: 34px;
--fs-status-time: 16px;
```

and reference them; change `.status-bar .glyphs { gap: 8px; }`. If fidelity wins: set `--h-status-bar: 54px` and `--fs-status-time: 17px`.

### [P2] — Global `outline: none` on inputs with no `:focus-visible` replacement

- **What/Why:** `base.css:75` kills the focus ring on all inputs and nothing restores a visible focus indicator anywhere in the design layer, so keyboard users tabbing through the login form (rendered inside this shell) get zero focus feedback. Violates Accessibility (desktop: keyboard/focus) — shell-level CSS, ship-blocking for keyboard use.
- **Location:** `apps/desktop/src/design/base.css:71-77`
- **Exact fix:**

```css
input {
  outline: none;
}
input:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
}
```

### [P3] — Inline style block + magic `size={22}` in the checking state

- **What/Why:** `RootView.tsx:40-47` hardcodes a flex-centering layout inline and passes `size={22}` — 22px is off the 8pt grid and the layout duplicates what a `.centered-state` class would say once. Violates Consistency (no one-off styles).
- **Location:** `apps/desktop/src/RootView.tsx:39-53`, `apps/desktop/src/design/components/Spinner.tsx:6-8`
- **Exact fix:** add to `components.css`:

```css
.centered-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
```

use `<div className="centered-state" role="status" aria-live="polite">` and `<Spinner size={24} />` (on-grid).

### [P3] — Home-indicator and frame get no "device" treatment — flat border, no bezel

- **What/Why:** The frame is a 1px `--app-border` hairline on a black page. A subtle outer bezel (8–10px black ring + soft shadow) is what makes clones feel like hardware instead of a webpage with rounded corners — the "holy shit" detail Robinhood/TradingView-tier demos ship. Violates Platform Fidelity/delight.
- **Location:** `apps/desktop/src/design/base.css:38-48`
- **Exact fix:**

```css
.phone-frame {
  border: 1px solid var(--app-border);
  border-radius: 47px;
  box-shadow:
    0 0 0 8px #050506,
    0 24px 80px rgba(0, 0, 0, 0.8);
}
```

### [P3] — Island is a plain black pill; no sensor/camera dot

- **What/Why:** The real Dynamic Island has a subtle camera lens dot (dark blue-ish highlight, ~10px circle right of center). Current `.island` is a flat `#000` rect (`components.css:22-31`) — at 2× in the screenshot it reads as a void. Cheap fidelity win.
- **Location:** `apps/desktop/src/design/components/components.css:22-31`
- **Exact fix:**

```css
.status-bar .island::after {
  content: '';
  position: absolute;
  right: 22px;
  top: 50%;
  transform: translateY(-50%);
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #1a2436, #000 70%);
}
```

## Quick wins vs structural work

**Landable in <1 hour:**

- `aria-hidden` on `.status-bar`, `role="status"`/`aria-live` on the restore wrapper (Findings 3)
- `prefers-reduced-motion` media query block (Finding 2)
- Clock minute-boundary scheduling (Finding 6)
- Token definitions for shell metrics + `gap: 8px` + `.centered-state` class extraction (Findings 8, 10)
- `border-radius: 47px` + bezel box-shadow + island camera dot (Findings 4, 11, 12)
- `input:focus-visible` rule (Finding 9)
- Spinner track alpha bump to 0.4 (part of Finding 7)

**Needs refactor / design decision:**

- Timeout/escalation UX for session restore (Finding 1) — touches `authStore` semantics and needs a retry contract
- Keyed crossfade transitions between root states (Finding 5) — simple CSS but should be coordinated with sheet/toast animation timings app-wide
- iOS-style tick/gradient spinner (Finding 7) — visual redesign of a shared component used by buttons (`white` variant); verify all call sites
- Dynamic Type / zoom support — the fixed 430×932 transform-scale architecture ignores user font-size preferences entirely; a real fix means rem-based sizing and is a project-wide decision
