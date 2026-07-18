# Screen d4: Register
- **App:** Desktop (430×932 phone-frame clone of iOS `RegisterView.swift`)
- **Location:** `apps/desktop/src/features/auth/RegisterView.tsx` (whole file; key refs: validation `:15-21`, sheet body inline styles `:38-47`, fields `:49-76`, error `:78-88`, CTA `:90-96`); supporting: `apps/desktop/src/design/base.css:96-121` (`.field`, `.button-primary`), `apps/desktop/src/design/tokens.css:56-64`, `apps/desktop/src/design/components/Sheet.tsx`, `apps/desktop/src/design/components/components.css:89-92,115-149`
- **Visual:** screenshot `docs/ui-audit/shots/03-register.png` (860×1864 @2× — audited actual pixels)
- **Scores:** Composition 6/10 · Typography 7/10 · Color 6/10 · Density 6/10 · DataViz N/A · Motion 4/10 · States 5/10 · Platform 5/10 · A11y 3/10 · Consistency 6/10 → **Overall 53/100** (DataViz excluded — no data-viz surface on this screen; overall = 48/90 scaled)

## Score justifications
- **Composition 6:** Pixel-verified 24px side margins, full-width 45px fields, 50px CTA — rhythm is clean; but the form ends at ~40% of the 932px viewport and the remaining ~60% is dead black space with no footer anchor, brand mark, or helper content (shot: CTA bottom ≈ y754/1864).
- **Typography 7:** Correct iOS scale via tokens (nav title `--fs-headline`/600, fields `--fs-body`, error `--fs-footnote`, CTA headline 600) — but placeholders double as labels and there is zero hierarchy beyond that; no prices on screen so tabular-figure rule not exercised.
- **Color 6:** Token discipline is good and measured pairs pass AA (placeholder ≈6.0:1, error `#ff453a` on `#0b0c10` ≈5.6:1, Cancel `#568ff7` on surface ≈5.5:1); however the dimmed CTA renders at ≈2.8:1 text contrast (visible as muddy grey-on-blue in the shot) and the error is color-only with no icon.
- **Density 6:** Appropriately minimal for a form, but below the bar: no password-requirements hint, no terms/privacy footnote, no "already have an account?" recovery path — the emptiness reads unfinished, not intentional.
- **DataViz N/A:** No charts, axes, or price readouts on this screen; not scored.
- **Motion 4:** Sheet enter animation uses the iOS curve token (`--sheet-anim`, 300ms `cubic-bezier(0.32,0.72,0,1)`) — good; everything else is dead: no `:active` press state, no transition on the `.dimmed` opacity flip, no error entrance, no `prefers-reduced-motion` anywhere in the design system (grep-verified).
- **States 5:** Loading (spinner swaps label inside fixed-height button — no layout shift) and server error states exist; but client validation is invisible (message computed, never rendered), and there are no offline, success, or field-level error states.
- **Platform 5:** Escape + backdrop-click dismiss work (`Sheet.tsx:16-26`); but Enter only submits from the *third* field, there is no `<form>` element, no `:focus-visible`, no hover states, and no focus trap.
- **A11y 3:** No `<label>`/`aria-label` on any input, error not announced (no `role="alert"`), no `aria-invalid`, sheet has no `role="dialog"`/`aria-modal`, Cancel hit target is text-bounds-only (~21px tall vs 44px minimum), error conveyed by red alone.
- **Consistency 6:** Reuses `.field`, `.button-primary`, `NavBar`, `Sheet`, `Spinner`; but layout is inline `style={{}}` with magic gaps (20/14), and the error block is a verbatim copy-paste of `LoginView.tsx:63-73` instead of a shared component.

## Findings

### [P1] — Validation message is computed but never shown: the CTA silently refuses to enable
- **What/Why:** `validationMessage` (`RegisterView.tsx:15-21`) gates the disabled state but is never rendered — the comment on line 14 even admits it. With empty fields the user sees a dead-looking 2.8:1 button (the exact state in the screenshot) with zero explanation of *why* it won't enable. Violates State Coverage (actionable errors) and Information Density. This is the #1 friction point on the screen; iOS has the same bug (`RegisterView.swift:11-16`, message unused) but the bar is Robinhood, not self-parity.
- **Location:** `apps/desktop/src/features/auth/RegisterView.tsx:14-21` (and `:78-88` where it should render)
- **Exact fix:** Render the message as a live field hint between the field group and the server error, only after the user has interacted (track `touched` on blur). Replace lines 76-88 with:
  ```tsx
  </div>

  {touched && validationMessage ? (
    <div
      role="status"
      style={{
        fontSize: 'var(--fs-footnote)',
        color: 'var(--label-secondary)',
        textAlign: 'center',
      }}
    >
      {validationMessage}
    </div>
  ) : null}

  {errorMessage ? (
    <div
      role="alert"
      style={{
        fontSize: 'var(--fs-footnote)',
        color: 'var(--pnl-negative)',
        textAlign: 'center',
      }}
    >
      {errorMessage}
    </div>
  ) : null}
  ```
  Add `const [touched, setTouched] = useState(false);` and `onBlur={() => setTouched(true)}` on each input. Long-term, mirror the same change in `RegisterView.swift` (show the message as a `.footnote` caption under the fields once any field loses focus).

### [P1] — Inputs have no accessible names; error is never announced to screen readers
- **What/Why:** All three `<input>`s (`:49-75`) rely on `placeholder` as their only label — placeholders vanish on input and are unreliable as accessible names. The server-error div (`:79-87`) is plain text: no `role="alert"`, and inputs never get `aria-invalid`. Violates Accessibility (labels, live regions) and Color (color-only error meaning). WCAG 4.1.3 / 3.3.1 failures.
- **Location:** `apps/desktop/src/features/auth/RegisterView.tsx:49-88`
- **Exact fix:** Add attributes to each input (example for email, `:49-58`):
  ```tsx
  <input
    className="field"
    type="email"
    name="email"
    inputMode="email"
    placeholder="Email"
    aria-label="Email"
    aria-invalid={errorMessage ? true : undefined}
    autoComplete="email"
    ...
  />
  ```
  (`aria-label="Password"`, `aria-label="Confirm password"` on the other two.) Give the error container `role="alert"` as in P1-1's snippet. Prefix the error text with a non-color affordance: `<span aria-hidden="true">⚠ </span>` or an inline 12px SVG triangle so meaning is not red-only.

### [P1] — No visible keyboard focus anywhere: `outline: none` on inputs, zero `:focus-visible` rules in the entire design system
- **What/Why:** `base.css:74` sets `input { outline: none }` and a grep of `apps/desktop/src` finds exactly one state selector in the whole app (`.menu-item:active`) — no `:focus`, no `:focus-visible`, no `:hover`. On a *desktop* app, Tab-navigating this form is invisible. Violates Platform Fidelity (focus) and Accessibility (focus visible, WCAG 2.4.7).
- **Location:** `apps/desktop/src/design/base.css:71-77` (global input reset), `apps/desktop/src/design/base.css:96-103` (`.field`), `apps/desktop/src/design/components/components.css:89-92` (`.navbar-text-button`)
- **Exact fix:** Append to `base.css`:
  ```css
  .field:focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: 1px;
  }
  .button-primary:focus-visible,
  .navbar-text-button:focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: 2px;
    border-radius: var(--radius-chip);
  }
  ```

### [P1] — Enter key submits only from the Confirm field; no `<form>` element at all
- **What/Why:** `onKeyDown … Enter && submit()` exists only on the confirm-password input (`:74`). Pressing Enter in Email or Password does nothing — while `LoginView.tsx:50,59` submits from *both* fields, so the two auth screens even disagree with each other. Without a `<form>`, there is also no implicit submission, worse password-manager/1Password detection, and no mobile "Go" key semantics. Violates Platform Fidelity (keyboard) and Consistency.
- **Location:** `apps/desktop/src/features/auth/RegisterView.tsx:74` vs `apps/desktop/src/features/auth/LoginView.tsx:50,59`
- **Exact fix:** Wrap the fields + button in a form and delete the per-input key handler. Change the container at `:38-47` to:
  ```tsx
  <form
    className="sheet-body"
    style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: 'var(--pad-screen)', background: 'var(--app-background)' }}
    onSubmit={(event) => { event.preventDefault(); submit(); }}
    noValidate
  >
  ```
  change the CTA to `type="submit"` (`:90-96`), remove `onClick={submit}` and remove line 74, and close with `</form>` at `:97`.

### [P1] — Sheet is not a dialog: no `role="dialog"`, no focus trap, no initial focus
- **What/Why:** `Sheet.tsx:24-29` renders two plain divs. When Register opens, focus stays on the "Create an account" button *behind* the modal; Tab cycles through the obscured login form; screen readers get no modal announcement. Violates Platform Fidelity and Accessibility (WCAG 2.4.3 focus order).
- **Location:** `apps/desktop/src/design/components/Sheet.tsx:24-29`
- **Exact fix:** Minimal, no new dependency:
  ```tsx
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = panelRef.current?.querySelector<HTMLElement>('input, button');
    first?.focus();
  }, []);
  // in onKey: if (event.key === 'Tab') { /* wrap focus within panelRef
  //   by querying focusable elements and cycling first/last */ }
  ...
  <div className="sheet-backdrop" onClick={onDismiss} />
  <div ref={panelRef} className={`sheet-panel ${detent}`} role="dialog" aria-modal="true" aria-label="Create Account">
  ```
  (Pass the title in as an `ariaLabel` prop from `RegisterView.tsx:29` so the label isn't hardcoded.)

### [P2] — 14px field gap breaks the 8pt grid (iOS source has the same magic number)
- **What/Why:** `gap: 14` (`:48`) is not a multiple of 4 or 8; pixel-verified in the shot (~28px @2× between field boxes). The outer `gap: 20` (`:43`) is a 4pt multiple but also a magic inline number — there are no spacing tokens, so every screen invents its own. Violates Composition (8pt grid) and Consistency (token bypass). iOS twin: `RegisterView.swift:20-21` (`spacing: 20` / `spacing: 14`).
- **Location:** `apps/desktop/src/features/auth/RegisterView.tsx:43,48`; `apps/ios/0dteTrader/Features/Auth/RegisterView.swift:20-21`
- **Exact fix:** Add to `tokens.css`: `--space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px; --space-6: 24px;` then use `gap: var(--space-4)` (16px) for the field group and `gap: var(--space-6)` (24px) between the group and the CTA. On iOS, change the inner `VStack(spacing: 14)` to `VStack(spacing: 16)` to match.

### [P2] — Zero micro-interactions: no press state, instant opacity flip, no error entrance, no reduced-motion support
- **What/Why:** The CTA has no `:active` style, and `.button-primary.dimmed` (`base.css:119-121`) snaps opacity 1↔0.35 with no transition every time the user types a character that flips validity — a strobe-like state change on the screen's dominant element. The error text pops in with no animation, causing a 20px layout jump that shoves the CTA down (the error sits between fields and button in the flex column). No `prefers-reduced-motion` query exists anywhere. Violates Motion (120–250ms eased transitions, press states, reduced-motion).
- **Location:** `apps/desktop/src/design/base.css:106-121`, `apps/desktop/src/features/auth/RegisterView.tsx:78-88`
- **Exact fix:** In `base.css`:
  ```css
  .button-primary {
    transition: opacity 150ms ease-out, transform 80ms ease-out;
  }
  .button-primary:active:not(:disabled) { transform: scale(0.98); }
  .button-primary:hover:not(:disabled) { filter: brightness(1.08); }
  @media (prefers-reduced-motion: reduce) {
    .button-primary, .sheet-panel, .sheet-backdrop, .spinner { animation: none; transition: none; }
  }
  ```
  Reserve the error's space to kill the layout jump: give the error slot `minHeight: 18px` and render `{'\u00a0'}` when empty (or animate it in with a 150ms `toast-in`-style keyframe already in `base.css:129-138`).

### [P2] — Disabled CTA text renders at ≈2.8:1 contrast — the screenshot's default state looks broken, not disabled
- **What/Why:** `.dimmed { opacity: 0.35 }` (`base.css:119-121`) applies to the *whole* button, so the white label blends to ≈#71809a on ≈#253a61 over the background — measured ≈2.8:1. Disabled controls are WCAG-exempt, but this is the screen's *initial and most persistent* state (visible in the shot) and it reads as a rendering bug, not an affordance. Robinhood/Apple keep disabled labels legible. Violates Color & Contrast at the quality bar if not the letter of WCAG.
- **Location:** `apps/desktop/src/design/base.css:119-121`
- **Exact fix:** Dim the fill, not the text:
  ```css
  .button-primary.dimmed {
    opacity: 1;
    background: color-mix(in srgb, var(--app-accent) 35%, var(--app-background));
    color: rgba(255, 255, 255, 0.55);
  }
  ```
  (background ≈4.9:1 against the new label — legible but still clearly inert.)

### [P2] — ~60% of the sheet is dead space; no requirements hint, terms notice, or recovery link
- **What/Why:** The form ends at ~40% of viewport height (shot: CTA bottom ≈ y754 of 1864) and nothing anchors the bottom — no "Password must be 8+ characters" helper, no Terms/Privacy footnote (a register screen collecting credentials without one is also a compliance smell), no "Already have an account? Log in" path back. The void reads unfinished rather than intentionally minimal. Violates Composition (proportion) and Information Density (no secondary context tier).
- **Location:** `apps/desktop/src/features/auth/RegisterView.tsx:38-97`
- **Exact fix:** Before the closing container tag (`:97`), add a pinned footer:
  ```tsx
  <div style={{ flex: 1 }} />
  <p
    className="text-secondary"
    style={{ fontSize: 'var(--fs-caption)', textAlign: 'center', paddingBottom: 8 }}
  >
    By creating an account you agree to the Terms of Service and Privacy Policy.
  </p>
  ```
  and under the password field a persistent hint: `<span className="text-secondary" style={{ fontSize: 'var(--fs-caption)', paddingLeft: 4 }}>Minimum 8 characters</span>` — then shorten the password placeholder to `"Password"` so the requirement isn't buried in placeholder text.

### [P2] — Inline `style={{}}` layout + copy-pasted error block bypass the design system
- **What/Why:** The sheet body layout (`:40-46`) and error typography (`:80-84`) are inline one-offs; the error block is character-for-character identical to `LoginView.tsx:64-72` — two sources of truth for one component. Violates Consistency (no one-off styles).
- **Location:** `apps/desktop/src/features/auth/RegisterView.tsx:40-46,80-84`; duplicated at `apps/desktop/src/features/auth/LoginView.tsx:64-72`
- **Exact fix:** Add to `components.css`:
  ```css
  .form-error {
    font-size: var(--fs-footnote);
    color: var(--pnl-negative);
    text-align: center;
    min-height: 18px;
  }
  ```
  use `<div className="form-error" role="alert">` in both views, and move the sheet-body flex layout to a `.sheet-form` class (`display:flex; flex-direction:column; gap:var(--space-6); padding:var(--pad-screen); background:var(--app-background);`).

### [P2] — No password visibility toggle on a double-masked register form
- **What/Why:** Two `SecureField` clones with no show/hide affordance is the single largest cause of register-form abandonment and of "Passwords do not match" frustration — the user cannot see *which* field is wrong. iOS HIG explicitly recommends a visibility toggle on password creation. Violates State Coverage (error recovery) and Platform Fidelity (SF Symbol `eye`/`eye.slash` on iOS).
- **Location:** `apps/desktop/src/features/auth/RegisterView.tsx:59-75` (iOS: `RegisterView.swift:31-41`)
- **Exact fix:** Add `const [showPassword, setShowPassword] = useState(false);`, wrap each password input in `position: relative` container, toggle `type={showPassword ? 'text' : 'password'}`, and add an absolutely-positioned trailing button: `<button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword(v => !v)} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 'var(--fs-caption)', color: 'var(--app-accent)' }}>{showPassword ? 'Hide' : 'Show'}</button>` (right padding on the input becomes `paddingRight: 56` via an inline override or a `.field-with-trailing` modifier).

### [P3] — NavBar band / sheet body color step with no hairline separator
- **What/Why:** The sheet panel paints `--app-surface` (#1a1c24, `components.css:128`), the NavBar inherits it, then the body overrides to `--app-background` (#0b0c10, `RegisterView.tsx:45`) — producing the visible two-tone band at y≈114 (@1×) in the shot with no 1px separator. iOS inline nav bars show a hairline. Minor, but it's the kind of edge Apple would never ship.
- **Location:** `apps/desktop/src/design/components/components.css:123-135` + `apps/desktop/src/features/auth/RegisterView.tsx:45`
- **Exact fix:** Add to `.navbar` in `components.css`: `border-bottom: 0.5px solid var(--app-border);` (0.5px reads as an iOS hairline at the 430px frame scale) — or drop the body's inline background override so the whole sheet stays `--app-surface` and fields switch to `--app-surface-elevated`.

### [P3] — "Cancel" hit target is text-bounds-only (~21px tall)
- **What/Why:** `.navbar-text-button` (`components.css:89-92`) has no padding or min-height, so the clickable area is the 17px-tall glyph run (~21px line box) against the 44px navbar — half the 44pt HIG minimum the clone is supposed to honor. Mouse users on desktop get a forgiving target only by accident of precision. Violates Platform Fidelity (≥44pt targets) / Accessibility (hit areas).
- **Location:** `apps/desktop/src/design/components/components.css:89-92`
- **Exact fix:**
  ```css
  .navbar-text-button {
    color: var(--app-accent);
    font-size: var(--fs-body);
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    padding: 0 4px;
    margin-left: -4px; /* keep visual alignment with 16px navbar padding */
  }
  ```

## Quick wins vs structural work

**Landable in <1 hour:**
- Render `validationMessage` with `role="status"` (P1-1) — ~10 lines.
- `aria-label` / `aria-invalid` / `role="alert"` / ⚠ prefix on inputs and error (P1-2).
- `:focus-visible` rules in `base.css` (P1-3).
- `gap` 14→16 via new `--space-*` tokens (P2-6) + matching iOS one-liner.
- `.button-primary` transition + `:active` scale + legible `.dimmed` restyle (P2-7 partial, P2-8).
- 44px min-height on `.navbar-text-button` (P3-13).
- Navbar hairline (P3-12).
- Terms footer + password hint text (P2-9, copy only).

**Needs refactor / cross-platform coordination:**
- `<form>` semantics unified across Login + Register (P1-4) — touches both views, needs regression pass on submit flows.
- Sheet dialog semantics: focus trap + initial focus + `ariaLabel` prop through `Sheet` (P1-5) — affects every sheet consumer.
- Shared `.form-error` / `.sheet-form` components deduplicating Login/Register (P2-10).
- Password visibility toggle (P2-11) — new local state + iOS `eye`/`eye.slash` parity work.
- Design-system-wide `prefers-reduced-motion` media query and spacing-token rollout (P2-6/P2-7) — token strategy decision, not a one-screen fix.
