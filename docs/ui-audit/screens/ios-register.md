# Screen i4: Register

- **App:** iOS
- **Location:** `apps/ios/0dteTrader/Features/Auth/RegisterView.swift` (whole file, 88 lines; key refs: fields L22–41, error L44–49, CTA L51–74, layout L20/76/78); cross-refs `LoginView.swift:81` (scrollDismissesKeyboard), `DesignSystem/AppColors.swift:53-59` (appAccent), `AuthViewModel.swift:91-105` (error/loading states)
- **Visual:** screenshot `docs/ui-audit/shots/03-register.png` (desktop clone, 430×932 pt @2x, dark theme) — audited actual pixels; iOS render UNVERIFIED-VISUAL (no macOS/Xcode), but clone is a 1:1 code port and measurements match the SwiftUI values (24pt page padding, ~46pt fields, ~52pt CTA)
- **Scores:** Composition 4/10 · Typography 6/10 · Color 5/10 · Density 6/10 · DataViz 5/10 · Motion 2/10 · States 4/10 · Platform 6/10 · A11y 4/10 · Consistency 6/10 → **Overall 48/100**
- **Score justifications:**
  - Composition 4 — clean left alignment and consistent 24pt margins, but content ends at ~380pt of 932pt (41% of viewport; bottom 59% is dead black), top-loaded with no golden-ratio balance (~62/38 would put the CTA near the 2/3 line or center the block).
  - Typography 6 — Dynamic Type-friendly system styles (`.headline` CTA, `.footnote` error) and inline nav title are correct, but password rules live in a placeholder, and the wordmark/hierarchy present on Login (`largeTitle.bold()` + subheadline, LoginView.swift:19-23) is dropped here.
  - Color 5 — semantic surface tokens used correctly (appSurface fields on appBackground), but white `.headline` on appAccent #568FF7 = 3.15:1, below WCAG AA 4.5:1; error text misuses the P&L token `pnlNegative`.
  - Density 6 — appropriately sparse for a form, nothing superfluous, but missing _useful_ secondary info: inline validation hints, persistent password rule caption, terms/privacy link.
  - DataViz 5 — no charts on this screen (axis/gridline criteria N/A); loading affordance is a bare `ProgressView` spinner with no label, below the skeleton/branded-loading bar.
  - Motion 2 — zero animation anywhere: error text pops, CTA background snaps between enabled/disabled, `.buttonStyle(.plain)` gives no pressed state, no haptics. Nothing eased 120–250ms, no springs.
  - States 4 — loading (spinner + disabled) and server error are handled, but client validation messages are computed and never shown, no offline-specific state, no success feedback, sheet dismissible mid-request.
  - Platform 6 — proper sheet + nav bar + Cancel, correct `.emailAddress` keyboard, `.newPassword` content types, fields ~46pt and CTA 50pt ≥ 44pt HIG minimum; missing FocusState/submit labels, keyboard-dismiss affordance, and dismiss-guard during loading.
  - A11y 4 — placeholder-only labels vanish on typing, error is color-only red text with no icon or VoiceOver announcement, disabled CTA unexplained to assistive tech.
  - Consistency 6 — field/CTA styling matches LoginView exactly (good visual rhythm, but copy-pasted, not a shared component); spacing 14pt breaks the 4pt grid; every dimension is an inline magic number.

## Findings

### [P1] — Client-side validation messages are computed but never rendered; CTA is silently disabled

- **What/Why:** `validationMessage` (RegisterView.swift:11-16) produces "Enter a valid email address.", "Password must be at least 8 characters.", "Passwords do not match." — none of these strings ever appear in the view tree. The Create Account button is simply disabled (L74) with zero explanation. On first paint the screen shows a dead, dimmed CTA and the user must guess why. Violates State Coverage and Accessibility; for a signup screen this is conversion-blocking friction — the exact opposite of the "zero friction" bar.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RegisterView.swift:11-16` (dead-for-display strings), `:44-49` (only renders `viewModel.errorMessage`), `:74` (silent `.disabled`)
- **Exact fix:** render the message above the CTA, replacing the error block at L44-49:
  ```swift
  if let message = viewModel.errorMessage ?? validationMessage {
      Label(message, systemImage: "exclamationmark.circle.fill")
          .font(.footnote)
          .foregroundStyle(Color.sellRed)
          .multilineTextAlignment(.center)
          .transition(.opacity.combined(with: .move(edge: .top)))
  }
  ```
  and add to the outer VStack (L20): `.animation(.snappy(duration: 0.2), value: viewModel.errorMessage ?? validationMessage)`. Only show validation after the user has interacted: gate with `@State private var attemptedSubmit = false` set true in the button action, displaying `attemptedSubmit ? (viewModel.errorMessage ?? validationMessage) : viewModel.errorMessage` — or simpler, show the email rule only once `!email.isEmpty`, the password rule once `!password.isEmpty`, the mismatch rule once `!confirmPassword.isEmpty`.

### [P1] — White CTA label on appAccent is 3.15:1 contrast, fails WCAG AA 4.5:1

- **What/Why:** appAccent dark variant is (0.337, 0.561, 0.969) = #568FF7 (AppColors.swift:54-58); relative luminance ≈ 0.283 → white-on-accent contrast = 1.05/0.333 ≈ **3.15:1**, failing AA 4.5:1 for 17pt semibold (`.headline`) text. Violates Color & Contrast. (The disabled 0.35-opacity state over appBackground #0B0C10 lands ~11:1 and passes — the _enabled_ state is the failure.)
- **Location:** `apps/ios/0dteTrader/Features/Auth/RegisterView.swift:69-70`; token at `apps/ios/0dteTrader/DesignSystem/AppColors.swift:53-59`
- **Exact fix:** add a fill-specific token to AppColors.swift and use it for filled buttons:
  ```swift
  /// Accent darkened so white text on it meets WCAG AA 4.5:1 (≈6.3:1).
  static let appAccentFill = Color(uiColor: UIColor { traits in
      traits.userInterfaceStyle == .dark
          ? UIColor(red: 0.169, green: 0.349, blue: 0.765, alpha: 1) // #2B59C3
          : UIColor(red: 0.192, green: 0.427, blue: 0.878, alpha: 1) // existing light accent, 4.77:1
  })
  ```
  then L69 becomes `.background(validationMessage == nil ? Color.appAccentFill : Color.appAccentFill.opacity(0.35))`. Apply the same token in LoginView.swift:65.

### [P1] — Zero motion: no press state, no transitions, no haptics

- **What/Why:** `.buttonStyle(.plain)` (L73) gives no touch-down feedback at all — no opacity, no scale; the error text appears/disappears instantly (L44-49); the CTA background snaps between full and 0.35 opacity with no interpolation (L69). Violates Motion & Micro-interactions (bar: 120–250ms eased, springs, haptics on iOS). This is the single biggest "Robinhood delight" gap on the screen.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RegisterView.swift:44-49, 51-74`
- **Exact fix:**
  1. Replace `.buttonStyle(.plain)` (L73) with a pressed-scale style:
     ```swift
     struct ScaleButtonStyle: ButtonStyle {
         func makeBody(configuration: Configuration) -> some View {
             configuration.label
                 .scaleEffect(configuration.isPressed ? 0.97 : 1)
                 .opacity(configuration.isPressed ? 0.9 : 1)
                 .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
         }
     }
     // L73: .buttonStyle(ScaleButtonStyle())
     ```
  2. Animate the enabled/disabled fill: add `.animation(.easeOut(duration: 0.15), value: validationMessage == nil)` after L71.
  3. Haptic on server error — in the button action after `await viewModel.register(...)`:
     ```swift
     if viewModel.errorMessage != nil {
         UINotificationFeedbackGenerator().notificationOccurred(.error)
     }
     ```

### [P1] — Sheet is swipe-dismissible while registration is in flight

- **What/Why:** RegisterView is presented as a sheet (LoginView.swift:82-84) with no dismiss guard; the user can drag it down — or tap Cancel (L82-84) — mid-network-call, while `AuthViewModel.authenticate` (AuthViewModel.swift:91-105) completes underneath them and flips global state to `.authenticated`. Violates State Coverage and Platform Fidelity.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RegisterView.swift:81-85` (toolbar), presented from `LoginView.swift:82-84`
- **Exact fix:** add at the NavigationStack level (after L86): `.interactiveDismissDisabled(viewModel.isLoading)`, and disable Cancel: `Button("Cancel") { dismiss() }.disabled(viewModel.isLoading)` (L83).

### [P1] — No keyboard navigation or dismissal; confirm field can hide behind the keyboard

- **What/Why:** No `@FocusState`, no `.submitLabel` chaining (Next/Go), no `onSubmit`, and no `.scrollDismissesKeyboard` — LoginView has it (LoginView.swift:81) but RegisterView doesn't, an inconsistency. With the iOS keyboard up (~336pt on a 932pt screen), the confirm field at ~510–600px/2 ≈ 255–300pt is covered when the software keyboard shows suggestions/Password AutoFill bar. Violates Platform Fidelity and Motion (keyboard flow).
- **Location:** `apps/ios/0dteTrader/Features/Auth/RegisterView.swift:22-41` (fields), `:18-86` (no scroll wrapper)
- **Exact fix:**
  ```swift
  enum Field: Hashable { case email, password, confirm }
  @FocusState private var focusedField: Field?
  ```
  Add to email field (L26): `.focused($focusedField, equals: .email).submitLabel(.next).onSubmit { focusedField = .password }`; password (L32): `.focused($focusedField, equals: .password).submitLabel(.next).onSubmit { focusedField = .confirm }`; confirm (L38): `.focused($focusedField, equals: .confirm).submitLabel(.go).onSubmit { if validationMessage == nil { Task { await viewModel.register(email: email.trimmingCharacters(in: .whitespaces), password: password) } } }`. Add `.scrollDismissesKeyboard(.interactively)` to the outer VStack content wrapped in a `ScrollView { ... }` (replace L20 VStack container), matching LoginView.swift:81.

### [P1] — Hardcoded spacing/radius/height everywhere; 14pt field spacing breaks the 4pt grid

- **What/Why:** No spacing/radius/motion tokens exist in the design system, and this screen inlines every value: VStack spacing 20 (L20 — not an 8pt multiple), field-stack spacing 14 (L21 — **not a 4pt multiple**, breaks the grid), padding 12 (L27/33/39), cornerRadius 10 (L29/35/41), minHeight 50 (L68), cornerRadius 12 (L71), page padding 24 (L78). Violates Consistency and Composition (off-grid rhythm); any global spacing change requires editing N screens by hand.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RegisterView.swift:20-21, 27-41, 68, 71, 78`
- **Exact fix:** create `apps/ios/0dteTrader/DesignSystem/AppSpacing.swift`:
  ```swift
  enum AppSpacing {
      static let xs: CGFloat = 4, sm: CGFloat = 8, md: CGFloat = 12
      static let lg: CGFloat = 16, xl: CGFloat = 24
      static let fieldRadius: CGFloat = 10
      static let buttonRadius: CGFloat = 12
      static let buttonHeight: CGFloat = 50
  }
  ```
  and apply: L20 `VStack(spacing: AppSpacing.xl)`, L21 `VStack(spacing: AppSpacing.md)` (14→12, restores 4pt grid), L27/33/39 `.padding(AppSpacing.md)`, L68 `minHeight: AppSpacing.buttonHeight`, L78 `.padding(AppSpacing.xl)`.

### [P2] — Top-loaded composition: 59% of the viewport is dead space

- **What/Why:** Verified in `docs/ui-audit/shots/03-register.png`: content (nav bar excluded) runs from ~142pt to ~380pt — 41% of the 932pt height; the bottom ~550pt is empty black. LoginView centers its form between two Spacers (LoginView.swift:16, 78); RegisterView only has a trailing Spacer (L76), so the two auth screens have visibly different vertical rhythms. A 62/38 (golden-ratio-ish) split or vertical centering would balance the sheet.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RegisterView.swift:20, 76`
- **Exact fix:** add a leading Spacer and halve the visual weight, mirroring LoginView: insert `Spacer()` before L21's inner VStack and keep L76's trailing `Spacer()`; or present the sheet with a detent in LoginView.swift:82-84: `.presentationDetents([.medium]).presentationDragIndicator(.visible)` so the form fills a half-sheet (~466pt) at a natural density.

### [P2] — Error styling: P&L token misuse, color-only signaling, no VoiceOver announcement

- **What/Why:** Error text uses `Color.pnlNegative` (L47) — a token semantically reserved for trading P&L (AppColors.swift:63-65) — and communicates failure by red color alone with no icon, and nothing announces it to VoiceOver (it's a conditional view that pops in; no live region). Violates Color & Contrast (semantic tokens) and Accessibility (color-independent meaning).
- **Location:** `apps/ios/0dteTrader/Features/Auth/RegisterView.swift:44-49`
- **Exact fix:** use the `Label(..., systemImage: "exclamationmark.circle.fill")` form from the P1 validation fix above, switch the color to `Color.sellRed` (AppColors.swift:44-50 — the semantic negative/destructive token, #E13A43 dark), and add `.accessibilityAddTraits(.isStaticText)` plus explicit announcement: wrap in `.accessibilityElement(children: .combine)` and post `AccessibilityNotification.Announcement(message)` via `AccessibilityNotification.Announcement.init(_:)` — minimally, add `.onChange(of: viewModel.errorMessage) { _, msg in if let msg { UIAccessibility.post(notification: .announcement, argument: msg) } }`.

### [P2] — Password rules only exist in a placeholder; no visibility toggle

- **What/Why:** "Password (8+ characters)" (L31) disappears the moment the user types, removing the requirement exactly when it's needed; neither SecureField offers the standard eye/eye.slash reveal toggle, so a typo in a hidden confirm field is the most likely registration failure. Violates State Coverage (inline guidance) and Information Density (missing useful secondary info).
- **Location:** `apps/ios/0dteTrader/Features/Auth/RegisterView.swift:31-41`
- **Exact fix:** change the placeholder to `"Password"` (L31) and add a persistent caption below the password field inside the L21 VStack:
  ```swift
  Text("Minimum 8 characters")
      .font(.caption)
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
  ```
  For the reveal toggle, add `@State private var showPassword = false` and swap field types in an `HStack` with `Button { showPassword.toggle() } label: { Image(systemName: showPassword ? "eye.slash" : "eye").foregroundStyle(.secondary) }` inside the field padding (accessibilityLabel "Show password"/"Hide password").

### [P2] — Field and CTA styling copy-pasted from LoginView instead of a shared component

- **What/Why:** The exact 6-line field modifier chain (padding 12 / appSurface / RoundedRectangle 10) is duplicated 3× in this file and 2× in LoginView.swift:27-40; the loading-aware CTA (Group + ProgressView + frame 50 + accent fill + radius 12) is duplicated nearly verbatim (RegisterView.swift:51-74 vs LoginView.swift:50-70). Violates Consistency (component reuse); any restyle must be applied in 5+ places.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RegisterView.swift:22-41, 51-74`; `apps/ios/0dteTrader/Features/Auth/LoginView.swift:27-40, 50-70`
- **Exact fix:** extract into `apps/ios/0dteTrader/DesignSystem/AuthFieldStyle.swift`:
  ```swift
  struct AuthFieldModifier: ViewModifier {
      func body(content: Content) -> some View {
          content
              .padding(AppSpacing.md)
              .background(Color.appSurface)
              .clipShape(RoundedRectangle(cornerRadius: AppSpacing.fieldRadius, style: .continuous))
      }
  }
  extension View { func authField() -> some View { modifier(AuthFieldModifier()) } }
  ```
  and a shared `PrimaryActionButton(title:isLoading:isEnabled:action:)` encapsulating L58-74, then use both in Login and Register.

### [P2] — Loading state is a bare spinner with no label

- **What/Why:** `ProgressView().tint(.white)` (L61-62) replaces the label entirely; the CTA's meaning vanishes during the one moment the user most needs confirmation of what is happening. Skeletons > spinners per the bar; for a button, label+spinner is the correct pattern. Also `.tint(.white)` is a hardcoded color.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RegisterView.swift:59-66`
- **Exact fix:**
  ```swift
  HStack(spacing: AppSpacing.sm) {
      if viewModel.isLoading {
          ProgressView().tint(.white)
          Text("Creating account…")
      } else {
          Text("Create Account")
      }
  }
  .font(.headline)
  ```

### [P3] — Email validation is `contains("@")`; nav title duplicates the CTA

- **What/Why:** `email.contains("@")` (L12) accepts "a@b" with no domain; minor since the server validates, but the client message can promise "valid" incorrectly. Separately, the inline nav title "Create Account" (L79) is word-for-word the CTA label (L64) — redundant chrome on a small sheet (visible in the screenshot: the phrase appears twice, 130pt apart).
- **Location:** `apps/ios/0dteTrader/Features/Auth/RegisterView.swift:12, 64, 79`
- **Exact fix:** L12 → `if !email.range(of: #"^[^@\s]+@[^@\s]+\.[^@\s]+$"#, options: .regularExpression).isNilOrEmpty { ... }` i.e. `let emailOK = email.range(of: #"^[^@\s]+@[^@\s]+\.[^@\s]+$"#, options: .regularExpression) != nil; if !emailOK { return "Enter a valid email address." }`. And retitle the nav bar `"Sign Up"` (L79) or the button `"Create Account"` → keep button, change title — one phrase per screen.

## Quick wins vs structural work

**Landable in <1 hour:**

- Render `validationMessage`/`errorMessage` with `Label` + icon + transition + `.animation(.snappy(duration: 0.2), …)` (findings 1, 3.2, 8)
- `.interactiveDismissDisabled(viewModel.isLoading)` + disable Cancel while loading (finding 4)
- `@FocusState` + submitLabel Next/Next/Go + `onSubmit` chaining (finding 5)
- 14→12pt field-stack spacing; extract `AppSpacing` constants even if only this file adopts them (finding 6)
- `HStack` spinner + "Creating account…" label (finding 11)
- Persistent "Minimum 8 characters" caption; placeholder shortened to "Password" (finding 9, caption half)
- Haptic on error (finding 3.3); retitle nav bar to "Sign Up" (finding 12)

**Needs refactor / design-system work:**

- `appAccentFill` contrast-safe token (#2B59C3 dark) adopted across all filled CTAs app-wide, not just this screen (finding 2)
- `AuthFieldModifier` + `PrimaryActionButton` shared components, backported to LoginView (finding 10)
- Password visibility toggle (field-type swapping inside the styled container) (finding 9, toggle half)
- Composition rebalance: leading Spacer or `.presentationDetents([.medium])` — needs a visual decision on sheet vs full-screen across the whole auth flow (finding 7)
- Full `AppSpacing`/radius/motion token system (spacing scale, spring presets like `.spring(duration: 0.25, bounce: 0.2)`) with app-wide sweep of inline values (finding 6, systemic half)
