# Screen d15: Profile + Webull credentials form

- **App:** Desktop
- **Location:** `apps/desktop/src/features/profile/ProfileView.tsx` (sheet scaffold, sections 30–156, dialog 158–172), `apps/desktop/src/features/profile/WebullCredentialsForm.tsx` (inputs 12–41, save button 42–49), supporting: `apps/desktop/src/design/components/components.css:372-431`, `apps/desktop/src/design/base.css:71-81`, `apps/desktop/src/design/tokens.css`
- **Visual:** screenshot `docs/ui-audit/shots/09-profile.png` (860×1864 @2x = 430×932 verified)
- **Scores:** Composition 6/10 · Typography 6/10 · Color 5/10 · Density 6/10 · DataViz 10/10 · Motion 4/10 · States 5/10 · Platform 4/10 · A11y 3/10 · Consistency 7/10 → **Overall 56/100**
- **Score justifications:**
  - **Composition 6:** Correct iOS grouped-list rhythm (44px rows, 16px insets, cards on `--app-background`), but section gap is 22px (off 8pt grid), content ends at ~56% of the 932px viewport leaving ~44% dead space, and card separators run full-bleed instead of iOS's 16px leading inset.
  - **Typography 6:** Token type scale used correctly (`--fs-body` rows, `--fs-footnote` 13px headers/footer, 600-weight nav title); no tabular/mono figures needed (no prices). Fixed-scale frame means zero text-zoom accommodation; email renders at full 17px with no truncation plan.
  - **Color 5:** Fully token-driven (good), but measured contrast fails AA at 17px body size: destructive `#ff453a` on `#282b35` = **4.11:1** (< 4.5), accent `#568ff7` on `#282b35` = **4.44:1** (< 4.5), disabled Save at 0.4 opacity ≈ **1.82:1**.
  - **Density 6:** Appropriately low-density settings screen; primary actions vs. footnote context hierarchy is clear. Docked only because the "Configured" state wastes 3 rows where 2 would do.
  - **DataViz 10:** N/A — no charts, axes, or figures on this screen; nothing to fault.
  - **Motion 4:** Sheet uses the shared 300ms `cubic-bezier(0.32,0.72,0,1)` spring-analog (good), but there are zero `:hover`/`:active` press states on any interactive row and no `prefers-reduced-motion` handling anywhere in the design CSS.
  - **States 5:** Loading (spinner, not skeleton), empty ("Account details unavailable"), success, error, delete-confirm all exist — but the empty state is a dead end (no Retry), messages aren't announced to AT, and Log Out has no in-flight guard.
  - **Platform 4:** Global `outline: none` on inputs with no `:focus-visible` replacement, no `<form>` so Enter doesn't submit, no hover cursors/states, no keyboard affordances beyond native Tab.
  - **A11y 3:** Placeholder-only field labels (labels vanish once filled), no `aria-label`/`name`/`required` on inputs, success/error not in live regions, disabled state communicated by dimming alone, two AA contrast failures.
  - **Consistency 7:** Good reuse of `grouped-list`/`grouped-row`/`section-card` components and tokens; docked for 6 inline `style={{}}` bypasses, icon sizes 14 vs 15 for the same semantic role, and the iOS "Security" section being silently dropped.

## Findings

### [P1] — Credential fields are placeholder-only; labels vanish on input

- **What/Why:** All three `<input>`s use `placeholder` as the sole label (`App Key`, `App Secret`, `Account ID`). Once the user types or pastes, there is no on-screen way to tell which masked field is which — the screenshot's three identical rows become three identical bullet-fields. Violates Accessibility (WCAG 3.3.2 Labels or Instructions) and HIG form guidance; also fails the "verify what you pasted" need for long API secrets.
- **Location:** `apps/desktop/src/features/profile/WebullCredentialsForm.tsx:13-41`
- **Exact fix:** Give each row a persistent leading label matching the Email row pattern, and add an accessible name. Replace each input row (e.g. lines 12–21) with:
  ```tsx
  <div className="grouped-row">
    <label htmlFor="wb-app-key" style={{ width: 96, flex: 'none' }}>
      App Key
    </label>
    <input
      id="wb-app-key"
      name="appKey"
      type="password"
      placeholder="Required"
      autoComplete="off"
      spellCheck={false}
      required
      value={appKey}
      onChange={(event) => store.setField('appKey', event.target.value)}
    />
  </div>
  ```
  (repeat with `wb-app-secret`/`App Secret` and `wb-account-id`/`Account ID`, `name="appSecret"`/`name="accountId"`). The `96px` label column matches the widest label ("Account ID" ≈ 88px at 17px) rounded to the 8pt grid.

### [P1] — Zero visible keyboard focus; Enter does not submit the form

- **What/Why:** `base.css:74` sets `input { outline: none; }` and there is no `:focus`/`:focus-visible` rule anywhere in `apps/desktop/src/design` (grep for `:focus|focus-visible|hover` returns nothing). Keyboard users get no focus ring on inputs, buttons, or the nav "Done". The credential inputs are also not wrapped in a `<form>`, so pressing Enter does nothing — desktop users expect Enter = Save. Violates Platform Fidelity + Accessibility (WCAG 2.4.7 Focus Visible).
- **Location:** `apps/desktop/src/design/base.css:71-77`, `apps/desktop/src/features/profile/WebullCredentialsForm.tsx:10-50`
- **Exact fix:** Add to `apps/desktop/src/design/components/components.css` (after line 431):
  ```css
  .grouped-row input:focus-visible,
  .grouped-row.button-row:focus-visible,
  .grouped-row.destructive:focus-visible,
  .navbar-text-button:focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: -2px;
    border-radius: 4px;
  }
  ```
  And wrap the fragment in `WebullCredentialsForm.tsx:11-50` in a form:
  ```tsx
  <form
    onSubmit={(event) => {
      event.preventDefault();
      if (canSave) void store.saveCredentials();
    }}
  >
    {/* rows… */}
    <button type="submit" className="grouped-row button-row" disabled={!canSave} …>
  </form>
  ```
  CSS: `form { display: contents; }` to avoid disturbing the card layout.

### [P1] — Destructive red and accent blue fail WCAG AA on the card surface

- **What/Why:** Measured against `--app-surface-elevated` `#282b35` (L≈0.025): `--pnl-negative` `#ff453a` → **4.11:1** and `--app-accent` `#568ff7` → **4.44:1**, both below the 4.5:1 required for 17px regular-weight text. Affects "Log Out", "Delete Credentials", "Update Credentials", "Save Credentials", "Cancel Update" (screenshot rows 4 and 8–10). Violates Color&Contrast (WCAG 1.4.3).
- **Location:** `apps/desktop/src/design/tokens.css:12,15`; consumed at `apps/desktop/src/design/components/components.css:420-426`
- **Exact fix:** Add elevated-surface variants in `tokens.css` (after line 15) and use them in the two rules:
  ```css
  --app-accent-on-elevated: #8fb0fa; /* 6.5:1 on #282b35 */
  --pnl-negative-on-elevated: #ff6b62; /* 5.0:1 on #282b35 */
  ```
  ```css
  .grouped-row.button-row {
    color: var(--app-accent-on-elevated);
  }
  .grouped-row.destructive {
    color: var(--pnl-negative-on-elevated);
  }
  ```
  Keep the base tokens for use on `--app-background` (accent is 6.0:1 there — the nav "Done" is fine).

### [P1] — Error/empty states are dead ends and silent to assistive tech

- **What/Why:** "Account details unavailable" (`ProfileView.tsx:74`) offers no recovery — the user must dismiss the sheet and reopen it. `errorMessage`/`successMessage` rows (`ProfileView.tsx:120-135`) render as plain divs: no `role="alert"`/`role="status"`, no icon, so screen readers never announce a failed save and sighted users get an unmarked red line. Loading (`ProfileView.tsx:70-72`) is a lone 16px spinner instead of a skeleton row that preserves layout. Violates State Coverage + Accessibility (WCAG 4.1.3 Status Messages).
- **Location:** `apps/desktop/src/features/profile/ProfileView.tsx:69-75,120-135`
- **Exact fix:**
  ```tsx
  // Loading (replace lines 69-72):
  <div className="grouped-row" aria-busy="true">
    <span className="skeleton" style={{ width: 56, height: 17 }} />
    <span className="skeleton row-value" style={{ width: 180, height: 17 }} />
  </div>
  // Empty (replace line 74):
  <>
    <div className="grouped-row text-secondary">Account details unavailable</div>
    <button className="grouped-row button-row" onClick={() => void store.load()}>Retry</button>
  </>
  // Messages (lines 120-135): add roles + icons
  <div className="grouped-row" role="status" style={{ color: 'var(--pnl-positive)', fontSize: 'var(--fs-footnote)' }}>
    <CheckCircleFillIcon size={14} />{state.successMessage}
  </div>
  <div className="grouped-row" role="alert" style={{ color: 'var(--pnl-negative-on-elevated)', fontSize: 'var(--fs-footnote)' }}>
    <WarningFillIcon size={14} />{state.errorMessage}
  </div>
  ```
  Plus a shared `.skeleton { background: var(--app-surface-elevated); border-radius: 4px; animation: none; }` (shimmer optional at 1.2s ease-in-out) in `components.css`.

### [P1] — No hover or press states on any interactive row

- **What/Why:** `.grouped-row.button-row` and `.grouped-row.destructive` have no `:hover`/`:active` rules (verified: zero `:hover` matches in `apps/desktop/src/design`). On a desktop clone this makes every button feel dead — Robinhood/Apple-tier polish requires immediate press feedback (100–150ms). Violates Motion&Micro-interactions + Platform Fidelity.
- **Location:** `apps/desktop/src/design/components/components.css:420-426`
- **Exact fix:**
  ```css
  .grouped-row.button-row,
  .grouped-row.destructive {
    transition: background-color 120ms ease-out;
    cursor: pointer;
  }
  .grouped-row.button-row:hover,
  .grouped-row.destructive:hover {
    background: rgba(235, 235, 245, 0.06);
  }
  .grouped-row.button-row:active,
  .grouped-row.destructive:active {
    background: rgba(235, 235, 245, 0.12);
  }
  .grouped-row.button-row:disabled {
    cursor: default;
  }
  @media (prefers-reduced-motion: reduce) {
    .sheet-panel,
    .sheet-backdrop,
    .alert-backdrop,
    .toast {
      animation-duration: 1ms;
    }
    .grouped-row.button-row,
    .grouped-row.destructive {
      transition: none;
    }
  }
  ```

### [P2] — Six inline `style={{}}` bypasses of the token/component system

- **What/Why:** Inline styles hardcode layout and typography decisions the design system should own: the sheet container flex/background (`ProfileView.tsx:31-39`), `fontSize: 'var(--fs-footnote)'` on 4 rows (`:62,91,123,131`), `color` overrides (`:85,123,131`), and the disabled-opacity hack (`WebullCredentialsForm.tsx:44`). These are exactly the one-off styles that drift out of sync — e.g. line 131's red won't pick up the contrast fix in P1 above. Violates Consistency.
- **Location:** `apps/desktop/src/features/profile/ProfileView.tsx:31-39,62,85,91,123,131`; `WebullCredentialsForm.tsx:44`
- **Exact fix:** Add semantic classes to `components.css`:
  ```css
  .sheet-content {
    background: var(--app-background);
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .grouped-row.footnote {
    font-size: var(--fs-footnote);
  }
  .grouped-row.positive {
    color: var(--pnl-positive);
  }
  .grouped-row.negative {
    color: var(--pnl-negative-on-elevated);
  }
  .grouped-row.button-row:disabled {
    opacity: 0.4;
  }
  ```
  Then `className="grouped-row footnote negative"` etc., and delete the inline `style={{ opacity: … }}` in the form (the `:disabled` rule handles it).

### [P2] — Section rhythm breaks the 8pt grid; separators full-bleed

- **What/Why:** `.grouped-list` uses `gap: 22px` (not a multiple of 4's grid peer values used elsewhere: 12/16/24), `.section-header` uses `padding-bottom: 6px`, and `.grouped-row` uses `gap: 10px` — off the 8pt rhythm. Card separators (`border-top` on `.grouped-row + .grouped-row`, line 411-413) run edge-to-edge; iOS grouped lists inset the separator 16px from the leading edge, which is visible in the screenshot between "App Key"/"App Secret"/"Account ID". Violates Composition (grid discipline).
- **Location:** `apps/desktop/src/design/components/components.css:373-378,380-386,400-413`
- **Exact fix:**
  ```css
  .grouped-list { padding: 12px 16px 24px; display: flex; flex-direction: column; gap: 24px; }
  .grouped-section .section-header { … padding: 0 16px 8px; }
  .grouped-row { … gap: 8px; }
  /* inset separators */
  .grouped-row + .grouped-row { border-top: none; box-shadow: inset 0 0.5px 0 0 var(--app-border); margin-left: 0; }
  /* simpler faithful alternative: keep border-top but inset via background line: */
  .grouped-row + .grouped-row { border-top: none; background-image: linear-gradient(var(--app-border), var(--app-border)); background-size: calc(100% - 16px) 0.5px; background-position: 16px 0; background-repeat: no-repeat; }
  ```

### [P2] — Email value has no truncation; long addresses will break the row

- **What/Why:** `.row-value` (`components.css:415-418`) has `margin-left: auto` but no `overflow` handling. The audit email `audit-1784342866384@example.com` already spans ~78% of the 398px content width (visible in the screenshot, nearly touching the 16px inset); a longer address wraps or clips mid-glyph. Violates Composition/Typography (density without breakage).
- **Location:** `apps/desktop/src/design/components/components.css:415-418`, usage `ProfileView.tsx:56-58`
- **Exact fix:**
  ```css
  .grouped-row .row-value {
    margin-left: auto;
    color: var(--label-secondary);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl; /* keeps the domain visible, truncates the local part */
  }
  ```
  and add `title={state.me.email}` on the span in `ProfileView.tsx:57` for hover reveal.

### [P2] — No way to verify masked secrets; paste-only workflow unsupported

- **What/Why:** Webull app secrets are long random strings. Three `type="password"` fields with no reveal toggle and `autoComplete="off"` (which also blocks password-manager fill) means the user pastes blind and cannot confirm what was pasted before saving — the #1 cause of "credentials don't work" support tickets. Violates State Coverage (verification affordance) and Platform Fidelity.
- **Location:** `apps/desktop/src/features/profile/WebullCredentialsForm.tsx:14,24,34`
- **Exact fix:** Add a per-form reveal toggle (one control for all three fields is enough):
  ```tsx
  const [reveal, setReveal] = useState(false);
  // each input: type={reveal ? 'text' : 'password'}
  // trailing row before the Save button:
  <button
    type="button"
    className="grouped-row button-row footnote"
    onClick={() => setReveal((v) => !v)}
  >
    {reveal ? 'Hide values' : 'Show values'}
  </button>;
  ```
  Keep `autoComplete="off"` (correct for API keys) and use `--font-mono` at `--fs-subheadline` on the inputs when `reveal` is true so pasted keys are distinguishable (`0/O`, `l/1`).

### [P2] — Log Out has no confirmation and no in-flight guard

- **What/Why:** `onClick={() => { void onLogout().then(onDismiss); }}` fires immediately — contrast with Delete Credentials, which correctly gets an `AlertDialog`. A mis-tap on a 44px row logs the user out of a trading app; double-taps double-fire the request. Violates State Coverage.
- **Location:** `apps/desktop/src/features/profile/ProfileView.tsx:146-153`
- **Exact fix:** Reuse the existing `AlertDialog` pattern (lines 158-172):
  ```tsx
  const [showLogoutConfirmation, setShowLogoutConfirmation] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  // button:
  <button
    className="grouped-row destructive"
    disabled={isLoggingOut}
    onClick={() => setShowLogoutConfirmation(true)}
  >
    {isLoggingOut ? <Spinner size={14} /> : 'Log Out'}
  </button>;
  // dialog:
  {
    showLogoutConfirmation ? (
      <AlertDialog
        title="Log out of 0dteTrader?"
        message="Open positions are unaffected; live quotes will stop."
        actions={[
          {
            label: 'Log Out',
            role: 'destructive',
            onSelect: () => {
              setIsLoggingOut(true);
              void onLogout().then(onDismiss);
            },
          },
          { label: 'Cancel', role: 'cancel' },
        ]}
        onDismiss={() => setShowLogoutConfirmation(false)}
      />
    ) : null;
  }
  ```

### [P2] — Delete confirmation uses a centered alert; iOS uses an action sheet

- **What/Why:** iOS (`ProfileView.swift:26-37`) presents `.confirmationDialog` (bottom action sheet); the desktop clone renders the centered `AlertDialog`. The clone's stated job is pixel-parity with iOS, and destructive confirmations anchored to the bottom sheet read differently. Violates Consistency/Platform Fidelity (parity).
- **Location:** `apps/desktop/src/features/profile/ProfileView.tsx:158-172` vs `apps/ios/0dteTrader/Features/Profile/ProfileView.swift:26-37`
- **Exact fix:** Either build a bottom-anchored `ConfirmationDialog` component (sheet-panel, `detent`-less, actions stacked full-width with `border-radius: 14px`, cancel separated by an 8px gap) and use it here, or document `AlertDialog` as the deliberate desktop substitution in `docs/ARCHITECTURE.md`. No visual change ships without one of the two.

### [P3] — Same-role icons sized 14px vs 15px

- **What/Why:** `CheckCircleFillIcon size={15}` ("Configured", line 86) vs `WarningFillIcon size={14}` (kill-switch warning, line 64) — both are status glyphs at row-leading position in footnote/body rows; the 1px difference is invisible individually but compounds across screens. Violates Consistency.
- **Location:** `apps/desktop/src/features/profile/ProfileView.tsx:64,86`
- **Exact fix:** Standardize on 14px for in-row status icons: change line 86 to `<CheckCircleFillIcon size={14} />` (and add a code comment or an `ICON_SIZE_ROW_STATUS = 14` const in `design/icons` if the codebase wants it named).

### [P3] — Magic numbers: spinner sizes 14/16, opacity 0.4

- **What/Why:** `Spinner size={16}` (ProfileView.tsx:71), `Spinner size={14}` (:103, WebullCredentialsForm.tsx:48), `opacity: 0.4` (WebullCredentialsForm.tsx:44) — no tokens exist for these; each new screen invents its own. `tokens.css` already centralizes geometry (`--h-button`, `--radius-*`); these belong there. Violates Consistency.
- **Location:** `apps/desktop/src/features/profile/ProfileView.tsx:71,103`; `apps/desktop/src/features/profile/WebullCredentialsForm.tsx:44,48`
- **Exact fix:** Add to `tokens.css` line 65 area: `--spinner-inline: 14px; --spinner-row: 16px; --opacity-disabled: 0.4;` and update `Spinner` to accept `size="inline" | "row"` mapping to those vars (or pass `size={14}` via a named constant). Use `var(--opacity-disabled)` in the `.grouped-row.button-row:disabled` rule from the P2 inline-style fix.

### [P3] — iOS "Security" section (Face ID) silently dropped

- **What/Why:** iOS shows a `Security` section between Webull API and Session (`ProfileView.swift:102-106`); desktop omits it entirely. Face ID is legitimately unavailable on desktop, but the parity contract is unspoken — a future auditor/teammate can't tell omission from oversight. Violates Consistency (documented parity).
- **Location:** `apps/desktop/src/features/profile/ProfileView.tsx:143-155` vs `apps/ios/0dteTrader/Features/Profile/ProfileView.swift:102-106`
- **Exact fix:** Add a comment above the Session section: `{/* Security section intentionally omitted: Face ID / AppLockManager is iOS-only (ProfileView.swift securitySection). */}` — or render a disabled `Security` card with `text-secondary` footnote "App lock is available in the iOS app" if visual parity is preferred.

## Quick wins vs structural work

**< 1 hour (single-file edits):**

- Add `:focus-visible` rings + wrap the credential inputs in a `<form>` with Enter-to-submit (P1).
- Add `:hover`/`:active`/transition rules to `.grouped-row.button-row`/`.destructive` (P1).
- Add `--app-accent-on-elevated` / `--pnl-negative-on-elevated` tokens and swap the two color rules (P1).
- Add `role="status"`/`role="alert"` + icons to the message rows; add a Retry row to the empty state (P1).
- `.row-value` ellipsis + `title` attribute (P2).
- Log Out confirmation dialog + disabled-in-flight state (P2).
- Icon size 15→14 unification; security-section parity comment (P3).

**Structural (refactors / cross-cutting):**

- Replace inline `style={{}}` with semantic `.grouped-row.*` modifier classes and a disabled-opacity token — touches the design system and every consumer of `grouped-row` (P2/P3).
- 8pt-grid correction of `.grouped-list` gap (22→24px) + inset separators — changes every grouped-list screen, needs visual regression pass on all sheets (P2).
- Skeleton loading component (`skeleton` class + reduced-motion-aware shimmer) replacing spinner-only loading across sheets (P1, shared).
- `ConfirmationDialog` bottom action-sheet component for iOS parity, replacing centered `AlertDialog` for destructive confirms (P2).
- Reveal-toggle + mono-font verification mode for secret inputs, ideally as a reusable `SecretField` design component (P2).
