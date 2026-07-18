# Screen i3: Login
- **App:** iOS
- **Location:** `apps/ios/0dteTrader/Features/Auth/LoginView.swift` (whole file, 86 lines; key refs: title `:19-23`, email field `:27-34`, password field `:36-40`, error `:43-48`, CTA `:50-70`, create-account link `:72-76`, root padding `:80`) + `apps/ios/0dteTrader/Features/Auth/AuthViewModel.swift` (state: `.checking/.disclaimer/.unauthenticated/.authenticated` `:8-13`, error mapping `:100-104`, session-expired `:112-116`). Presented from `apps/ios/0dteTrader/App/RootView.swift:53`.
- **Visual:** UNVERIFIED-VISUAL — no macOS/Xcode available; layout reconstructed from code (VStack spacing 24, padding 24, Spacer-centered block ≈291pt tall, vertically centered ≈ y36–64% of a 932pt viewport). Desktop clone shot `docs/ui-audit/shots/02-login.png` was read and corroborates the reconstruction (centered title/subtitle, two filled fields, full-width blue CTA, text link). Note: the desktop shot renders the disabled CTA label as dimmed gray — the iOS code does NOT do this (see finding 8); desktop/iOS already diverge.
- **Scores:** Composition 5/10 · Typography 7/10 · Color 4/10 · Density 7/10 · DataViz 5/10 · Motion 2/10 · States 5/10 · Platform 5/10 · A11y 3/10 · Consistency 6/10 → **Overall 49/100**
- **Score justifications:**
  - **Composition 5/10:** outer padding 24pt sits on the 8pt grid, but inner spacings 14pt (`:26`) and 6pt (`:18`) break it, and Spacer×2 dead-centers the block at ~50% height instead of the ~38% upper-anchor golden-ratio placement login screens conventionally use.
  - **Typography 7/10:** correct semantic Dynamic Type styles throughout (`.largeTitle` `:20`, `.subheadline` `:22`, `.headline` `:61`, `.footnote` `:45`) — no prices on this screen so tabular figures are N/A; loses points for placeholder-only field labels and zero brand type treatment.
  - **Color 4/10:** error red ≈5.7:1 (pass) and accent link ≈6.2:1 (pass), but white CTA label on `appAccent` ≈3.15:1 (fails 4.5:1) and field fill vs background ≈1.15:1 with no border (fails 3:1 UI-boundary).
  - **Density 7/10:** login is inherently sparse; hierarchy title → fields → primary CTA → secondary link is correct and nothing is wasted — this meets, but does not exceed, the bar.
  - **DataViz 5/10:** no charts/axes on this screen (N/A); scored on async-state rendering only — button spinner is right, but full-screen session restore is a bare `ProgressView` (`RootView.swift:49`), not a skeleton.
  - **Motion 2/10:** `.buttonStyle(.plain)` (`:69`) gives zero press feedback, error text pops in with no transition (`:43-48`), no springs/haptics anywhere; the only motion is the system sheet (`:82`).
  - **States 5/10:** has loading (`:56-58`), error (`:43-48`), and session-expired copy (`AuthViewModel.swift:114`); missing keyboard-safe layout, offline-specific copy, reserved error space, and disabled affordance.
  - **Platform 5/10:** correct `.emailAddress` keyboard/content types and autocapitalization off (`:28-31`), 50pt CTA (`:64`), sheet for register (`:82`); but "Create an account" target is ~20pt tall (<44pt), no ScrollView/keyboard avoidance, dead `.scrollDismissesKeyboard` (`:81`), no password reveal, no biometric re-auth.
  - **A11y 3/10:** placeholder-only labels vanish on entry (VoiceOver loses field identity), two WCAG contrast failures, color-only error signal, sub-44pt link target, no accessibility labels/identifiers.
  - **Consistency 6/10:** reuses `appSurface`/`appAccent`/`pnlNegative` tokens correctly, but every spacing/radius/opacity value is a magic number (24/14/6/12/10/12/50/0.35) and the field + primary-button styling is copy-pasted verbatim from `RegisterView.swift:22-41,58-71` instead of shared components.

## Findings

### [P1] — White CTA label on `appAccent` fails WCAG AA: 3.15:1, needs 4.5:1
- **What/Why:** `Color.appAccent` dark value rgb(0.337, 0.561, 0.969) has relative luminance ≈0.284; white text on it = 1.05/0.334 ≈ **3.15:1**. "Log In" is `.headline` (17pt semibold), which does not qualify as WCAG "large text" (semibold ≠ bold), so 4.5:1 applies. Violates Color&Contrast and Accessibility on the single most important control of the screen.
- **Location:** `apps/ios/0dteTrader/Features/Auth/LoginView.swift:65-66`
- **Exact fix:** add a darker filled-button accent in `apps/ios/0dteTrader/DesignSystem/AppColors.swift` (luminance ≈0.168 → 4.8:1 with white):
  ```swift
  /// Filled-button accent. Darker than appAccent so white labels hit WCAG AA 4.5:1.
  static let appAccentButton = Color(
      uiColor: UIColor { traits in
          traits.userInterfaceStyle == .dark
              ? UIColor(red: 0.22, green: 0.42, blue: 0.88, alpha: 1)
              : UIColor(red: 0.16, green: 0.36, blue: 0.82, alpha: 1)
      }
  )
  ```
  then `LoginView.swift:65` becomes `.background(isFormValid ? Color.appAccentButton : Color.appAccentButton.opacity(0.35))`.

### [P1] — Input fields are visually invisible: fill 1.15:1 vs background, no border, no focus indicator
- **What/Why:** `appSurface` dark rgb(0.102,0.110,0.141) on `appBackground` dark rgb(0.043,0.047,0.063) ≈ **1.15:1**; WCAG 1.4.11 wants ≥3:1 for input boundaries. The desktop screenshot confirms: the fields are barely-discernible smudges. There is also no focused-state ring, so keyboard users get zero focus feedback. Violates Color&Contrast, Platform Fidelity, A11y.
- **Location:** `apps/ios/0dteTrader/Features/Auth/LoginView.swift:32-34` and `:38-40`
- **Exact fix:** add a stroke and a focus ring. Introduce `@FocusState private var focusedField: LoginField?` (see finding 5) and replace the field background/clip on both fields with:
  ```swift
  .padding(12)
  .background(Color.appSurface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
          .strokeBorder(
              focusedField == .email ? Color.appAccent : Color.primary.opacity(0.35),
              lineWidth: focusedField == .email ? 1.5 : 1
          )
  )
  ```
  (`Color.primary.opacity(0.35)` ≈ 3.15:1 vs `appBackground` in dark mode; use `.password` in the SecureField's check.)

### [P1] — Placeholder-only labels disappear on entry; no VoiceOver labels
- **What/Why:** `TextField("Email", ...)` / `SecureField("Password", ...)` rely on placeholders as the only label; once the user types, the field's identity is gone visually and VoiceOver reads only the contents. Fails WCAG 3.3.2 / HIG accessibility guidance.
- **Location:** `apps/ios/0dteTrader/Features/Auth/LoginView.swift:27` and `:36`
- **Exact fix:** add explicit labels:
  ```swift
  TextField("Email", text: $email)
      .accessibilityLabel("Email address")
  ...
  SecureField("Password", text: $password)
      .accessibilityLabel("Password")
  ```
  and give the CTA a stable automation/VoiceOver hook: `.accessibilityIdentifier("login.submit")` on the Button at `:50`.

### [P1] — `.buttonStyle(.plain)` removes all press feedback from the primary CTA
- **What/Why:** the custom-labeled Button at `:50-70` uses `.plain`, so pressing the most important control on screen produces zero visual response — no opacity, no scale. This is the exact opposite of the Robinhood-level micro-interaction bar. Violates Motion&Micro-interactions.
- **Location:** `apps/ios/0dteTrader/Features/Auth/LoginView.swift:69`
- **Exact fix:** replace `.buttonStyle(.plain)` with a pressed-state style (define once in `DesignSystem/`, reuse in `RegisterView.swift:73`):
  ```swift
  struct PrimaryButtonStyle: ButtonStyle {
      func makeBody(configuration: Configuration) -> some View {
          configuration.label
              .opacity(configuration.isPressed ? 0.85 : 1)
              .scaleEffect(configuration.isPressed ? 0.97 : 1)
              .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
      }
  }
  ```
  then `.buttonStyle(PrimaryButtonStyle())`.

### [P1] — No keyboard avoidance: dead `.scrollDismissesKeyboard`, no ScrollView, no submit chaining
- **What/Why:** `.scrollDismissesKeyboard(.interactively)` at `:81` is applied to a plain `VStack` — it does nothing (no scroll view exists), so the keyboard can only be dismissed by tapping a field's return key, and there is no `.submitLabel`/focus chaining (Email → Password → submit). On iPhone SE-class 667pt screens the keyboard (~302pt + suggestion bar) covers the lower half of the centered block including the CTA. Violates Platform Fidelity and State Coverage.
- **Location:** `apps/ios/0dteTrader/Features/Auth/LoginView.swift:81` (dead modifier), `:15-79` (no ScrollView), `:27-40` (no submit chaining)
- **Exact fix:**
  ```swift
  @FocusState private var focusedField: LoginField?
  private enum LoginField { case email, password }
  ```
  Wrap the `VStack` in `ScrollView { ... }` (keep `.scrollDismissesKeyboard(.interactively)` on the ScrollView), add to the email field: `.focused($focusedField, equals: .email).submitLabel(.next).onSubmit { focusedField = .password }`, and to the password field: `.focused($focusedField, equals: .password).submitLabel(.go).onSubmit { if isFormValid { Task { await viewModel.login(email: email.trimmingCharacters(in: .whitespaces), password: password) } } }`.

### [P1] — Error is signaled by color alone and appears without announcement or transition
- **What/Why:** the error at `:43-48` is bare red text (`pnlNegative`) — no icon, so meaning is color-only (fails WCAG 1.4.1); it is inserted/removed from the `VStack` with no `.transition`/`.animation`, so the CTA visibly jumps ~18pt when an error appears; and it carries no accessibility traits so VoiceOver users are not reliably alerted.
- **Location:** `apps/ios/0dteTrader/Features/Auth/LoginView.swift:43-48`
- **Exact fix:**
  ```swift
  if let errorMessage = viewModel.errorMessage {
      Label(errorMessage, systemImage: "exclamationmark.circle.fill")
          .font(.footnote)
          .foregroundStyle(Color.pnlNegative)
          .multilineTextAlignment(.center)
          .accessibilityAddTraits(.isStaticText)
          .transition(.opacity.combined(with: .move(edge: .top)))
  }
  ```
  plus `.animation(.easeInOut(duration: 0.2), value: viewModel.errorMessage)` on the root VStack (`:15`).

### [P1] — "Create an account" link has a ~20pt hit target, HIG minimum is 44pt
- **What/Why:** the text-only Button at `:72-76` renders ~17–20pt tall with no padding — half the 44×44pt minimum. Violates Platform Fidelity and A11y hit-area rules.
- **Location:** `apps/ios/0dteTrader/Features/Auth/LoginView.swift:72-76`
- **Exact fix:**
  ```swift
  Button("Create an account") { showRegister = true }
      .font(.subheadline)
      .foregroundStyle(Color.appAccent)
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(Rectangle())
  ```

### [P2] — Disabled CTA affordance is inverted: bright white label on dimmed fill looks tappable
- **What/Why:** when invalid, the button keeps `.foregroundStyle(.white)` at full opacity on `appAccent.opacity(0.35)` (`:65-66`) — label contrast actually *rises* to ~11:1, so the disabled button reads as a glowing white "Log In". `.plain` style applies no automatic disabled dimming. (The desktop clone dims the label — see screenshot — so iOS/desktop already disagree.) Violates State Coverage/Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Auth/LoginView.swift:65-66`
- **Exact fix:** change `:66` to `.foregroundStyle(isFormValid ? Color.white : Color.white.opacity(0.5))` and `.allowsHitTesting(false)` is unnecessary since `.disabled` already handles it.

### [P2] — Every layout value is a magic number; no spacing/radius tokens
- **What/Why:** `spacing: 24` (`:15`), `6` (`:18`), `14` (`:26`), `.padding(12)` (`:32,38`), `cornerRadius: 10` (`:34,40`), `cornerRadius: 12` (`:67`), `minHeight: 50` (`:64`), `.padding(24)` (`:80`), `opacity(0.35)` (`:65`) — the project has color/typography tokens but zero spacing/radius/motion tokens, so these one-offs will drift. 14pt and 6pt also break the 8pt grid. Violates Consistency (and Composition).
- **Location:** `apps/ios/0dteTrader/Features/Auth/LoginView.swift:15,18,26,32,34,38,40,64,65,67,80`
- **Exact fix:** create `apps/ios/0dteTrader/DesignSystem/AppSpacing.swift`:
  ```swift
  enum AppSpacing {
      static let xs: CGFloat = 4
      static let sm: CGFloat = 8
      static let md: CGFloat = 16   // replaces 14
      static let lg: CGFloat = 24
      static let fieldPadding: CGFloat = 12
      static let fieldRadius: CGFloat = 10
      static let buttonRadius: CGFloat = 12
      static let buttonHeight: CGFloat = 50
  }
  ```
  then replace: `:15` `VStack(spacing: AppSpacing.lg)`, `:18` `spacing: AppSpacing.sm` (was 6), `:26` `spacing: AppSpacing.md` (was 14), paddings/radii/heights with the corresponding constants.

### [P2] — Missing standard login affordances: no password reveal, no "Forgot password?"
- **What/Why:** every top-tier auth screen (Apple ID, Robinhood) offers an eye toggle on the password field and a recovery path; here a mistyped password is invisible and a forgotten password is a dead end — a State Coverage gap with measurable support-ticket cost.
- **Location:** `apps/ios/0dteTrader/Features/Auth/LoginView.swift:36-40` (no reveal), `:72-76` region (no recovery link)
- **Exact fix:** add `@State private var isPasswordVisible = false` and:
  ```swift
  HStack {
      Group {
          if isPasswordVisible { TextField("Password", text: $password) }
          else { SecureField("Password", text: $password) }
      }
      .textContentType(.password)
      Button {
          isPasswordVisible.toggle()
      } label: {
          Image(systemName: isPasswordVisible ? "eye.slash.fill" : "eye.fill")
              .foregroundStyle(.secondary)
              .frame(width: 44, height: 44)
              .contentShape(Rectangle())
      }
      .accessibilityLabel(isPasswordVisible ? "Hide password" : "Show password")
  }
  .padding(.leading, 12)
  ```
  Add under the CTA: `Button("Forgot password?") { /* open reset flow */ }` styled identically to "Create an account".

### [P2] — Field/button styling copy-pasted from RegisterView instead of shared components
- **What/Why:** `RegisterView.swift:22-41` duplicates the TextField/SecureField styling verbatim and `:58-71` duplicates the loading-button `Group`+`frame`+`background`+`clipShape` block — three fields and one button now, guaranteed divergence later (the disabled-label behavior already diverges from the desktop clone). Violates Consistency/component reuse.
- **Location:** `apps/ios/0dteTrader/Features/Auth/LoginView.swift:27-41,50-70` vs `apps/ios/0dteTrader/Features/Auth/RegisterView.swift:22-41,51-74`
- **Exact fix:** extract `AuthTextField` (title key, binding, contentType, FocusState, style block from finding 2) and `AuthPrimaryButton` (title, isLoading, isEnabled, action) into `Features/Auth/`, and use them in both views.

### [P2] — Offline/network errors surface raw `localizedDescription`, not actionable copy
- **What/Why:** only `APIError` gets friendly copy; everything else (URLSession offline, timeout) falls through to `error.localizedDescription` (`AuthViewModel.swift:103`), yielding "The Internet connection appears to be offline." with no recovery guidance — violates State Coverage ("actionable errors").
- **Location:** `apps/ios/0dteTrader/Features/Auth/AuthViewModel.swift:100-104`
- **Exact fix:**
  ```swift
  } catch let error as APIError {
      errorMessage = error.userMessage
  } catch let error as URLError where error.code == .notConnectedToInternet || error.code == .timedOut {
      errorMessage = "You're offline. Check your connection and try again."
  } catch {
      errorMessage = "Something went wrong. Please try again."
  }
  ```

### [P3] — Zero brand moment: plain text wordmark, no logo, no entrance motion, no haptics
- **What/Why:** the first screen a user sees is `.largeTitle.bold()` system text and a gray subheadline (`:19-23`) — no asset/logo mark, no spring entrance, no `UINotificationFeedbackGenerator` on auth failure. This is where "holy shit" is won or lost, and currently it reads as a template. Also the spinner flashes instantly on tap; a 100–150ms delay avoids flicker on fast networks.
- **Location:** `apps/ios/0dteTrader/Features/Auth/LoginView.swift:19-23` (wordmark), `:50-53` (no error haptic), `:56-58` (instant spinner)
- **Exact fix:** replace the title with `Image("brandmark").resizable().frame(width: 56, height: 56)` above `Text("0dteTrader").font(.title.bold())`, add `.transition(.opacity.combined(with: .scale(scale: 0.95)))` + `.animation(.spring(response: 0.4, dampingFraction: 0.8), value: ...)` on first appear (wrap in `.accessibilityReduceMotion` check), and fire `UINotificationFeedbackGenerator().notificationOccurred(.error)` when `viewModel.errorMessage` transitions non-nil (`.onChange(of: viewModel.errorMessage)`).

### [P3] — No biometric quick re-auth on the login screen despite the app shipping FaceID lock elsewhere
- **What/Why:** `RootView.swift:10,23-25,61-77` already runs an `AppLockManager` with FaceID unlock, but a user whose refresh token expired must type credentials with no biometric shortcut — inconsistent platform-fidelity story and a friction point Robinhood/Apple would never ship.
- **Location:** `apps/ios/0dteTrader/Features/Auth/LoginView.swift` (absent; integration point near `:72-76`), `apps/ios/0dteTrader/App/RootView.swift:61-77`
- **Exact fix:** after a first successful login, store a Keychain entry flagged `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` + `.biometryCurrentSet`; on `.unauthenticated`, if the entry exists, show `Button { Task { await viewModel.loginWithBiometrics() } } label: { Label("Log in with Face ID", systemImage: "faceid") }` under "Create an account".

## Quick wins vs structural work

**Landable in <1 hour:**
- Darken CTA fill (`appAccentButton`) for 4.5:1 — finding 1.
- Add field border + focus ring — finding 2.
- `.accessibilityLabel` on both fields + `.accessibilityIdentifier` on CTA — finding 3.
- `PrimaryButtonStyle` with pressed opacity/scale — finding 4.
- Reserve error space + `Label` icon + 0.2s transition — finding 6.
- 44pt hit frame on "Create an account" — finding 7.
- Dim disabled label (`white.opacity(0.5)`) — finding 8.
- URLError offline copy in `AuthViewModel` — finding 12.

**Needs refactors / design decisions:**
- `AppSpacing` token system + sweeping magic numbers (spacing 14→16, 6→8) across Auth and beyond — finding 9.
- ScrollView + FocusState submit-chaining keyboard architecture — finding 5.
- Extract `AuthTextField` / `AuthPrimaryButton` shared components used by Login and Register — finding 11.
- Password reveal + Forgot-password flow (needs backend reset endpoint) — finding 10.
- Brand identity (logo asset, entrance spring, haptics, reduced-motion variants) — finding 13.
- Biometric re-auth (Keychain + LAContext plumbing in `SessionStore`/`AuthViewModel`) — finding 14.
