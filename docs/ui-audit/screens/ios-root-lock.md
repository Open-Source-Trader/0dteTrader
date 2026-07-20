# Screen i1: Session-restore spinner + app-lock overlay

- **App:** iOS
- **Location:** `apps/ios/0dteTrader/App/RootView.swift` (spinner `:48-49`, lock overlay `:61-77`, scenePhase lock `:30-42`); context: `apps/ios/0dteTrader/Features/Profile/AppLockManager.swift`, `apps/ios/0dteTrader/Features/Auth/AuthViewModel.swift:48-89`, `apps/ios/0dteTrader/Core/Networking/SessionStore.swift:41-48`
- **Visual:** UNVERIFIED-VISUAL — no macOS/Xcode on this machine; layout reconstructed mathematically from SwiftUI frames/stacks (iPhone 430×932pt, dark).
- **Scores:** Composition 6/10 · Typography 6/10 · Color 6/10 · Density 7/10 · DataViz 5/10 · Motion 3/10 · States 3/10 · Platform 4/10 · A11y 3/10 · Consistency 5/10 → **Overall 48/100**
- **Score justifications:**
  - **Composition 6:** Centered VStack is aligned and sparse-appropriate, but sits at dead geometric center (~401pt of 932pt to block top) instead of optical ~45%, and there is zero branding on either state.
  - **Typography 6:** `.headline` + ProgressView default label both support Dynamic Type (good), but the 44pt lock glyph is a hardcoded `.system(size:)` one-off, and nothing uses the DesignSystem's own styles.
  - **Color 6:** `Color.appBackground` token used correctly on both states (contrast of `.secondary` glyph on `#0B0C10` ≈ 7:1, passes), but the Unlock button and ProgressView fall back to the default system-blue/gray — `appAccent` token is never applied anywhere in the app (`ZeroDTETraderApp.swift` sets no `.tint`).
  - **Density 7:** Sparseness is correct for a gate screen; docked only because the spinner state carries zero context (no wordmark, no what-is-happening hierarchy beyond one label).
  - **DataViz 5:** No charts by design; graded on the skeletons-vs-spinners clause — a bare `ProgressView` instead of a branded splash or trade-screen skeleton.
  - **Motion 3:** `.transition(.opacity)` is dead code (no `.animation`/`withAnimation` anywhere), auth-state swaps are instant cuts, no haptics, no reduced-motion handling.
  - **States 3:** No offline/timeout path for session restore (silent dump to Login after up to 60s), no failed-FaceID feedback, no escape hatch from the lock screen.
  - **Platform 4:** App-switcher snapshot race (locks on `.background`, too late), Unlock button ≈34pt tall (< 44pt HIG minimum), no haptics; SF Symbol usage itself is correct.
  - **A11y 3:** VoiceOver can navigate and read live P&L on `TradeScreenView` _behind_ the lock overlay (privacy leak); decorative lock glyph not `.accessibilityHidden`; ProgressView label is the only bright spot.
  - **Consistency 5:** Hardcoded 44pt icon, inline `spacing: 16`, default tint instead of `appAccent` — and the design system has no spacing/radius/motion tokens at all, so every value here is a one-off by construction.

## Findings

### [P1] — App-switcher snapshot races the lock: live P&L visible in multitasking UI

- **What/Why:** `lockManager.lockIfNeeded()` fires on `scenePhase == .background` (RootView.swift:32-33). iOS captures the app-switcher snapshot _as_ the app backgrounds; the scenePhase transition is `.active → .inactive → .background`, and a SwiftUI state write in `.background` is not guaranteed to render before the snapshot. Result: a trading app showing real positions/P&L can be screenshotted into the multitasking carousel unlocked. Violates Platform Fidelity + State Coverage (privacy state). Additionally, when `appLockEnabled == false`, nothing ever obscures the switcher card.
- **Location:** `apps/ios/0dteTrader/App/RootView.swift:30-42`
- **Exact fix:** Lock (or at minimum raise a privacy shield) on `.inactive`, which always precedes the snapshot:

```swift
.onChange(of: scenePhase) { _, phase in
    switch phase {
    case .inactive:
        lockManager.lockIfNeeded()          // render lock before snapshot
    case .background:
        lockManager.lockIfNeeded()
    case .active:
        container.quoteSocket.reconnectIfNeeded()
        if lockManager.isLocked {
            Task { await lockManager.unlock() }
        }
    default:
        break
    }
}
```

Even better, add a dedicated `privacyShield` shown for _all_ users on `.inactive` (plain `Color.appBackground` + wordmark) independent of `appLockEnabled`.

### [P1] — Session restore has no offline/timeout state: up to 60s spinner, then silent dump to Login

- **What/Why:** `restoreSession()` (AuthViewModel.swift:82-89) maps _any_ failure — including "iPhone in airplane mode with a perfectly valid refresh token" — to `state = .unauthenticated`, and `SessionStore.restoreSession()` (SessionStore.swift:41-48) swallows the error with `catch { return false }`. The user stares at "Restoring session…" for up to `URLSessionConfiguration.default.timeoutIntervalForRequest` (60s), then lands on Login with zero explanation — indistinguishable from "your credentials are gone." Violates State Coverage: no designed error state, no retry, no offline messaging, spinner not skeleton.
- **Location:** `apps/ios/0dteTrader/App/RootView.swift:48-49`, `apps/ios/0dteTrader/Features/Auth/AuthViewModel.swift:82-89`, `apps/ios/0dteTrader/Core/Networking/SessionStore.swift:46-48`
- **Exact fix:** Distinguish network failure from auth failure. In `SessionStore.restoreSession()`, rethrow `URLError` connectivity cases and only return `false` for 401s; add a state and screen:

```swift
// AuthViewModel.State
case restoreFailed(String)   // carries userMessage

// restoreSession()
} catch let urlError as URLError where urlError.code == .notConnectedToInternet
        || urlError.code == .timedOut || urlError.code == .networkConnectionLost {
    state = .restoreFailed("You're offline. We'll keep your session — reconnect and retry.")
} catch {
    state = .unauthenticated
}

// RootView.content
case .restoreFailed(let message):
    VStack(spacing: 16) {
        Image(systemName: "wifi.exclamationmark")
            .font(.system(size: 44))
            .foregroundStyle(.secondary)
            .accessibilityHidden(true)
        Text(message)
            .font(.headline)
            .multilineTextAlignment(.center)
        Button("Retry") { Task { await authViewModel.start() } }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(.appAccent)
        Button("Sign in again") { authViewModel.state = .unauthenticated }
            .buttonStyle(.bordered)
    }
    .padding(.horizontal, 32)
```

### [P1] — VoiceOver reads the live trade screen _behind_ the lock overlay

- **What/Why:** The lock overlay is a plain `ZStack` sibling (RootView.swift:20-26). It covers `TradeScreenView` visually but not in the accessibility tree: VoiceOver focus order still walks every chart, price, and P&L label underneath, so a locked phone audibly leaks portfolio data — and sighted-VoiceOver users can activate controls through the "lock." Violates Accessibility (focus order, modal containment) and the spirit of SECURITY.md §5.
- **Location:** `apps/ios/0dteTrader/App/RootView.swift:20-26, 61-77`
- **Exact fix:**

```swift
ZStack {
    Color.appBackground.ignoresSafeArea()
    content
        .accessibilityHidden(lockManager.isLocked)
    if lockManager.isLocked {
        lockOverlay
            .accessibilityAddTraits(.isModal)   // iOS 17: traps VO focus on the overlay
    }
}
```

Also hide the decorative glyph: add `.accessibilityHidden(true)` to the `lock.fill` image (RootView.swift:65) — the adjacent "0dteTrader is locked" text already conveys meaning.

### [P2] — `.transition(.opacity)` is dead code: no animation drives it

- **What/Why:** `lockOverlay` declares `.transition(.opacity)` (RootView.swift:76) but `isLocked` is flipped via plain `@Published` writes (AppLockManager.swift:18, 29, 40) with no `withAnimation`, and no `.animation(_, value:)` on the ZStack. Transitions only run inside an animation context, so the overlay pops in/out in a single frame — jarring against the Robinhood-fluid bar, and the transition modifier is misleading dead code. Violates Motion (120–250ms eased).
- **Location:** `apps/ios/0dteTrader/App/RootView.swift:20-26, 76`
- **Exact fix:**

```swift
// on the outer ZStack in body:
.animation(.easeInOut(duration: 0.2), value: lockManager.isLocked)
```

(0.2s ease-in-out, honors Reduce Motion automatically since opacity fades are non-spatial.)

### [P2] — Auth-state changes are hard cuts with no transition

- **What/Why:** `content` (RootView.swift:45-59) swaps `ProgressView` → `LoginView`/`TradeScreenView` with no transition or animation, so every launch is an instant full-screen flash-cut from spinner to app. Violates Motion (screen-level continuity) and Composition (perceived polish at the single most-viewed moment of the app: cold start).
- **Location:** `apps/ios/0dteTrader/App/RootView.swift:45-59`
- **Exact fix:**

```swift
@ViewBuilder
private var content: some View {
    switch authViewModel.state {
    case .checking:
        ProgressView("Restoring session…")
            .tint(.appAccent)
    case .disclaimer:
        RiskDisclaimerView(viewModel: authViewModel)
    case .unauthenticated:
        LoginView(viewModel: authViewModel)
    case .authenticated:
        TradeScreenView(container: container) {
            await authViewModel.logout()
        }
    }
}
```

with, applied to `content` at the call site in `body`:

```swift
content
    .id(authViewModel.state)
    .transition(.opacity)
    .animation(.easeInOut(duration: 0.25), value: authViewModel.state)
```

### [P2] — Unlock button is sub-44pt and uses the default blue, not `appAccent`

- **What/Why:** `.borderedProminent` at the default `.regular` control size renders ≈34pt tall — under the 44pt HIG minimum hit target for the _only_ control on a screen the user may hit 50×/day. And because no `.tint` is set anywhere (`ZeroDTETraderApp.swift:7-11` has none), the button renders system blue instead of the brand `appAccent` (`#568FF7` dark, AppColors.swift:53-59) — a token bypass on the first branded moment of the app. Violates Platform Fidelity (hit target) + Consistency (tokens).
- **Location:** `apps/ios/0dteTrader/App/RootView.swift:70-73`, `apps/ios/0dteTrader/App/ZeroDTETraderApp.swift:7-11`
- **Exact fix:**

```swift
Button("Unlock") {
    Task { await lockManager.unlock() }
}
.buttonStyle(.borderedProminent)
.controlSize(.large)          // 50pt tall
.tint(.appAccent)
```

and once, globally, in `ZeroDTETraderApp`:

```swift
WindowGroup {
    RootView(container: container)
        .tint(.appAccent)
}
```

### [P2] — Bare spinner for every cold start; no branding, no tint, no skeleton

- **What/Why:** `restoreSession()` always performs a network refresh (SessionStore.swift:43-45), so _every_ cold launch shows `ProgressView("Restoring session…")` for ~200ms–2s. The spinner is the default gray (un-tinted), there is no wordmark/logo, and a spinner is used where the audit bar demands a skeleton or branded splash. This is the app's first impression and it currently reads as "generic template." Violates State Coverage (skeletons > spinners) + Composition (branding/hierarchy).
- **Location:** `apps/ios/0dteTrader/App/RootView.swift:48-49`
- **Exact fix:** Replace with a branded splash that mirrors the eventual trade-screen anchor layout:

```swift
case .checking:
    VStack(spacing: 24) {
        Image(systemName: "chart.line.uptrend.xyaxis")   // or real logo asset
            .font(.system(size: 56, weight: .semibold))
            .foregroundStyle(Color.appAccent)
            .accessibilityHidden(true)
        ProgressView("Restoring session…")
            .controlSize(.large)
            .tint(.appAccent)
            .foregroundStyle(.secondary)
    }
    .offset(y: -40)   // optical centering: block sits ~46% from top, not dead 50%
```

### [P3] — Lock-screen content sits at dead geometric center; no optical centering, no brand moment

- **What/Why:** Reconstructed layout: VStack height ≈ 44 (glyph) + 16 + ~20 (headline) + 16 + ~34 (button) ≈ 130pt, centered on 932pt → block top ≈ 401pt (43%) but visual mass centroid is at exactly 50%. Optically centered compositions place mass at ~45–46% height (≈ golden-ratio 38/62 split inverted). The screen also wastes its one guaranteed daily impression: no wordmark, no Face ID affordance, no personality. Violates Composition (golden-ratio placement) at nit level.
- **Location:** `apps/ios/0dteTrader/App/RootView.swift:61-77`
- **Exact fix:**

```swift
VStack(spacing: 16) {
    Image(systemName: "lock.fill")
        .font(.system(size: 44))
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
    Text("0dteTrader is locked")
        .font(.headline)
    Button {
        Task { await lockManager.unlock() }
    } label: {
        Label("Unlock with Face ID", systemImage: "faceid")
    }
    .buttonStyle(.borderedProminent)
    .controlSize(.large)
    .tint(.appAccent)
}
.offset(y: -32)   // raises mass centroid to ≈ 46.5% of 932pt
```

### [P3] — Failed Face ID gives zero feedback; no haptics, no escape hatch

- **What/Why:** On failed/cancelled auth, `unlock()` just sets `isLocked = true` again (AppLockManager.swift:40) — the overlay sits there visually unchanged, so the user can't tell the attempt failed vs. never registered. There is also no path out: a user whose biometrics keep failing can't reach Login to re-authenticate (must force-quit). Violates Motion & Micro-interactions (feedback) + State Coverage (error state) + A11y (status not announced).
- **Location:** `apps/ios/0dteTrader/Features/Profile/AppLockManager.swift:32-41`, `apps/ios/0dteTrader/App/RootView.swift:61-77`
- **Exact fix:**

```swift
// AppLockManager
@Published private(set) var lastAttemptFailed = false
// after isLocked = !success:
if !success {
    UINotificationFeedbackGenerator().notificationOccurred(.error)
    lastAttemptFailed = true
}

// lockOverlay, under the headline:
if lockManager.lastAttemptFailed {
    Text("Couldn't verify — try again")
        .font(.subheadline)
        .foregroundStyle(Color.sellRed)
}
Button("Sign in with password instead") {
    Task { await authViewModel.logout() }   // routes to LoginView
}
.buttonStyle(.borderless)
```

### [P3] — Every measurement is a magic number; no spacing/radius/motion tokens exist

- **What/Why:** `44` (icon size, RootView.swift:66), `16` (VStack spacing, :64), and animation durations (currently absent) are inline literals. The DesignSystem defines color + type tokens only (AppColors.swift, AppTypography.swift) — there is no `AppSpacing`/`AppMotion`, so this screen cannot be consistent by construction and will drift from every other screen's one-off values. Violates Consistency (tokens) at the systemic level.
- **Location:** `apps/ios/0dteTrader/App/RootView.swift:64-66`; absence in `apps/ios/0dteTrader/DesignSystem/`
- **Exact fix:** Add to the DesignSystem and consume here:

```swift
// DesignSystem/AppSpacing.swift
enum AppSpacing {
    static let md: CGFloat = 16   // 8pt grid: 4/8/16/24/32
    static let lg: CGFloat = 24
}
enum AppIconSize {
    static let hero: CGFloat = 44
}
// RootView: VStack(spacing: AppSpacing.md), .font(.system(size: AppIconSize.hero))
```

## Quick wins vs structural work

**Landable in <1 hour:**

- `.tint(.appAccent)` at the `WindowGroup` root + `.controlSize(.large)` on Unlock (fixes P2 button color/size in ~4 lines).
- `.animation(.easeInOut(duration: 0.2), value: lockManager.isLocked)` — revives the dead opacity transition.
- `.accessibilityHidden(lockManager.isLocked)` on `content` + `.isModal` trait + `.accessibilityHidden(true)` on the lock glyph (VoiceOver leak, ~3 lines).
- Lock on `.inactive` (snapshot race) — one `case` line.
- Tint + `.controlSize(.large)` on the `ProgressView`; `.offset(y: -32)` optical centering.
- Failure haptic + "Couldn't verify — try again" label.

**Needs refactor / design work:**

- `.restoreFailed` offline/error state: requires `SessionStore` to stop swallowing `URLError`, a new `AuthViewModel.State` case, and a designed retry screen (touches networking + auth + UI).
- Auth-state `.id()`/`.transition` system: easy mechanically, but must be regression-tested against `TradeScreenView`'s socket lifecycle (state flips currently tear down/recreate the trade screen).
- Always-on privacy shield for the app switcher (independent of `appLockEnabled`) — product decision + new view.
- `AppSpacing`/`AppMotion` token layer across the DesignSystem — cross-screen rollout, not a one-file change.
- Branded splash (real logo asset, trade-screen skeleton) — needs design assets.
