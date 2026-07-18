# Screen i5: Trade screen — Layout A (fullscreen)
- **App:** iOS
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift` (fullscreen branch :160-172, toolbar :42-66, toast overlay :68-76, `canTrade` :267-274, `toggleLayout` :276-280) · `apps/ios/0dteTrader/Features/Trade/FloatingTradeButtons.swift` (whole file) · supporting: `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:5-28` (`TradeActionButton`), `apps/ios/0dteTrader/Features/Trade/PositionsStripView.swift`, `apps/ios/0dteTrader/Features/Trade/ToastView.swift`
- **Visual:** UNVERIFIED-VISUAL — no macOS/Xcode available; layout reconstructed from code (ZStack bottom-overlay: `PositionsStripView` + `FloatingTradeButtons`, `VStack(spacing: 10)`, `.padding(.bottom, 12)`, buttons `minHeight: 52`, `HStack(spacing: 16)`, `.padding(.horizontal, 20)`). Desktop 430×932 clone reference `docs/ui-audit/shots/08-trade-fullscreen.png` was read and used to confirm the rendered result (muted/disabled SELL-BUY dock at bottom, plain-text chart error, no scrim).
- **Scores:** Composition 6/10 · Typography 5/10 · Color 4/10 · Density 6/10 · DataViz 5/10 · Motion 4/10 · States 4/10 · Platform 6/10 · A11y 5/10 · Consistency 4/10 → **Overall 49/100**
- **Score justifications:**
  - Composition 6 — clean full-bleed chart + symmetric dual-CTA dock, but `VStack(spacing: 10)` (TradeScreenView:165) and `.padding(.bottom, 12)` (:171) sit off the 8pt grid, and the strip+button stack floats over the chart with no anchoring scrim.
  - Typography 5 — buttons use `.font(.headline)` instead of a design-system token (TradeButtons.swift:17), and strip prices/P&L use proportional `.caption2`/`.caption` (PositionsStripView:81,84) instead of the monospaced `Font.priceSmall` token, so ticking values shift chip width.
  - Color 4 — white `.headline` on `buyGreen` (#19B85B dark) measures ≈2.6:1, failing even the 3:1 large-text floor (TradeButtons.swift:16-20 + AppColors.swift:38); SELL ≈4.3:1 fails 4.5:1 normal-text AA.
  - Density 6 — floating dock keeps chart density maximal (good TradingView instinct), but the fullscreen mode surfaces zero contract context (no selected strike/expiry/price anywhere) next to its trade CTAs.
  - DataViz 5 — overlay stack (strip + 52pt buttons + 10/12pt gaps ≈ 130-190pt) permanently occludes the bottom of the chart including the time axis with no fade/scrim; error state is bare centered text (ChartView.swift:48-50).
  - Motion 4 — toast animation is a correct 0.2s easeInOut (TradeScreenView:76) but ignores Reduce Motion, layout toggle is an instant jump-cut (:276-280), and buttons have no pressed state (`.buttonStyle(.plain)`, TradeButtons.swift:24).
  - States 4 — disabled BUY/SELL in fullscreen is a dead end with no explanation or recovery path (see P1-1); strip has no loading skeleton; chart error has no action button.
  - Platform 6 — 52pt targets, haptics, SF Symbols, and safe-area-respecting dock are correct; but the toast slides in over the navigation bar and blocks all three toolbar buttons while visible (:68-76).
  - A11y 5 — `person.circle` toolbar button has no accessibilityLabel (:43-49, the other two have them), SELL/BUY labels lack hints (:26), and disabled buttons announce nothing about why.
  - Consistency 4 — magic numbers everywhere: 16/20 (FloatingTradeButtons.swift:11,19), 52/12/0.35 (TradeButtons.swift:19-21), 10/12 (TradeScreenView:165,171), 7/10/0.5 (PositionsStripView:87-93); zero spacing/radius tokens exist to reference.

## Findings

### [P1] — Fullscreen layout is a trading dead end: BUY/SELL disabled with no explanation and no in-mode recovery
- **What/Why:** `canTrade` (TradeScreenView:267-274) requires `chainViewModel.selectedContract != nil` / `selectedFuture != nil`, but contract selection UI lives only in `TradePanelView`, which exists only in Layout B (:183-191). A user who toggles into fullscreen before ever selecting a contract gets two permanently dimmed buttons (`color.opacity(0.35)`, TradeButtons.swift:20) with no label, no hint, no tooltip — the desktop-clone screenshot `08-trade-fullscreen.png` shows exactly this: muted SELL/BUY with zero explanation. Violates State Coverage + Information Density; core CTA silently inert in a shipped mode.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:266-274`, `apps/ios/0dteTrader/Features/Trade/FloatingTradeButtons.swift:10-20`, `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:20`
- **Exact fix:** (a) Add a disabled-state caption under the buttons in `FloatingTradeButtons.swift`:
```swift
VStack(spacing: 8) {
    HStack(spacing: 16) { /* existing buttons */ }
        .padding(.horizontal, 20)
    if !isEnabled {
        Text("Select a contract in split view to trade")
            .font(.chipLabel)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Color.appSurface.opacity(0.9))
            .clipShape(Capsule())
    }
}
```
and (b) in `TradeButtons.swift:26` add `.accessibilityHint(isEnabled ? "Arms an order ticket" : "Disabled. Select a contract in split view first.")`. Longer term, add a compact contract chip (e.g. `SPY 550C 0DTE · $1.23`) above the buttons that opens the chain — that restores mode independence.

### [P1] — BUY label contrast ≈2.6:1 on buyGreen; fails WCAG even at the 3:1 large-text floor
- **What/Why:** White `.headline` on `buyGreen` dark value `rgb(0.098, 0.722, 0.357)` ≈ #19B85B: relative luminance ≈0.355 → contrast vs white = 1.05/0.405 ≈ **2.6:1** (needs ≥4.5:1 body, ≥3:1 large). SELL on `sellRed` #E13A43 ≈ **4.3:1** (fails 4.5:1 normal-text). On the screen's primary money-moving CTAs this is below the Apple/Robinhood bar. Violates Color & Contrast.
- **Location:** `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:16-20`, token source `apps/ios/0dteTrader/DesignSystem/AppColors.swift:35-50`
- **Exact fix:** Darken the fills used behind white text. In `AppColors.swift:38-39` change dark `buyGreen` to `UIColor(red: 0.055, green: 0.545, blue: 0.267, alpha: 1)` (#0E8B44, ≈4.6:1 with white) and dark `sellRed` (:47-48) to `UIColor(red: 0.792, green: 0.173, blue: 0.208, alpha: 1)` (#CA2C35, ≈5.6:1, matching the existing light-mode value). If the brighter green is wanted for accents, add a separate `buyGreenAction` token rather than reusing the accent for text-bearing fills.

### [P1] — Toast slides in over the navigation bar and blocks all toolbar buttons
- **What/Why:** `.overlay(alignment: .top)` is attached to the `NavigationStack` (:68), so the toast's top anchor is the screen top edge of the nav stack; with only `.padding(.top, 4)` (:71) the capsule covers the inline title bar — while a 3-4s order-result toast is up, Profile / History / Layout-toggle buttons are untappable (toast has no hit-testing exemption and sits at `zIndex(1)`). 4pt is also off the 4pt grid baseline used elsewhere (it should align below the bar, not over it). Violates Platform Fidelity + State Coverage.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:68-76`
- **Exact fix:** Move the overlay inside the content, below the bar:
```swift
layoutContent
    .background(Color.appBackground)
    .overlay(alignment: .top) {
        if let toast = tradeViewModel.toast {
            ToastView(toast: toast)
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
                .zIndex(1)
        }
    }
```
(attach to `layoutContent` at :39 instead of the `NavigationStack`), and add `.allowsHitTesting(false)` on the `ToastView` so it never swallows taps.

### [P1] — Strip + button dock occludes ~15-20% of the chart with no scrim; strip prices use proportional fonts and jitter on ticks
- **What/Why:** The bottom overlay stack = positions strip (chips `padding .vertical 7`, 3 text lines ≈ 56pt/row × up to 2 rows) + `spacing: 10` + 52pt buttons + 12pt bottom ≈ **130-190pt of 932pt (14-20%)** permanently covering the chart's time axis and recent candles, with solid `appSurface` chips and button fills and no gradient scrim behind them (screenshot confirms hard overlap). Additionally `Format.price(position.avgPrice)` uses `.font(.caption2)` and P&L `.font(.caption.weight(.semibold))` (PositionsStripView:80-85) — proportional fonts, so live P&L ticks resize chips horizontally; the design system already has `Font.priceSmall` (monospaced, AppTypography.swift:8) for exactly this. Violates DataViz + Typography + Composition.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:163-172`, `apps/ios/0dteTrader/Features/Trade/PositionsStripView.swift:80-94`
- **Exact fix:** In `PositionsStripView.swift:81` → `.font(.priceSmall)` and :84 → `.font(.priceSmall.weight(.semibold))`. In `TradeScreenView.swift:165-171`, add a scrim under the dock:
```swift
VStack(spacing: 8) {
    positionsStrip
    FloatingTradeButtons(isEnabled: canTrade) { side in ... }
}
.padding(.bottom, 12)
.background(
    LinearGradient(colors: [.clear, .appBackground],
                   startPoint: .top, endPoint: .bottom)
        .ignoresSafeArea(edges: .bottom)
)
```
(and change `spacing: 10` → `8` to restore the 8pt grid).

### [P2] — Trade buttons have no pressed state; haptic fires but pixels don't move
- **What/Why:** `.buttonStyle(.plain)` (TradeButtons.swift:24) means touch-down produces zero visual change — no opacity, no scale. For the two highest-stakes buttons in the app this kills the Robinhood-grade "alive" feel. Violates Motion & Micro-interactions.
- **Location:** `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:24`
- **Exact fix:** Replace `.buttonStyle(.plain)` with an inline style:
```swift
private struct PressableButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
    }
}
// usage: .buttonStyle(PressableButtonStyle())
```

### [P2] — Layout toggle is an instant jump-cut; toast transition ignores Reduce Motion
- **What/Why:** `toggleLayout()` (:276-280) flips `layout` with no `.animation`, so the entire screen restructures (chart ↔ split panel) in one frame — jarring for a persisted, user-facing mode switch. The toast uses `.move(edge: .top)` (:72) under `.easeInOut(duration: 0.2)` (:76) with no `accessibilityReduceMotion` branch. Violates Motion.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:72,76,276-280`
- **Exact fix:** In `toggleLayout()`: `withAnimation(.snappy(duration: 0.25)) { layout = ... }`. For the toast, add `@Environment(\.accessibilityReduceMotion) private var reduceMotion` and use `.transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))`.

### [P2] — Magic numbers throughout; no spacing/radius/opacity tokens exist or are referenced
- **What/Why:** Hardcoded: `HStack(spacing: 16)`, `.padding(.horizontal, 20)` (FloatingTradeButtons.swift:11,19); `minHeight: 52`, `cornerRadius: 12`, `opacity(0.35)` (TradeButtons.swift:19-21); `spacing: 10`, `.padding(.bottom, 12)` (TradeScreenView:165,171); `spacing: 6/8`, `padding 10/7`, `cornerRadius: 10`, `lineWidth: 0.5`, `stroke opacity 0.5` (PositionsStripView:16,19,87-93); toast `14/10/16`, `shadow(radius: 6)`, `stroke opacity 0.6` (ToastView.swift:27-33). `7` and `10` break the 4pt grid; nothing is named, so the desktop clone must re-derive each value by eye. Violates Consistency.
- **Location:** as listed above
- **Exact fix:** Create `apps/ios/0dteTrader/DesignSystem/AppSpacing.swift`:
```swift
enum Spacing { static let xs: CGFloat = 4; static let sm: CGFloat = 8
               static let md: CGFloat = 16; static let lg: CGFloat = 20 }
enum Radius { static let chip: CGFloat = 10; static let button: CGFloat = 12 }
enum HitTarget { static let tradeButton: CGFloat = 52 }
```
then replace: `spacing: 16` → `Spacing.md`, `padding(.horizontal, 20)` → `Spacing.lg`, `minHeight: 52` → `HitTarget.tradeButton`, `cornerRadius: 12` → `Radius.button`, `spacing: 10` → `Spacing.sm`, chip `padding(.vertical, 7)` → `8`.

### [P2] — Chart error state is bare text with no action, directly behind the trade CTAs
- **What/Why:** `Text(errorMessage)` (ChartView.swift:48-50) renders the screenshot's centered "No Webull credentials on file — save app key/secret in Profile first" — gray text, no icon, no button, while telling the user to go to Profile. Meanwhile SELL/BUY remain visible and tappable-looking below it. Error must be actionable (Apple HIG: "give people a way to recover"). Violates State Coverage.
- **Location:** `apps/ios/0dteTrader/Features/Chart/ChartView.swift:48-50` (surfaced on this screen)
- **Exact fix:**
```swift
ContentUnavailableView {
    Label("Market data unavailable", systemImage: "chart.xyaxis.line")
} description: {
    Text(errorMessage)
} actions: {
    Button("Open Profile") { showProfile = true } // pass a closure down from TradeScreenView
        .buttonStyle(.borderedProminent)
}
```
(TradeScreenView already owns `showProfile`; thread `onOpenProfile: { showProfile = true }` through `chartView` at :199-205.)

### [P2] — Accessibility gaps on toolbar and CTAs
- **What/Why:** `person.circle` button (:43-49) has no `.accessibilityLabel` (the history and layout buttons have them — inconsistent VoiceOver output: image-name fallback vs clean labels). `TradeActionButton` label is only "SELL"/"BUY" with no hint that it arms a ticket rather than executing, and the disabled state announces no reason. The divider-style risk: P&L in chips is color + sign (`Format.signedPrice`), which passes color-independence, but the strip's flatten/cancel affordance is tap-on-chip with no visible affordance icon. Violates Accessibility + Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:43-49`, `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:26`
- **Exact fix:** Add `.accessibilityLabel("Profile")` at :49; in `TradeButtons.swift:26` replace with:
```swift
.accessibilityLabel(title)
.accessibilityHint(isEnabled
    ? "Arms a \(title.lowercased()) order ticket for review"
    : "Disabled. Select a contract in split view first.")
```

### [P3] — Dock elevation and spacing polish
- **What/Why:** Buttons have no shadow/elevation, so candles and axis labels passing beneath visually collide with the fills (screenshot shows the flat merge); SELL sits left / BUY right while Robinhood convention leads with the primary (BUY) on the right — acceptable, but the green should be visually dominant when enabled and it's identical in weight. `padding(.bottom, 12)` leaves the 52pt dock floating 12pt above the home indicator with the toast gap `4` and stack gap `10` rounding out a trio of off-grid values (4/10/12).
- **Location:** `apps/ios/0dteTrader/Features/Trade/FloatingTradeButtons.swift:10-20`, `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:19-22`
- **Exact fix:** After `.clipShape(...)` in `TradeButtons.swift:21` add `.shadow(color: .black.opacity(0.35), radius: 8, y: 4)`; change TradeScreenView:171 to `.padding(.bottom, 16)` (8pt grid) and :165 to `spacing: 8`.

## Quick wins vs structural work
**<1 hour:**
- BUY/SELL fill darkening (AppColors.swift values swap)
- `.accessibilityLabel("Profile")` + CTA hints
- `PressableButtonStyle` on trade buttons
- `withAnimation(.snappy(duration: 0.25))` on layout toggle; Reduce Motion toast transition
- `.font(.priceSmall)` for strip prices/P&L; spacing 10→8, padding 12→16
- Toast: move overlay to `layoutContent`, `.allowsHitTesting(false)`, padding 4→8
- Button shadow; gradient scrim behind the dock

**Structural:**
- Compact contract-selector chip in fullscreen mode (removes the P1 dead end properly; needs chain UI reachable from Layout A)
- `AppSpacing.swift` / radius / hit-target token system + sweep of all inline values (blocks desktop token parity too)
- Actionable chart error state (threading `onOpenProfile` through `chartView`)
