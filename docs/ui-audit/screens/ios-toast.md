# Screen i12: Toast overlay

- **App:** iOS
- **Location:** `apps/ios/0dteTrader/Features/Trade/ToastView.swift` (whole file, 35 lines) + usage in `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:68-76`; model/dismiss logic in `apps/ios/0dteTrader/Features/Trade/TradeViewModel.swift:3-19, 371-385`
- **Visual:** UNVERIFIED-VISUAL — no macOS/Xcode available; layout reconstructed mathematically from frames/paddings in code
- **Scores:** Composition 5/10 · Typography 7/10 · Color 4/10 · Density 8/10 · DataViz 8/10 · Motion 4/10 · States 6/10 · Platform 4/10 · A11y 3/10 · Consistency 5/10 → **Overall 54/100**
- **Score justifications:**
  - Composition 5 — centered pill with on-grid 16pt outer margins is sound, but the capsule is placed at y=4 from the _physical_ screen top (safe-area violation, collides with status bar/Dynamic Island) and inner paddings 14/10 break the 8pt grid.
  - Typography 7 — `.footnote.weight(.medium)` (13pt) scales with Dynamic Type and is a reasonable single-style choice for a banner; no token used and no line-limit/multiline design for long error strings.
  - Color 4 — text on capsule is 14.1:1 (excellent), but the _only_ style signal is a 1pt stroke at 0.6 opacity: error red = 2.26:1 and info accent = 2.53:1, both failing WCAG 3:1 for UI components; icons are untinted (`.primary`).
  - Density 8 — one icon + one line of text is exactly right for a toast; nothing extraneous. Criterion otherwise N/A (no secondary data hierarchy on a toast).
  - DataViz 8 — not applicable (no charts/axes/skeletons on a toast); scored neutral-high because nothing here violates data-viz discipline.
  - Motion 4 — 200ms is inside the 120–250ms bar, but `.easeInOut` instead of a spring is robotic for iOS, and `.move(edge: .top)` has no Reduce Motion fallback.
  - States 6 — success/error/info styles all mapped, but no offline variant, no action/retry affordance, no queue (new toast silently replaces old), fixed 3s for all message lengths.
  - Platform 4 — SF Symbols + haptics on success/error are good, but the toast ignores the top safe area, is not tappable/dismissable, and has no sheet/banner-standard behavior.
  - A11y 3 — Dynamic Type works and `Label` gives VoiceOver the message text, but appearance is never announced to VoiceOver, meaning is carried partly by a sub-3:1 colored ring, and no reduce-motion handling.
  - Consistency 5 — all values inline (14/10/16/4/1pt/6pt/0.2s/3s) with no spacing/radius/motion tokens (none exist project-wide); success/error reuse P&L tokens (`pnlPositive`/`pnlNegative`) for non-P&L semantics, and `buyGreen` vs `systemGreen` means two different greens ship in one app.

## Findings

### [P0] — Toast renders inside the status bar / Dynamic Island region

- **What/Why:** `.overlay(alignment: .top)` is applied to the root `NavigationStack` (`TradeScreenView.swift:68`), whose frame is the full physical screen — overlays do not inherit safe-area insets. With `.padding(.top, 4)` the capsule (≈36pt tall: 13pt footnote + 2×10pt padding) occupies y=4…40pt, i.e. entirely inside the ~59pt status-bar region. On Dynamic-Island iPhones the horizontally centered pill sits directly behind the Island; the clock is overlapped on the left. This is a visibly broken layout on every single toast — violates Platform Fidelity (safe areas) and Composition. Measurable gap: capsule top edge is 59−4 = **55pt above the safe-area top**.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:68-76`
- **Exact fix:** move the overlay inside the `NavigationStack` content so its frame starts below the top bar, and use a spring (see P2 motion fix). Replace `TradeScreenView.swift:38-76` structure so the overlay/animation attach to `layoutContent`:

```swift
NavigationStack {
    layoutContent
        .background(Color.appBackground)
        .overlay(alignment: .top) {
            if let toast = tradeViewModel.toast {
                ToastView(toast: toast)
                    .padding(.top, 8)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                    .zIndex(1)
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.8), value: tradeViewModel.toast)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { /* …unchanged… */ }
}
```

and add `@Environment(\.accessibilityReduceMotion) private var reduceMotion` to `TradeScreenView`. (Sheets and `.task`s stay on the `NavigationStack` as today.)

### [P1] — Style tint is a sub-3:1 1pt ring; icons untinted

- **What/Why:** The entire success/error/info signal is `Capsule().stroke(tint.opacity(0.6), lineWidth: 1)` (`ToastView.swift:31`). Blended over `appSurfaceElevated` (#282B35 dark): error red = **2.26:1**, info accent = **2.53:1** (both fail WCAG 1.4.11's 3:1 for UI components); success green = 3.44:1 (barely passes). Meanwhile the SF Symbol icon gets `.foregroundStyle(.primary)` (`ToastView.swift:26`), so all three styles render the same-color icon — at a glance an order rejection looks identical to an order fill. Violates Color & Contrast + Accessibility (color-independent meaning is carried by glyph shape alone, and the ring is nearly invisible).
- **Location:** `apps/ios/0dteTrader/Features/Trade/ToastView.swift:24-31`
- **Exact fix:** tint the icon at full strength (full-strength tint on the capsule = error 4.14:1, info 4.48:1, success 6.98:1 — all pass 3:1), raise the ring to 0.9 opacity, and add a 15% tint wash for unmissable semantics. Replace `ToastView.body`:

```swift
var body: some View {
    HStack(spacing: 6) {
        Image(systemName: icon)
            .foregroundStyle(tint)
        Text(toast.message)
            .foregroundStyle(.primary)
            .lineLimit(2)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }
    .font(.footnote.weight(.medium))
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .background(Color.appSurfaceElevated)
    .background(tint.opacity(0.15))
    .clipShape(Capsule())
    .overlay(Capsule().stroke(tint.opacity(0.9), lineWidth: 1))
    .shadow(color: .black.opacity(0.5), radius: 8, x: 0, y: 2)
    .padding(.horizontal, 16)
}
```

### [P1] — Toast appearance is never announced to VoiceOver

- **What/Why:** The toast is inserted via `overlay` + transition (`TradeScreenView.swift:69-74`); VoiceOver focus stays wherever it was and the message is never spoken. An order-rejection toast is the _only_ feedback for a failed submission (`TradeViewModel.swift:100, 249, 272-281`) — a VoiceOver user gets zero feedback that their order failed. Violates Accessibility (status messages must be programmatically determinable, WCAG 4.1.3).
- **Location:** `apps/ios/0dteTrader/Features/Trade/ToastView.swift:23-34`
- **Exact fix:** announce on appear, mark as a single combined element:

```swift
var body: some View {
    content
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
        .onAppear {
            // Delay lets the move transition settle so the announcement isn't clipped.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                AccessibilityNotification.Announcement(toast.message).post()
            }
        }
}
```

(`content` = the `HStack` from the P1 tint fix above.)

### [P2] — Ease-in-out slide instead of a spring; no Reduce Motion fallback

- **What/Why:** `.animation(.easeInOut(duration: 0.2), …)` (`TradeScreenView.swift:76`) with `.move(edge: .top)` (`:72`). The 200ms duration is in range, but `easeInOut` has no overshoot/settle — Robinhood/Apple-class banners use springs (`.snappy` / `spring(response:dampingFraction:)`). Worse, with **Reduce Motion** enabled the pill still flies in from off-screen; HIG requires cross-fade only. Violates Motion & Micro-interactions + Accessibility.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:72, 76`
- **Exact fix:** covered in the P0 fix code above: `.transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))` and `.animation(.spring(response: 0.35, dampingFraction: 0.8), value: tradeViewModel.toast)`, plus the `reduceMotion` environment property.

### [P2] — Off-grid paddings (14/10) and no geometry tokens

- **What/Why:** `.padding(.horizontal, 14)` / `.padding(.vertical, 10)` (`ToastView.swift:27-28`) — both break the 8pt grid (should be 16/12 or 16/8). Combined with inline 16, 4, 1, 6 (`:31-33`) and `0.2`/`3_000_000_000` magic numbers (`TradeScreenView.swift:76`, `TradeViewModel.swift:381`), the toast is a microcosm of the project-wide gap: there are **no spacing/radius/motion tokens** anywhere in `apps/ios/0dteTrader/DesignSystem/`, so every component invents its own numbers. Violates Composition (8pt grid) + Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Trade/ToastView.swift:27-33`
- **Exact fix:** short-term use the grid-corrected values in the P1 tint fix (`horizontal 16`, `vertical 12`, shadow `radius: 8, y: 2`). Structural: add `AppSpacing.swift` to `DesignSystem/` with `static let xs: CGFloat = 4, sm = 8, md = 12, lg = 16, xl = 24` and `AppMotion.swift` with `static let toastSpring = Animation.spring(response: 0.35, dampingFraction: 0.8)`; adopt in ToastView first.

### [P2] — Fixed 3s dismiss; no tap-to-dismiss; error text can be long

- **What/Why:** `showToast` sleeps exactly 3s for every style (`TradeViewModel.swift:381`). API error strings (`error.userMessage`, e.g. `TradeViewModel.swift:100, 272`) can run 80+ chars — ~10s of reading time at WCAG's guidance — yet vanish in 3s; conversely the user can't dismiss an error banner early (no `onTapGesture`, capsule is non-interactive). Also no `.lineLimit` (`ToastView.swift:24`), so a long string wraps into a tall, ugly multi-line capsule. Violates State Coverage + Platform Fidelity.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeViewModel.swift:379-384`, `apps/ios/0dteTrader/Features/Trade/ToastView.swift:24`
- **Exact fix:** in `TradeViewModel.showToast` (`:381`) use style-dependent duration: `try? await Task.sleep(nanoseconds: style == .error ? 5_000_000_000 : 3_000_000_000)`. In `ToastView` add manual dismiss via a tap that clears the view-model toast — change `ToastView` to take `let onDismiss: () -> Void` and append `.contentShape(Capsule()).onTapGesture(perform: onDismiss)`; call site becomes `ToastView(toast: toast, onDismiss: { tradeViewModel.toast = nil })` (`TradeScreenView.swift:70`). With the tap, the capsule must be ≥44pt tall — the `vertical: 12` padding in the P1 fix yields ≈40pt, so use `.padding(.vertical, 14)` and `.frame(minHeight: 44)`. Line limit covered by `.lineLimit(2)` in the P1 fix.

### [P2] — No toast queue: new toast silently replaces the old one

- **What/Why:** `showToast` overwrites `self.toast` unconditionally (`TradeViewModel.swift:373`). Realistic sequence: "Order cancelled." (info, `:350`) followed <100ms later by a rejected order update from the socket (`:362-365`) — the cancel confirmation never renders at all. For a trading app, swallowed order-status feedback is a correctness-of-feedback problem, not just polish. Violates State Coverage.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeViewModel.swift:371-385`
- **Exact fix:** minimal queue in `TradeViewModel`:

```swift
private var toastQueue: [Toast] = []

func showToast(_ message: String, style: Toast.Style) {
    let toast = Toast(message: message, style: style)
    if style == .success { Haptics.success() } else if style == .error { Haptics.error() }
    toastQueue.append(toast)
    guard self.toast == nil else { return }   // one in flight; queue drains in dismiss task
    showNextToast()
}

private func showNextToast() {
    guard let next = toastQueue.first else { return }
    self.toast = next
    toastDismissTask?.cancel()
    toastDismissTask = Task { [weak self] in
        try? await Task.sleep(nanoseconds: next.style == .error ? 5_000_000_000 : 3_000_000_000)
        guard let self, !Task.isCancelled else { return }
        self.toastQueue.removeFirst { $0.id == next.id }
        self.toast = nil
        try? await Task.sleep(nanoseconds: 250_000_000) // let exit transition finish
        self.showNextToast()
    }
}
```

### [P3] — Semantic token misuse + two competing greens

- **What/Why:** `Toast.Style.success → Color.pnlPositive` and `.error → Color.pnlNegative` (`ToastView.swift:9-10`). Those tokens are documented "P&L / price-change colors for text on app surfaces" (`AppColors.swift:63-65`) — an order _status_ is not P&L. Meanwhile `buyGreen` (0.098, 0.722, 0.357) and `pnlPositive` (`systemGreen`) are two visually different greens, so the toast's success green matches neither the Buy button nor anything else consistently. Violates Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Trade/ToastView.swift:7-13`, `apps/ios/0dteTrader/DesignSystem/AppColors.swift:63-65`
- **Exact fix:** add dedicated status tokens to `AppColors.swift` and use them in `ToastView`:

```swift
/// Order/operation status colors (toasts, badges) — distinct from P&L text colors.
static let statusSuccess = Color.buyGreen
static let statusError = Color.sellRed
static let statusInfo = Color.appAccent
```

then `case .success: return .statusSuccess; case .error: return .statusError; case .info: return .statusInfo` in `ToastView.tint`. (Also unifies the toast green with the Buy button.)

### [P3] — Error icon is a warning triangle; shadow is invisible

- **What/Why:** Two nits. (a) `exclamationmark.triangle.fill` (`ToastView.swift:18`) is SF Symbols' _warning_ glyph; an order rejection is an error — Apple uses `xmark.circle.fill` or `exclamationmark.circle.fill` for that. (b) `.shadow(radius: 6)` (`:32`) uses the default black at ~33% on a near-black `appBackground` (0.043, 0.047, 0.063) — the elevation cue is effectively invisible, so the capsule floats only via its ring; with the P1 tint-wash the shadow should deepen, not vanish. Violates Platform Fidelity (glyph semantics) + Composition (elevation hierarchy).
- **Location:** `apps/ios/0dteTrader/Features/Trade/ToastView.swift:18, 32`
- **Exact fix:** `case .error: return "xmark.circle.fill"` at `:18`; shadow already replaced with `.shadow(color: .black.opacity(0.5), radius: 8, x: 0, y: 2)` in the P1 fix.

## Quick wins vs structural work

**<1 hour:**

- Move overlay onto `layoutContent` + spring + reduce-motion transition (P0 + P2 motion) — ~10 lines in `TradeScreenView.swift`.
- Tint icon, 0.9 ring, 15% wash, grid-corrected padding, `.lineLimit(2)` (P1 tint + P2 grid) — rewrite of `ToastView.body`.
- VoiceOver announcement `onAppear` (P1 a11y) — 4 lines.
- Error icon swap to `xmark.circle.fill`; shadow color/offset (P3) — 2 lines.

**Structural:**

- Toast queue in `TradeViewModel` + style-dependent durations + tap-to-dismiss plumbing (P2 ×3) — touches `TradeViewModel`, `ToastView`, `TradeScreenView`; needs a queue-drain test.
- `AppSpacing`/`AppMotion` design tokens in `DesignSystem/` and app-wide adoption (P2 consistency) — repo-wide refactor, toast is just the first adopter.
- `statusSuccess`/`statusError`/`statusInfo` tokens and audit of every `pnlPositive/pnlNegative` misuse for non-P&L semantics (P3) — requires sweeping other feature views.
