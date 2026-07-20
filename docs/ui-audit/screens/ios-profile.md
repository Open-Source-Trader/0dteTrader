# Screen i17: Profile + Webull credentials form

- **App:** iOS
- **Location:** `apps/ios/0dteTrader/Features/Profile/ProfileView.swift` (confirmationDialog at lines 26–37), `WebullCredentialsForm.swift` (whole file), `ProfileViewModel.swift` (state/logic)
- **Visual:** UNVERIFIED-VISUAL — no macOS/Xcode to render the iOS target; layout reconstructed from code. Desktop clone shot `docs/ui-audit/shots/09-profile.png` (430×932 @2x) used as reference: it confirms a stock grouped-Form layout with `Email` row, three secure fields, a dimmed disabled "Save Credentials" button, footer helper text, and a destructive "Log Out" row — with the entire lower ~45% of the viewport empty. The clone also omits the Security (Face ID) section entirely (parity gap).
- **Scores:** Composition 7/10 · Typography 7/10 · Color 7/10 · Density 7/10 · DataViz 10/10 · Motion 4/10 · States 4/10 · Platform 8/10 · A11y 5/10 · Consistency 5/10 → **Overall 64/100**
- **Score justifications:**
  - Composition 7: stock `Form` rows are cleanly 8pt-aligned with correct grouped rhythm, but content ends at ~55% viewport height leaving an unstructured void below (screenshot rows end at y≈1046/1864).
  - Typography 7: all Dynamic Type text styles (`.body` rows, `.footnote` helpers at ProfileView.swift:50,67,87,92) scale correctly; nothing requires tabular figures here; no modular-scale ambition either — `AppTypography.panelLabel` unused.
  - Color 7: semantic `pnlPositive`/`pnlNegative` tokens used for status (lines 49,65,88,93), but the Form's grouped background/surfaces are system defaults, not `appBackground`/`appSurface` tokens, and the disabled "Save Credentials" button renders tint at ~30% opacity (visible in shot) — readable only barely.
  - Density 7: hierarchy (label → value, section → footer) is appropriate for a settings screen; primary action ("Save Credentials") is visually weak — a plain dimmed row button identical in weight to "Log Out".
  - DataViz 10: no charts/axes on this screen; nothing violates axis/gridline/crosshair discipline; no skeleton misuse because no viz exists (spinner misuse scored under States).
  - Motion 4: zero animation specification anywhere — Configured↔form swap (ProfileView.swift:63–83) is an instant hard cut, `ProgressView`↔"Save Credentials" text swap (WebullCredentialsForm.swift:29–33) causes a layout jump, no haptics on save/delete/logout, no `.animation`/spring.
  - States 4: while `me` is loading the screen shows the empty credential _entry form_ even for already-configured users (else branch, line 76); `load()` errors surface under the Webull section (line 90) with no retry; spinner instead of skeleton (line 53); success message never clears (ProfileViewModel.swift:73); no offline state.
  - Platform 8: `confirmationDialog` with `.destructive` role + explicit consequence message (lines 26–37), `SecureField`, SF Symbols, default ≥44pt Form rows, inline nav title — all correct HIG; docked for missing haptics, no FocusState keyboard chaining, no biometric-availability guard on the Face ID toggle.
  - A11y 5: success/error meaning is conveyed by color alone (lines 85–94, no icon); `.textContentType(.password)` on non-password fields (WebullCredentialsForm.swift:11,16,21) pollutes Keychain; email value not selectable; VoiceOver gets no context on the bare `ProgressView` (line 53).
  - Consistency 5: the screen uses zero app design tokens — no `appBackground`/`appSurface`/`appAccent`, no `AppTypography`, no shared components; it is a stock `Form` island in an otherwise bespoke design system (AppColors.swift/AppTypography.swift untouched by this feature).

## Findings

### [P1] — Credential entry form flashes for already-configured users while `/v1/me` loads

- **What/Why:** `webullSection`'s `else` branch (ProfileView.swift:76) renders `WebullCredentialsForm` whenever `me == nil` OR `webullConfigured == false`. During every sheet open, `me` is nil until `load()` completes, so configured users see three empty secret fields + a disabled Save button for a network round-trip, then a hard cut to the "Configured" state. Violates State Coverage and Motion; the loading affordance (`ProgressView`, line 53) only covers the Account section.
- **Location:** `apps/ios/0dteTrader/Features/Profile/ProfileView.swift:61-83` (root cause), `:23-25` (unconditional `.task { await viewModel.load() }`)
- **Exact fix:** gate the section on load completion and animate the swap:
  ```swift
  private var webullSection: some View {
      Section {
          if viewModel.isLoading && viewModel.me == nil {
              // skeleton rows matching SecureField row height (44pt)
              ForEach(0..<4, id: \.self) { _ in
                  RoundedRectangle(cornerRadius: 6)
                      .fill(Color.appSurfaceElevated)
                      .frame(height: 20)
                      .padding(.vertical, 12)
                      .redacted(reason: .placeholder)
              }
          } else if let me = viewModel.me, me.webullConfigured, !viewModel.isEditingCredentials {
              // ... existing configured branch unchanged
          } else {
              // ... existing form branch unchanged
          }
      }
      .animation(.spring(response: 0.35, dampingFraction: 0.85), value: viewModel.me?.webullConfigured)
      .animation(.spring(response: 0.35, dampingFraction: 0.85), value: viewModel.isEditingCredentials)
  }
  ```

### [P1] — Success/error feedback is color-only

- **What/Why:** Lines 85–94 render `successMessage` in `pnlPositive` and `errorMessage` in `pnlNegative` with no icon or shape. Color-blind users (deuteranopia makes systemGreen/systemRed nearly indistinguishable at footnote size) cannot tell success from failure. Violates Accessibility (color-independent meaning) — Apple's own HIG requires a non-color cue.
- **Location:** `apps/ios/0dteTrader/Features/Profile/ProfileView.swift:85-94`
- **Exact fix:** replace both blocks with labeled icon+text:
  ```swift
  if let successMessage = viewModel.successMessage {
      Label(successMessage, systemImage: "checkmark.circle.fill")
          .font(.footnote)
          .foregroundStyle(Color.pnlPositive)
          .accessibilityAddTraits(.isStaticText)
  }
  if let errorMessage = viewModel.errorMessage {
      Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
          .font(.footnote)
          .foregroundStyle(Color.pnlNegative)
  }
  ```

### [P1] — Zero motion and zero haptics on every interaction

- **What/Why:** No `.animation`, no spring, no `SensoryFeedback`/`UINotificationFeedbackGenerator` anywhere in the feature. The Configured↔editing swap is a hard cut; saving credentials (the single most consequential action on the screen — it enables live trading) gives no tactile confirmation; the destructive delete gives no warning haptic. For a "holy shit" bar this screen feels dead. Violates Motion&Micro-interactions.
- **Location:** `apps/ios/0dteTrader/Features/Profile/ProfileView.swift:61-117`, `apps/ios/0dteTrader/Features/Profile/WebullCredentialsForm.swift:25-36`
- **Exact fix:**
  ```swift
  // In webullSection, on the messages (below the icon fix above):
  .sensoryFeedback(.success, trigger: viewModel.successMessage)
  .sensoryFeedback(.error, trigger: viewModel.errorMessage)
  // On the delete confirmation button (line 31):
  Button("Delete Credentials", role: .destructive) {
      Task { await viewModel.deleteCredentials() }
  }
  .sensoryFeedback(.warning, trigger: showDeleteConfirmation)
  // In WebullCredentialsForm, fix the button layout jump by keeping label width stable:
  Button {
      Task { await viewModel.saveCredentials() }
  } label: {
      HStack(spacing: 8) {
          if viewModel.isSavingCredentials { ProgressView().controlSize(.small) }
          Text("Save Credentials")
      }
      .frame(maxWidth: .infinity)
  }
  ```

### [P2] — `.textContentType(.password)` on App Key and Account ID invites wrong Keychain prompts

- **What/Why:** All three fields declare `.password` content type (WebullCredentialsForm.swift:11,16,21). iOS treats these as a login form: it can trigger unwanted "Save Password to iCloud Keychain?" prompts and offer irrelevant password autofill over the App Key/Account ID fields. Violates Platform Fidelity and creates friction on the highest-stakes form in the app.
- **Location:** `apps/ios/0dteTrader/Features/Profile/WebullCredentialsForm.swift:10-23`
- **Exact fix:** only the App Secret is a password-class secret:
  ```swift
  SecureField("App Key", text: $viewModel.appKey)
      .textContentType(.none) // or .oneTimeCode to suppress autofill entirely
  SecureField("App Secret", text: $viewModel.appSecret)
      .textContentType(.password)
  TextField("Account ID", text: $viewModel.accountId)   // see next finding
      .textContentType(.none)
  ```

### [P2] — Account ID masked as a SecureField

- **What/Why:** Account ID is an identifier, not a secret (the copy at ProfileView.swift:66 says credentials "are never displayed here" — but that refers to server-side storage, not live entry). Masking it while typing prevents the user from verifying the value they pasted, a classic cause of failed broker connections. Violates Information Density/State Coverage (no way to self-correct input errors).
- **Location:** `apps/ios/0dteTrader/Features/Profile/WebullCredentialsForm.swift:20-23`
- **Exact fix:** use a plain `TextField` with a reveal affordance on the two true secrets:
  ```swift
  TextField("Account ID", text: $viewModel.accountId)
      .textInputAutocapitalization(.never)
      .autocorrectionDisabled()
      .font(.system(.body, design: .monospaced)) // aligns pasted IDs visually
  ```

### [P2] — `load()` failure is reported in the wrong section with no recovery

- **What/Why:** `load()` (ProfileViewModel.swift:41-52) fetches account info; if it fails, `errorMessage` renders only inside the _Webull API_ section (ProfileView.swift:90), so a network outage looks like a Webull credential problem. There is no Retry button; the only recovery is dismissing and reopening the sheet. The Account section falls back to a dead "Account details unavailable" string (line 55). Violates State Coverage (actionable errors).
- **Location:** `apps/ios/0dteTrader/Features/Profile/ProfileView.swift:52-57` and `:90-94`; `ProfileViewModel.swift:41-52`
- **Exact fix:**
  ```swift
  // Account section fallback (replace lines 54-57):
  } else {
      Label("Account details unavailable", systemImage: "wifi.exclamationmark")
          .foregroundStyle(.secondary)
      Button("Retry") { Task { await viewModel.load() } }
  }
  // And in ProfileViewModel.load(), track the failure separately so it doesn't
  // render under the Webull section:
  @Published private(set) var loadFailed = false
  // set loadFailed = true in catch, false on success; only show errorMessage
  // in the Webull section for save/delete failures.
  ```

### [P2] — Success message persists forever

- **What/Why:** `successMessage` ("Webull credentials saved." / "removed.", ProfileViewModel.swift:73,90) is never cleared — it sits under the "Configured" state indefinitely, competing with the checkmark label and going stale (it still says "saved" minutes later). Violates State Coverage and Density.
- **Location:** `apps/ios/0dteTrader/Features/Profile/ProfileViewModel.swift:73,90`
- **Exact fix:** auto-expire in the view:
  ```swift
  .onChange(of: viewModel.successMessage) { _, msg in
      guard msg != nil else { return }
      Task { try? await Task.sleep(for: .seconds(4)); viewModel.successMessage = nil }
  }
  ```

### [P2] — Log Out: no confirmation, no in-flight guard, dismisses before completion

- **What/Why:** The destructive Log Out row (line 110) fires immediately — Delete Credentials gets a confirmationDialog but ending the session does not (inconsistent destructiveness policy). `dismiss()` is called right after `await viewModel.logout()` with no loading state, and there is no `isLoggingOut` guard, so a double-tap fires the logout twice. Violates State Coverage and Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Profile/ProfileView.swift:108-117`
- **Exact fix:** mirror the credentials-delete pattern — reuse `showDeleteConfirmation`-style dialog:
  ```swift
  @State private var showLogoutConfirmation = false
  // row:
  Button("Log Out", role: .destructive) { showLogoutConfirmation = true }
  // dialog:
  .confirmationDialog("Log out of 0dteTrader?", isPresented: $showLogoutConfirmation, titleVisibility: .visible) {
      Button("Log Out", role: .destructive) { Task { await viewModel.logout(); dismiss() } }
      Button("Cancel", role: .cancel) {}
  }
  ```

### [P2] — Screen bypasses the app design system entirely (stock `Form` island)

- **What/Why:** Every other surface in the app is built on `appBackground` (dark #0B0C10) / `appSurface` (#1A1C24) / `appSurfaceElevated`; this screen renders `Form`'s default `systemGroupedBackground` and grouped-list insets — visibly different black level and card radius (10pt continuous vs the app's custom radii) from the rest of the product. Zero references to `AppColors`/`AppTypography` exist in the feature folder. Violates Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Profile/ProfileView.swift:10-15` (bare `Form`), whole `Features/Profile/` folder (no DesignSystem imports)
- **Exact fix:** keep the `Form` (correct HIG choice for settings) but align the chrome:
  ```swift
  Form { ... }
      .scrollContentBackground(.hidden)
      .background(Color.appBackground)
      .tint(Color.appAccent)
  ```
  and in each section header use `Text("Webull API").font(.panelLabel).textCase(nil)` to match the app's panel-label voice instead of the default all-caps gray header.

### [P3] — Email value is not copyable

- **What/Why:** The only identity the screen shows (`LabeledContent("Email", value: me.email)`, line 46) cannot be selected/copied — support flows ("what email is this account?") force manual transcription of a long address like `audit-1784342866384@example.com` (visible truncated-free in the shot). Violates Accessibility/Platform Fidelity.
- **Location:** `apps/ios/0dteTrader/Features/Profile/ProfileView.swift:46`
- **Exact fix:** `.textSelection(.enabled)` on the LabeledContent.

### [P3] — No keyboard flow: three secure fields, no FocusState or submit chaining

- **What/Why:** Return key does nothing; the user must tap each field individually, and the keyboard never gets a "Done/Go" to trigger save. Violates Platform Fidelity (zero-friction bar).
- **Location:** `apps/ios/0dteTrader/Features/Profile/WebullCredentialsForm.swift:9-37`
- **Exact fix:**
  ```swift
  enum Field: Hashable { case appKey, appSecret, accountId }
  @FocusState private var focused: Field?
  // per field: .focused($focused, equals: .appKey) with
  // .submitLabel(.next) / (.go) on Account ID, and
  // .onSubmit { focused = .appSecret } etc.; on .go: Task { await viewModel.saveCredentials() }
  ```

### [P3] — Face ID toggle has no availability or failure state

- **What/Why:** "Require Face ID to open" (line 104) persists to `settingsStore` on every flip with no check that biometrics are enrolled/available (`LAContext.canEvaluatePolicy`) and no error surface if enabling fails — on a device with no Face ID enrolled the toggle is a lie. Violates State Coverage.
- **Location:** `apps/ios/0dteTrader/Features/Profile/ProfileView.swift:102-106`; `ProfileViewModel.swift:20-22`
- **Exact fix:** in the ViewModel, guard with `LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics)`; if unavailable, revert `appLockEnabled = false` and set `errorMessage = "Face ID isn't set up on this device."` (surfaced via the existing icon'd error label from the P1 fix).

### [P3] — Every sheet open re-fetches and flashes the loading state

- **What/Why:** `.task { await viewModel.load() }` (line 23) runs on every presentation with no staleness window; combined with the P1 loading bug, configured users get a form-flash on every open. Violates State Coverage/Composition.
- **Location:** `apps/ios/0dteTrader/Features/Profile/ProfileView.swift:23-25`
- **Exact fix:** `if viewModel.me == nil { await viewModel.load() }` (and keep pull-to-refresh out — a settings sheet doesn't need it).

### [P3] — Desktop clone parity: Security section missing

- **What/Why:** The reference shot `docs/ui-audit/shots/09-profile.png` shows Webull API footer → Log Out with no "Require Face ID to open" toggle between them. The desktop 430×932 clone of this iOS screen has dropped an entire section, so cross-platform behavior diverges. Violates Consistency (clone fidelity).
- **Location:** desktop Profile clone component (under `apps/desktop/src/`, mirroring `ProfileView.swift:102-106`); evidence in `docs/ui-audit/shots/09-profile.png`
- **Exact fix:** add the toggle row to the desktop clone's Profile screen between the Webull section and the Log Out row, styled per `apps/desktop/src/design/tokens.css` (`var(--surface)` row, `var(--text-primary)` label, 44px min-height to match iOS 44pt).

## Quick wins vs structural work

**Landable in <1 hour:**

- Icon'd success/error `Label`s (P1 #2) — 6-line change.
- `.textContentType` fix + Account ID → plain `TextField` (P2 #4/#5) — 5-line change.
- `.textSelection(.enabled)` on email (P3) — 1 line.
- Guard `.task` refetch (P3) — 1 line.
- Auto-expire success message (P2 #7) — 5 lines.
- `.tint(.appAccent)` + hidden scroll background (first half of P2 #9) — 3 lines.
- Log Out confirmationDialog (P2 #8) — ~10 lines, reuses existing pattern.

**Needs refactor / design decision:**

- Loading skeleton + animated Configured↔form swap (P1 #1) — touches `webullSection` layout and needs row-height-matched placeholder shapes.
- Splitting `load()` errors from save/delete errors in `ProfileViewModel` (P2 #6) — new state field + view routing.
- Haptics + motion pass (P1 #3) — needs an app-wide haptics/motion convention (no motion tokens exist today).
- FocusState keyboard chaining (P3) — modest but touches all three fields + submit behavior.
- Face ID availability check (P3) — requires `LocalAuthentication` integration in `AppLockManager`/`ProfileViewModel`.
- Desktop clone Security-section parity (P3) — cross-app change in `apps/desktop`.
