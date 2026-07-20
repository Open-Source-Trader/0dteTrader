# Screen i8: Floating trade buttons

- **App:** iOS
- **Location:** `apps/ios/0dteTrader/Features/Trade/FloatingTradeButtons.swift:6-21`, `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:5-51`; layout host `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:161-172`; tokens `DesignSystem/AppColors.swift:35-50`, `DesignSystem/AppTypography.swift`
- **Visual:** screenshot `docs/ui-audit/shots/08-trade-fullscreen.png` (desktop clone, disabled state — verified pixels) + mathematical reconstruction of enabled state from code (no macOS/Xcode)
- **Scores:** Composition 7/10 · Typography 6/10 · Color 4/10 · Density 7/10 · DataViz 4/10 · Motion 4/10 · States 5/10 · Platform 7/10 · A11y 5/10 · Consistency 5/10 → **Overall 54/100**
- **Score justifications:**
  - Composition 7 — equal 187pt/187pt split with 16pt gutter and 20pt margins is the correct dual-primary pattern (50/50 is right for BUY/SELL parity; golden ratio doesn't apply to a symmetrical action pair), but `VStack(spacing: 10)` at TradeScreenView.swift:165 breaks the 4pt grid and the buttons carry zero elevation shadow over the chart.
  - Typography 6 — `.headline` (17pt semibold) scales with Dynamic Type and grows past `minHeight: 52`, but it's not a design-token font, all-caps "SELL"/"BUY" gets no tracking, and there's no secondary price/qty line.
  - Color 4 — white on `buyGreen` dark variant (0.098/0.722/0.357, L≈0.353) = **2.6:1**, fails WCAG AA even for large text (3:1); white on `sellRed` (L≈0.194) = 4.3:1, passes large-text only; disabled `color.opacity(0.35)` produces a muddy ~10:1-text-on-dark-blob that reads as "surface," not "disabled action."
  - Density 7 — exactly two full-width primaries, zero clutter, positions strip correctly stacked above; capped because the buttons carry no price/qty context (Robinhood/TradingView quick-trade shows it).
  - DataViz 4 — verified in the screenshot: the last-price line and chart gridlines run directly behind the SELL/BUY buttons; no bottom content inset on the chart, no scrim — the single most important number on a 0DTE screen is occludable.
  - Motion 4 — `Haptics.impact(.medium)` on tap is right, but `.buttonStyle(.plain)` gives **zero** visual press feedback (no scale/opacity), no enable/disable transition, nothing gated on Reduce Motion.
  - States 5 — only enabled/disabled; disabled is unexplained (screenshot shows dead buttons with the reason stranded mid-screen as chart text) and `canTrade` (TradeScreenView.swift:267-274) ignores socket connectivity, so buttons look live while quotes are stale.
  - Platform 7 — 52pt targets (≥44pt HIG ✓), safe-area respected (12pt above home indicator, verified at y≈885pt of 932pt in the shot), haptics present; `QuickChipButton` is a ~32pt target (✗) and no SF Symbols anywhere.
  - A11y 5 — labels exist and `.disabled` announces "dimmed," but labels are bare "SELL"/"BUY" with no hint of what arming does, disabled keeps text at full white opacity (affordance inversion), and the green fill fails contrast for low-vision users.
  - Consistency 5 — `buyGreen`/`sellRed`/`appSurfaceElevated` tokens used ✓, but `.white` is hardcoded and every dimension (16, 20, 52, 12, 0.35, 14, 8) is an inline literal — the project has no spacing/radius/motion tokens and these files add nine more one-offs.

## Findings

### [P1] — White label on `buyGreen` is 2.6:1 — fails WCAG AA even for large text (needs 3:1)

- **What/Why:** `foregroundStyle(.white)` (TradeButtons.swift:18) over dark-mode `buyGreen` `UIColor(red: 0.098, green: 0.722, blue: 0.357)` (AppColors.swift:38). Relative luminance L≈0.353 → contrast = 1.05/0.403 ≈ **2.6:1**; AA large-text floor is 3:1, normal text 4.5:1. The BUY label — the app's #1 money action — is the least legible text on screen. Violates Color & A11y. The same applies in light mode (3.56:1, below 4.5:1).
- **Location:** `apps/ios/0dteTrader/DesignSystem/AppColors.swift:35-41`
- **Exact fix:** darken the dark-mode green to the light-mode value (3.56:1, passes AA large text and matches cross-mode brand):
  ```swift
  static let buyGreen = Color(
      uiColor: UIColor { traits in
          traits.userInterfaceStyle == .dark
              ? UIColor(red: 0.078, green: 0.612, blue: 0.302, alpha: 1) // 3.56:1 vs white
              : UIColor(red: 0.078, green: 0.612, blue: 0.302, alpha: 1)
      }
  )
  ```
  (Single-value `UIColor(red: 0.078, green: 0.612, blue: 0.302, alpha: 1)` is equivalent; keep the closure only if modes may diverge later.)

### [P1] — Zero visual press feedback on the app's two most important buttons

- **What/Why:** `.buttonStyle(.plain)` (TradeButtons.swift:24) with no custom style → touch-down produces no scale, opacity, or brightness change; only the haptic fires. Violates Motion (120–250ms eased press state) — this is the Robinhood-grade micro-interaction bar. Also nothing respects Reduce Motion because there is no motion to reduce.
- **Location:** `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:11-27`
- **Exact fix:** add a style in TradeButtons.swift and use it:
  ```swift
  struct TradeActionButtonStyle: ButtonStyle {
      @Environment(\.accessibilityReduceMotion) private var reduceMotion
      func makeBody(configuration: Configuration) -> some View {
          configuration.label
              .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
              .opacity(configuration.isPressed ? 0.85 : 1)
              .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
      }
  }
  ```
  then replace `.buttonStyle(.plain)` with `.buttonStyle(TradeActionButtonStyle())` at TradeButtons.swift:24.

### [P1] — Floating buttons occlude the last-price line; no scrim, no chart bottom inset

- **What/Why:** In `ZStack(alignment: .bottom)` (TradeScreenView.swift:163-172) the chart gets no bottom content inset, and the button stack has no background protection. Verified in `shots/08-trade-fullscreen.png`: the dashed last-price line runs straight behind the SELL/BUY buttons (y≈1742px of 1864). On a 0DTE chart the latest price is the highest-value pixel; it can hide under a 52pt button. Violates DataViz and Composition.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:163-172`
- **Exact fix:** convert the overlay to a `safeAreaInset` (reserves chart space) with a gradient scrim:
  ```swift
  case .fullscreen:
      // Layout A — FR-10.
      chartView
          .safeAreaInset(edge: .bottom, spacing: 0) {
              VStack(spacing: 8) {
                  positionsStrip
                  FloatingTradeButtons(isEnabled: canTrade) { side in
                      tradeViewModel.arm(side: side, underlying: chartViewModel.symbol, chainViewModel: chainViewModel)
                  }
              }
              .padding(.top, 24)
              .padding(.bottom, 12)
              .background(
                  LinearGradient(
                      colors: [Color.appBackground.opacity(0), Color.appBackground.opacity(0.85)],
                      startPoint: .top, endPoint: .bottom
                  )
                  .ignoresSafeArea(edges: .bottom)
              )
          }
  ```

### [P1] — `QuickChipButton` hit target ≈32pt — below the 44pt HIG minimum

- **What/Why:** caption font (~13pt line box) + `.padding(.vertical, 8)` (TradeButtons.swift:44) ⇒ ~29–32pt tall target. These chips step order quantity — a mis-tap changes order size. Violates Platform (≥44pt) and A11y hit areas. It also has no `isEnabled` support, unlike its sibling.
- **Location:** `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:35-50`
- **Exact fix:** keep the capsule look, expand the hit area:
  ```swift
  Text(title)
      .font(.chipLabel)
      .foregroundStyle(.primary)
      .padding(.horizontal, 14)
      .frame(minWidth: 44, minHeight: 44)
      .background(Color.appSurfaceElevated)
      .clipShape(Capsule())
      .contentShape(Capsule())
  ```
  (drop `.padding(.vertical, 8)`; the 44pt frame replaces it.)

### [P2] — Disabled state is muddy, inverted, and unexplained

- **What/Why:** `background(isEnabled ? color : color.opacity(0.35))` (TradeButtons.swift:20) dims only the fill while text stays full white — affordance inversion (the label is now the brightest element, contrast ~10:1 against the washed fill). Worse, nothing says _why_ they're dead: `canTrade` (TradeScreenView.swift:267-274) is false when no contract is selected, and the screenshot shows the explanation stranded as chart-center text. Violates States (actionable) and Color.
- **Location:** `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:16-25`, `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:266-274`
- **Exact fix:** dim the whole control uniformly and add a reason hint:
  ```swift
  // TradeActionButton label — replace conditional background with:
  .background(color)
  .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
  .contentShape(Rectangle())
  .opacity(isEnabled ? 1 : 0.45)
  ```
  and in `FloatingTradeButtons.body` add below the HStack when `!isEnabled`:
  ```swift
  if !isEnabled {
      Text("Select a contract to trade")
          .font(.footnote)
          .foregroundStyle(.secondary)
  }
  ```

### [P2] — VoiceOver gets bare "SELL"/"BUY" with no action context

- **What/Why:** `.accessibilityLabel(title)` (TradeButtons.swift:26) tells a VoiceOver user the word but not the consequence (arms a ticket with AUTO +1 OTM defaults and opens a confirm sheet) nor why it's dimmed. Violates A11y (color/state-independent meaning, actionable labels).
- **Location:** `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:26`
- **Exact fix:**
  ```swift
  .accessibilityLabel(title == "BUY" ? "Buy" : "Sell")
  .accessibilityHint(isEnabled
      ? "Arms an order ticket with the current defaults and opens confirmation"
      : "Unavailable. Select a contract first.")
  ```

### [P2] — Buttons appear live while the quote socket is down

- **What/Why:** `canTrade` only checks contract selection (TradeScreenView.swift:267-274); `QuoteSocketClient.connectionState` (Core/Networking/QuoteSocketClient.swift:17) is ignored, so with a disconnected socket the user arms a ticket priced off stale data. Violates State Coverage (offline).
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:266-274`
- **Exact fix:**
  ```swift
  private var canTrade: Bool {
      guard container.quoteSocket.connectionState == .connected else { return false }
      switch tradeViewModel.assetClass {
      case .option:  return chainViewModel.selectedContract != nil
      case .future:  return tradeViewModel.selectedFuture != nil
      }
  }
  ```
  and surface the reason in the disabled caption from finding #5: `"Reconnecting to quotes…"` when `connectionState != .connected`.

### [P2] — 10pt stack spacing breaks the 4pt grid

- **What/Why:** `VStack(spacing: 10)` between positions strip and buttons (TradeScreenView.swift:165) is the only non-4pt-multiple in the block (16, 20, 52, 12 all conform). Invisible in isolation, corrosive to rhythm when the strip wraps to two rows. Violates Composition.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:165`
- **Exact fix:** `VStack(spacing: 12)` (pairs with the existing `.padding(.bottom, 12)` for a consistent 12pt vertical rhythm).

### [P3] — Nine inline magic numbers; zero spacing/radius/opacity tokens

- **What/Why:** 16 & 20 (FloatingTradeButtons.swift:11,19), 52, 12, 0.35 (TradeButtons.swift:19,20,21), 14 & 8 (TradeButtons.swift:43-44), 10 & 12 (TradeScreenView.swift:165,171) — plus hardcoded `.white` (TradeButtons.swift:18). The design system has colors and type only; every new screen re-rolls these dice. Violates Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Trade/FloatingTradeButtons.swift:11,19`; `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:18-21,43-44`
- **Exact fix:** add to the design system and adopt here:
  ```swift
  // DesignSystem/AppMetrics.swift
  enum AppMetrics {
      static let gutter: CGFloat = 20        // screen horizontal padding
      static let stackM: CGFloat = 16        // sibling action spacing
      static let stackS: CGFloat = 12        // related-cluster spacing
      static let touchTarget: CGFloat = 44
      static let actionHeight: CGFloat = 52
      static let radiusM: CGFloat = 12
      static let disabledOpacity = 0.45
  }
  ```
  then `HStack(spacing: AppMetrics.stackM)`, `.padding(.horizontal, AppMetrics.gutter)`, `minHeight: AppMetrics.actionHeight`, `cornerRadius: AppMetrics.radiusM`, `.opacity(isEnabled ? 1 : AppMetrics.disabledOpacity)`.

### [P3] — No elevation: flat buttons sit directly on chart ink

- **What/Why:** A floating control over a live chart needs separation; these have no shadow (TradeButtons.swift:19-21), so gridlines visually intersect the fill at fill edges (visible in the screenshot around both buttons). Violates Composition/Platform (iOS floating-element idiom).
- **Location:** `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:19-21`
- **Exact fix:** after `.clipShape(...)`:
  ```swift
  .shadow(color: .black.opacity(0.35), radius: 12, x: 0, y: 4)
  ```
  (harmless alongside the scrim from finding #3 — the scrim handles content legibility, the shadow handles element separation.)

### [P3] — Buttons carry no price context; identical haptics for opposite actions

- **What/Why:** TradingView/Robinhood quick-trade surfaces the actionable number on the button ("BUY 545.20") and differentiates direction. Here both buttons fire the same `Haptics.impact(.medium)` (TradeButtons.swift:13) and show a bare verb — the user must glance elsewhere to know what price they're arming at. This is the "holy shit" gap. Violates Density/Motion polish.
- **Location:** `apps/ios/0dteTrader/Features/Trade/FloatingTradeButtons.swift:12-17`, `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:12-14`
- **Exact fix:** extend `TradeActionButton` with an optional subtitle and per-side haptic:
  ```swift
  // TradeActionButton: add `var subtitle: String? = nil`, then in label:
  VStack(spacing: 2) {
      Text(title).font(.headline)
      if let subtitle {
          Text(subtitle).font(.priceSmall).opacity(0.85)   // tabular digits
      }
  }
  .foregroundStyle(.white)
  // and in the action closure:
  Haptics.impact(title == "SELL" ? .rigid : .medium)
  ```
  call-site: `TradeActionButton(title: "BUY", subtitle: midPriceText, color: .buyGreen, …)` using the existing monospaced `priceSmall` token so ticking prices don't shift layout.

## Quick wins vs structural work

**<1 hour:**

- Darken `buyGreen` dark variant (finding #1) — one-line token change.
- Add `TradeActionButtonStyle` press feedback (#2) — ~10 lines.
- Uniform `.opacity(0.45)` disabled treatment + "Select a contract to trade" caption (#5).
- `VStack(spacing: 12)` grid fix (#8).
- VoiceOver hints (#6), shadow (#10), QuickChip 44pt frame (#4).

**Structural:**

- `safeAreaInset` + scrim re-layout of the fullscreen case (#3) — touches chart geometry; verify indicator panes/divider math.
- Connectivity-aware `canTrade` (#7) — needs the view model/container observed object to republish `connectionState` into `TradeScreenView`'s view hierarchy.
- `AppMetrics` token introduction (#9) — mechanical but should be swept across all screens at once to avoid two conventions coexisting.
- Price-bearing buttons (#11) — requires piping live mid/last into `FloatingTradeButtons` without re-render churn (monospaced font + value-based animation).
