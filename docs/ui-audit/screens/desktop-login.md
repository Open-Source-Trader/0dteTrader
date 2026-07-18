# Screen d3: Login
- **App:** Desktop
- **Location:** `apps/desktop/src/features/auth/LoginView.tsx` (whole file, 100 lines); styles in `apps/desktop/src/design/components/components.css:96-121` (`.field`, `.button-primary`, `.dimmed`, `.spinner`), `apps/desktop/src/design/base.css:58-103` (input/button reset), `apps/desktop/src/design/tokens.css:7-15,45-64`; logic `apps/desktop/src/features/auth/AuthStore.ts:74-86`; iOS parity reference `apps/ios/0dteTrader/Features/Auth/LoginView.swift`
- **Visual:** screenshot `docs/ui-audit/shots/02-login.png` (860×1864 = 430×932 @2x; all measurements below in logical px = image px ÷ 2)
- **Scores:** Composition 6/10 · Typography 7/10 · Color 5/10 · Density 7/10 · DataViz 10/10 · Motion 3/10 · States 5/10 · Platform 4/10 · A11y 3/10 · Consistency 6/10 → **Overall 56/100**
- **Score justifications:**
  - **Composition 6:** Centered single column is safe and the brand block lands at y≈342 of 932 (~37%, near the golden-ratio 38% line), but the inter-field `gap: 14` and header `gap: 6` break the 4pt grid, and ~330px of dead space top and bottom with no brand mark reads empty, not minimal.
  - **Typography 7:** Correct token scale (34/17/15/13) and clear hierarchy, but the 34px large title has no negative tracking (SF tightens at display sizes; system-ui on desktop needs it manual) and there is no brand wordmark treatment.
  - **Color 5:** Tokens used throughout and placeholder (5.7:1) / error text (5.2:1) pass AA, but white on `--app-accent` is 3.15:1 (needs 4.5:1 for 17px text) and the dimmed button drops its label to ~2:1.
  - **Density 7:** Appropriate for a login screen; primary action vs secondary context hierarchy is unambiguous. Not penalized for sparseness, but no biometric/forgot-password affordances means the density budget is wasted.
  - **DataViz 10:** No data visualization on this screen — nothing to fail.
  - **Motion 3:** Only the 0.8s spinner exists. Zero transitions on state changes (dimmed→enabled snaps instantly), no entrance choreography, no press states, no `prefers-reduced-motion` handling anywhere.
  - **States 5:** Loading (in-button spinner, no layout shift) and error (footnote red text) states exist and work, but the error's appearance recenters the whole column (layout jump), errors aren't announced to AT, and there is no offline/caps-lock/show-password coverage.
  - **Platform 4:** Enter-to-submit and cursor:pointer are right, but `outline: none` with no focus-visible replacement makes keyboard focus invisible, there are no hover states, no autofocus, and the "Create an account" hit area is ~18px tall.
  - **A11y 3:** Placeholder-only fields with no `<label>`/`aria-label`, no `<form>` semantics, no `aria-live` on errors, no `role="status"` on the spinner, no `aria-invalid` — the screen is essentially silent to VoiceOver/NVDA beyond placeholder text.
  - **Consistency 6:** Good reuse of `.field`/`.button-primary` and near-perfect iOS parity, but layout is inline `style={{}}` with magic numbers (24/6/14), error text styles are a one-off inline block, and the `.dimmed` implementation deviates from iOS (dims label, iOS dims background only).

## Findings

### [P1] — Primary button white text on `--app-accent` is 3.15:1, fails WCAG AA 4.5:1
- **What/Why:** `.button-primary` renders 17px/600 white text on `#568ff7`. Measured contrast = 1.05 / (0.283+0.05) ≈ **3.15:1**; 17px is below the 18.66px large-text threshold, so 4.5:1 is required. This is the single most-seen component state on the screen (the enabled Log In button). Violates Color&Contrast. Same flaw inherited from iOS (`LoginView.swift:65-66`), so fix both.
- **Location:** `apps/desktop/src/design/tokens.css:12`, `apps/desktop/src/design/components/components.css:106-117`
- **Exact fix:** Add a dedicated filled-button token with a darker accent, do not recolor text:
  ```css
  /* tokens.css */
  --app-accent-fill: #2f6fe4; /* white text on this = 4.65:1 */
  /* components.css .button-primary */
  background: var(--app-accent-fill);
  ```
  Keep `--app-accent: #568ff7` for text/tint uses where its 5.6:1 on `--app-background` already passes.

### [P1] — `.dimmed` dims the label too: ~2:1 text contrast and iOS parity break
- **What/Why:** `.button-primary.dimmed { opacity: 0.35 }` applies to the whole button, so the white label composites to ~`rgb(102,102,103)` on the dimmed blue ≈ **2.0:1** — the screenshot's "Log In" label is visibly muddy gray. iOS (`LoginView.swift:65`) dims only the *background* (`Color.appAccent.opacity(0.35)`) and keeps `.foregroundStyle(.white)` at full opacity. Violates Color&Contrast + Consistency/parity. Disabled-state exemption in WCAG doesn't rescue a parity bug users can see.
- **Location:** `apps/desktop/src/design/components/components.css:119-121`, used at `apps/desktop/src/features/auth/LoginView.tsx:76`
- **Exact fix:**
  ```css
  .button-primary.dimmed {
    opacity: 1;
    background: color-mix(in srgb, var(--app-accent-fill, #2f6fe4) 35%, transparent);
    color: rgba(255, 255, 255, 0.55);
  }
  ```

### [P1] — No accessible names, no `<form>` semantics, error not associated with fields
- **What/Why:** Both inputs are placeholder-only (`LoginView.tsx:41-60`): no `<label>`, no `aria-label`, so the accessible name evaporates once the user types and autofill/AT tooling degrades. No wrapping `<form>` means Enter handling is hand-rolled per input (line 50, 59), password managers get weaker signals, and the button has no `type="submit"`. The error `<div>` (line 63-73) is not linked via `aria-describedby`/`aria-invalid`. Violates Accessibility.
- **Location:** `apps/desktop/src/features/auth/LoginView.tsx:20-99`
- **Exact fix:**
  ```tsx
  <form style={{ /* same flex styles as current div, lines 22-31 */ }}
        onSubmit={(e) => { e.preventDefault(); submit(); }}>
    <input className="field" type="email" aria-label="Email" autoComplete="username"
           aria-invalid={!!errorMessage} aria-describedby={errorMessage ? 'login-error' : undefined} ... />
    <input className="field" type="password" aria-label="Password" autoComplete="current-password"
           aria-invalid={!!errorMessage} aria-describedby={errorMessage ? 'login-error' : undefined} ... />
    {errorMessage ? <div id="login-error" role="alert" ...>{errorMessage}</div> : null}
    <button type="submit" className={...} disabled={...}>...</button>
  </form>
  ```
  (Delete the two per-input `onKeyDown` handlers — form submit covers Enter. Note `autoComplete="username"` is the correct pairing with `current-password` for password managers.)

### [P1] — Keyboard focus is invisible: `outline: none` with no `:focus-visible` replacement
- **What/Why:** `base.css:71-77` strips `outline` from all inputs and `base.css:58-65` strips button chrome; nothing re-adds a focus ring. Tabbing through this screen (Email → Password → Log In → Create an account) produces zero visual feedback — a hard keyboard-a11y failure on a desktop app. Violates Platform Fidelity + Accessibility (WCAG 2.4.7).
- **Location:** `apps/desktop/src/design/base.css:58-77`
- **Exact fix:**
  ```css
  .field:focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: 2px;
  }
  button:focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: 2px;
    border-radius: var(--radius-button);
  }
  ```

### [P1] — Async state changes are silent to assistive tech
- **What/Why:** The error `<div>` (LoginView.tsx:63-73) has no live-region semantics, so a failed login announces nothing; the `<Spinner>` swap inside the button (line 80) removes the "Log In" label and gives AT a button containing an unnamed `<span>` — no `role="status"`, no `aria-busy`. Violates Accessibility + State Coverage.
- **Location:** `apps/desktop/src/features/auth/LoginView.tsx:63-81`, `apps/desktop/src/design/components/Spinner.tsx:6-8`
- **Exact fix:**
  ```tsx
  // LoginView.tsx:80
  {isLoading ? <Spinner white /> : 'Log In'}
  // → on the button itself:
  <button ... aria-busy={isLoading} aria-live="polite">
  // Spinner.tsx
  <span role="status" aria-label="Loading" className={...} style={...} />
  ```
  (`role="alert"` on the error div from the P1-3 fix covers error announcement.)

### [P2] — Error message appearance recenters the entire column (layout jump)
- **What/Why:** The root container uses `justifyContent: 'center'` (LoginView.tsx:27) and the error block is conditionally inserted in-flow (line 63). When an error appears, the whole stack — title, fields, button — shifts up ~19px (13px footnote + gap redistribution). On screen this reads as a jolt exactly at the moment the user made a mistake. Violates Motion + State Coverage.
- **Location:** `apps/desktop/src/features/auth/LoginView.tsx:27,63-73`
- **Exact fix:** Reserve the slot permanently:
  ```tsx
  <div id="login-error" role="alert"
       style={{ fontSize: 'var(--fs-footnote)', color: 'var(--pnl-negative)',
                textAlign: 'center', minHeight: 16,
                visibility: errorMessage ? 'visible' : 'hidden' }}>
    {errorMessage ?? '\u00A0'}
  </div>
  ```
  Render it unconditionally and drop the `{errorMessage ? ... : null}` conditional.

### [P2] — Zero motion design: state snaps, no entrance, no press states, no reduced-motion
- **What/Why:** Every state change on this screen is instant: dimmed→enabled opacity snap, spinner↔label swap, error pop. No `:active` press state on either button, no hover state, no entrance transition (Robinhood-grade would stagger-fade the brand block then fields ~120–200ms). The spinner's 0.8s infinite rotation (`components.css:101-107`) ignores `prefers-reduced-motion`. Violates Motion&Micro-interactions.
- **Location:** `apps/desktop/src/design/components/components.css:101-121`, `apps/desktop/src/features/auth/LoginView.tsx:20-99`
- **Exact fix:**
  ```css
  .button-primary { transition: background-color 150ms ease-out, opacity 150ms ease-out, transform 80ms ease-out; }
  .button-primary:active:not(:disabled) { transform: scale(0.98); }
  .field { transition: outline-color 150ms ease-out; }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation-duration: 1.6s; }
    .button-primary, .field { transition: none; }
  }
  ```
  And an entrance pass in `LoginView.tsx`: wrap the three sections with `style={{ animation: 'toast-in 250ms cubic-bezier(0.32,0.72,0,1) both', animationDelay: '0ms' | '60ms' | '120ms' }}` (reuses the existing `toast-in` keyframes, `base.css:129-138`).

### [P2] — Secondary action has a ~18px hit area and no hover feedback; no autofocus
- **What/Why:** "Create an account" is a bare text `<button>` (LoginView.tsx:83-95): its clickable box is the 15px line-height (~18px) — far under the 44px platform target the rest of the app honors (`--h-navbar: 44px`, `grouped-row` min-height 44). No `:hover` style exists for it. And on mount nothing focuses the email field, costing every returning user a click — friction the brief explicitly targets. Violates Platform Fidelity.
- **Location:** `apps/desktop/src/features/auth/LoginView.tsx:41-51,83-95`
- **Exact fix:**
  ```tsx
  // email input
  autoFocus
  // create-account button
  style={{ fontSize: 'var(--fs-subheadline)', color: 'var(--app-accent)',
          alignSelf: 'center', minHeight: 44, padding: '0 16px' }}
  ```
  ```css
  /* components.css */
  button:hover:not(:disabled) { filter: brightness(1.12); }
  ```

### [P2] — Magic numbers break the 4pt grid and bypass the token system
- **What/Why:** Per the audit context there are no spacing tokens, and this screen is a clean specimen: `gap: 24` / `gap: 6` / `gap: 14` inline (LoginView.tsx:28,33,40). `6` and `14` are off-grid (not multiples of 4); the error block's font/color/center styles are a one-off inline block (lines 64-69) duplicating what a `.text-error` class should own. Violates Consistency + Composition (rhythm).
- **Location:** `apps/desktop/src/features/auth/LoginView.tsx:22-31,33,40,64-69`
- **Exact fix:** `gap: 6` → `gap: 8` (header), `gap: 14` → `gap: 16` (field stack) — matches iOS closely enough at clone fidelity while restoring grid. Add to `tokens.css`: `--space-1: 4px; --space-2: 8px; --space-4: 16px; --space-6: 24px;` and reference them; move the error styles to `.text-error { font-size: var(--fs-footnote); color: var(--pnl-negative); text-align: center; }` in components.css. (Note: iOS uses the same 6/14 values at `LoginView.swift:18,26` — flag there too, fix both sides.)

### [P3] — No error recovery affordances: no "Forgot password", no offline-specific copy
- **What/Why:** `AuthStore.ts:82` surfaces whatever `errorMessage(error)` returns, and the UI offers no path forward — a user who forgot their password is dead-ended on the first screen of the app. A network failure shows a generic message with no retry guidance. Violates State Coverage (actionable errors).
- **Location:** `apps/desktop/src/features/auth/LoginView.tsx:83-95`, `apps/desktop/src/features/auth/AuthStore.ts:81-85`
- **Exact fix:** Add below "Create an account":
  ```tsx
  <button style={{ fontSize: 'var(--fs-footnote)', color: 'var(--label-secondary)',
                   alignSelf: 'center', minHeight: 44 }}
          onClick={() => store.requestPasswordReset(email.trim())}>
    Forgot password?
  </button>
  ```
  (Requires an API endpoint — structural work; at minimum ship the visible affordance wired to a "Contact support" alert.)

### [P3] — Brand block has no identity: no glyph, no display tracking, no delight
- **What/Why:** The entire top ~330px (35% of viewport, measured from the screenshot: title baseline at y≈342/932) is empty black above a plain system-ui "0dteTrader". At the Apple×Robinhood bar this is the cheapest "holy shit" real estate in the app — a wordmark/glyph with a subtle entrance is what separates a clone from a product. Also, 34px bold type with default letter-spacing looks loose; SF applies ≈-0.4px tracking at Large Title size automatically, system-ui does not. Violates Composition + Typography.
- **Location:** `apps/desktop/src/features/auth/LoginView.tsx:33-38`
- **Exact fix:**
  ```tsx
  <h1 style={{ fontSize: 'var(--fs-large-title)', fontWeight: 700, letterSpacing: '-0.4px' }}>
    0dteTrader
  </h1>
  ```
  Plus a 56×56 brand glyph (`border-radius: 14px`, `--app-accent` gradient) above the title inside the same centered stack.

### [P3] — Field height ~41px and no show/hide-password or caps-lock affordance
- **What/Why:** `.field` computes to 12+17+12 ≈ **41px tall** (screenshot confirms ≈45px incl. sub-pixel) — under the 44px comfortable target the app itself uses elsewhere. Password entry on a desktop clone offers no visibility toggle and no caps-lock warning, the two highest-value login UX details. Violates Platform Fidelity + State Coverage.
- **Location:** `apps/desktop/src/design/base.css:96-103`, `apps/desktop/src/features/auth/LoginView.tsx:52-60`
- **Exact fix:** `.field { padding: 13px 12px; }` (→ 43px, or `padding: 14px 12px` for a full 45px; keep radius 10). For the toggle, wrap the password input in a relative container and add:
  ```tsx
  <button type="button" aria-label={showPw ? 'Hide password' : 'Show password'}
          style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                   width: 32, height: 32, color: 'var(--label-secondary)' }}
          onClick={() => setShowPw(v => !v)}>{showPw ? 'Hide' : 'Show'}</button>
  ```

## Quick wins vs structural work

**Landable in <1 hour:**
- `.dimmed` fix via `color-mix` (P1-2) — one CSS rule.
- `:focus-visible` rings for `.field` and `button` (P1-4) — ~8 lines of CSS.
- `role="alert"` + reserved-height error slot (P1-5 partial, P2-6) — small TSX edit.
- `autoFocus`, 44px hit area + hover for "Create an account" (P2-8).
- Button/field transitions + `prefers-reduced-motion` block + `:active` scale (P2-7 CSS half).
- `letterSpacing: '-0.4px'` on the title (P3-11); `.field` padding bump (P3-12).
- Grid fixes `gap: 6→8`, `gap: 14→16` (P2-9 values only).

**Structural work:**
- `--app-accent-fill` token + propagating the darker fill everywhere `.button-primary`/`.trade-action-button` is used, including the iOS `Color.appAccent` button fill (P1-1) — cross-platform color decision.
- `<form>` refactor with labels, `aria-describedby` wiring, and matching changes in `RegisterView` (P1-3).
- Spacing token scale (`--space-*`) in tokens.css and a `.text-error` shared class, applied across features (P2-9).
- Password-reset endpoint + flow (P3-10).
- Brand glyph asset + entrance choreography system, ideally shared with Register/Disclaimer screens (P3-11, P2-7 entrance half).
