# Screen i18: iOS Design System (cross-cutting deep dive)

- **App:** iOS
- **Location:** `apps/ios/0dteTrader/DesignSystem/AppColors.swift:6-66`, `AppTypography.swift:5-12`, `TradeButtons.swift:5-51`, `Haptics.swift:4-20`, `Formatters.swift:4-26` + bypass grep across `Features/**`
- **Visual:** UNVERIFIED-VISUAL — code-only unit; layout reconstructed from frames/paddings/stack spacings in the source
- **Scores:** Composition 6/10 · Typography 5/10 · Color 5/10 · Density 7/10 · DataViz 5/10 · Motion 3/10 · States 4/10 · Platform 5/10 · A11y 4/10 · Consistency 4/10 → **Overall 48/100**
- **Score justifications:**
  - **Composition 6:** rhythm is mostly 8pt-based but has no spacing tokens and leaks off-grid values (7pt chip padding `PositionsStripView.swift:88`, 14pt `TradeButtons.swift:43`, 18pt divider `TradeScreenView.swift:223`, 34pt minHeight `TradePanelView.swift:146`).
  - **Typography 5:** monospaced price tokens are the right idea, but `priceLarge`/`priceSmall` are dead code (zero call sites), P&L renders in proportional `.caption` (`PositionsStripView.swift:84`, `HistoryView.swift:88`), and one-off display fonts bypass the scale (`LoginView.swift:20`, `RootView.swift:66`).
  - **Color 5:** semantic palette is genuine (dark/light adaptive), but white-on-`buyGreen` is 2.61:1 (fails AA even for large text), and `appBorder` is 1.65:1 vs background (fails 3:1 non-text).
  - **Density 7:** TradingView-grade density in the panel/chips with a clear primary/secondary split; docked because the chart header's _last price_ — the single most important number — renders at body size (`ChartView.swift:133`).
  - **DataViz 5:** gridline restraint is good (separator @ 0.25 alpha, `CandleChartRepresentable.swift:66,83`), but there is no crosshair/tooltip (`highlightPerTapEnabled = false`, line 57), no overlay color legend, and pane axis labels drop to 9pt (`IndicatorPaneRepresentable.swift:49`).
  - **Motion 3:** exactly one animation in the app (`.easeInOut(0.2)` toast, `TradeScreenView.swift:76`); zero springs, zero press states (`.buttonStyle(.plain)` everywhere), no reduce-motion handling, and a 30fps CADisplayLink that redraws even when idle (`DrawingOverlayView.swift:64-73`).
  - **States 4:** spinners for every load (8 `ProgressView` sites, zero skeletons), text-only errors, no offline/reconnecting banner; only `OrderConfirmSheet` has a retry affordance (`OrderConfirmSheet.swift:56-59`).
  - **Platform 5:** haptics + SF Symbols + safe areas are solid, but multiple hit targets are 29–31pt (44pt minimum): qty steppers 30×30 (`TradePanelView.swift:210,224`), header circle buttons ~31pt (`ChartView.swift:166-168,203-205`), QuickChips ~29pt (`TradeButtons.swift:43-44`).
  - **A11y 4:** P&L is color-independent (signed strings — good) and some labels exist, but contrast fails above, VoiceOver can't operate the resizable divider (label only, no adjustable action, `TradeScreenView.swift:249`), and the drawing canvas is invisible to VoiceOver.
  - **Consistency 4:** two different greens for the same P&L meaning (`HistoryView.swift:53` uses `buyGreen`, `PositionsStripView.swift:85` uses `pnlPositive`), hardcoded `.orange`/`.white`/raw `UIColor`s, duplicated `0.35` disabled opacity in 4 files, 4 ad-hoc corner radii (2.5/8/10/12).

## Findings

### [P1] — White BUY label on buyGreen fill is 2.61:1, fails WCAG AA even for large text

- **What/Why:** `TradeActionButton` renders `.headline` white text on `buyGreen` #19B85B: measured 2.61:1 vs the 3:1 large-text / 4.5:1 normal-text AA floor. SELL on `sellRed` #E13A43 is 4.30:1 (passes large, fails normal), login/confirm accent buttons white-on-`appAccent` #568FF7 are 3.15:1 (fails normal). These are the two most-tapped controls in a trading app — the primary action affordance is the least legible text in the product. Violates Color&Contrast + A11y.
- **Location:** `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:18-20` (via `AppColors.swift:35-41`); same pattern at `LoginView.swift:65-66`, `RegisterView.swift:69-70`, `OrderConfirmSheet.swift:86-88`, `RiskDisclaimerView.swift:28-30`.
- **Exact fix:** darken the _fill_ variants (keep bright greens for text/icon accents, which already pass on dark backgrounds — buyGreen-on-background is 7.49:1). In `AppColors.swift:35-59` add fill tokens (verified ratios):
  ```swift
  /// Button-fill variants: white text on these is ≥4.5:1 (WCAG AA).
  static let buyGreenFill = Color(uiColor: UIColor { t in
      t.userInterfaceStyle == .dark
          ? UIColor(red: 0.051, green: 0.498, blue: 0.247, alpha: 1)  // #0D7F3F — white 5.09:1
          : UIColor(red: 0.043, green: 0.42, blue: 0.205, alpha: 1)
  })
  static let sellRedFill = Color(uiColor: UIColor { t in
      t.userInterfaceStyle == .dark
          ? UIColor(red: 0.776, green: 0.157, blue: 0.157, alpha: 1)  // #C62828 — white 5.62:1
          : UIColor(red: 0.69, green: 0.13, blue: 0.16, alpha: 1)
  })
  static let appAccentFill = Color(uiColor: UIColor { t in
      t.userInterfaceStyle == .dark
          ? UIColor(red: 0.231, green: 0.435, blue: 0.831, alpha: 1)  // #3B6FD4 — white 4.76:1
          : UIColor(red: 0.16, green: 0.37, blue: 0.78, alpha: 1)
  })
  ```
  Then change `TradeActionButton` call sites to `.buyGreenFill`/`.sellRedFill` (`TradePanelView.swift:33,36`, `FloatingTradeButtons.swift:12,15`), `OrderConfirmSheet.swift:10` to return fill tokens, and `LoginView.swift:65`/`RegisterView.swift:69`/`RiskDisclaimerView.swift:30` to `Color.appAccentFill`.

### [P1] — `appBorder` (separator) is 1.65:1 on appBackground; used for interactive grabber and chip strokes

- **What/Why:** `appBorder = UIColor.separator` (#545458 @ 60%) blends to ~1.65:1 on `appBackground` — below the 3:1 WCAG non-text contrast floor for UI components. Worse: `PositionsStripView.swift:93,125` strokes chips with `appBorder.opacity(0.5)` (~1.3:1, effectively invisible), the Layout-B resize divider grabber (`TradeScreenView.swift:226-228`) is rendered in it, and `OrderConfirmSheet.swift:15-17` hides the system drag indicator (`presentationDragIndicator(.hidden)`, line 98) and redraws it in this same near-invisible color. Violates Color&Contrast + Platform Fidelity.
- **Location:** `apps/ios/0dteTrader/DesignSystem/AppColors.swift:61`; consumers `TradeScreenView.swift:227`, `OrderConfirmSheet.swift:16`, `PositionsStripView.swift:93,125`.
- **Exact fix:** replace line 61 with a dedicated border token (white @ 36% on appBackground = 3.26:1, verified):
  ```swift
  /// 3.26:1 on appBackground — passes WCAG 3:1 non-text contrast.
  static let appBorder = Color(uiColor: UIColor { t in
      t.userInterfaceStyle == .dark
          ? UIColor(white: 1, alpha: 0.36)
          : UIColor(white: 0, alpha: 0.24)
  })
  ```
  In `PositionsStripView.swift:93,125` drop the extra `.opacity(0.5)` (stroke the token directly, keep `lineWidth: 0.5`). Keep the custom grabber but it now inherits the compliant token.

### [P1] — Hit targets below the 44pt HIG minimum on trade-critical controls

- **What/Why:** measured from code: quantity steppers are `30×30` (`TradePanelView.swift:210,224`); `QuickChipButton` is caption (~12pt line) + 2×8pt padding ≈ **29pt tall** (`TradeButtons.swift:43-44`); chart header circle buttons are subheadline glyph (~15pt) + 2×8pt ≈ **31pt** (`ChartView.swift:163-168`, `200-205`); the order-chip cancel "x" is a bare ~17pt glyph (`PositionsStripView.swift:113`); the Layout-B divider drag strip is **18pt** (`TradeScreenView.swift:223`). On a 0DTE app where a missed tap is money, this is below Robinhood/Apple bar. Violates Platform Fidelity + A11y.
- **Location:** listed above.
- **Exact fix:**
  - `TradePanelView.swift:210,224`: `.frame(width: 30, height: 30)` → `.frame(width: 44, height: 44)` (keep the 30pt visual circle via `.background(Circle().fill(Color.appSurfaceElevated).frame(width: 30, height: 30))` and add `.contentShape(Rectangle())`).
  - `TradeButtons.swift:43-44`: after the paddings add `.frame(minHeight: 44)` before `.background`, or reduce to `.padding(.horizontal, 14).padding(.vertical, 11)` plus `.contentShape(Capsule())`.
  - `ChartView.swift:166,203`: change `.padding(8)` → `.padding(12)` (glyph 15 + 24 ≈ 39pt) and add `.frame(width: 44, height: 44)` with `.contentShape(Circle())`.
  - `PositionsStripView.swift:113-115`: add `.frame(width: 44, height: 44)` and `.contentShape(Rectangle())` to the cancel button label.
  - `TradeScreenView.swift:223`: `private let dividerHeight: CGFloat = 18` → `44` (the 48×5 grabber pill stays visually identical).

### [P1] — P&L and quantities render in proportional fonts; tick updates shift layout

- **What/Why:** the DS's stated rule ("Prices use monospaced digits so ticking quotes don't shift layout", `AppTypography.swift:3-4`) is violated by its own consumers: position-chip unrealized P&L uses `.caption.weight(.semibold)` (`PositionsStripView.swift:84`), history realized P&L same (`HistoryView.swift:88`), the header bid/ask line is `.caption2` (`ChartView.swift:135`), and `Format.signedPrice` output changes width every tick (`+1.24` → `-0.87` glyph widths differ in proportional SF). On a live P&L this visibly jitters — the exact amateur tell the tokens exist to prevent. Also `priceLarge`/`priceSmall` (`AppTypography.swift:6,8`) have **zero call sites** — dead tokens, while the chart header's last price uses body-size `.priceMedium` (`ChartView.swift:133`) instead of the intended hero size. Violates Typography + Density.
- **Location:** `AppTypography.swift:6-8`; `PositionsStripView.swift:84`; `HistoryView.swift:88`; `ChartView.swift:133,135`.
- **Exact fix:** add the missing size to `AppTypography.swift`:
  ```swift
  static let priceCaption = Font.system(.caption, design: .monospaced).weight(.semibold)
  static let priceCaption2 = Font.system(.caption2, design: .monospaced)
  ```
  Apply: `PositionsStripView.swift:84` → `.font(.priceCaption)`; `HistoryView.swift:88` → `.font(.priceCaption)`; `ChartView.swift:135` → `.font(.priceCaption2)`; `ChartView.swift:133` → `.font(.priceLarge)` (activates the dead token and restores price hierarchy in the header).

### [P1] — Same semantic (P&L green/red) rendered by two different token pairs across screens

- **What/Why:** `HistoryView.swift:53,89,111-112` uses `buyGreen`/`sellRed` (#19B85B/#E13A43) for P&L and status text; `PositionsStripView.swift:85` and `ProfileView.swift:65,88,93` use `pnlPositive`/`pnlNegative` (`.systemGreen` #30D158 / `.systemRed` #FF453A). Two visibly different greens for the same meaning, one navigation push apart. Violates Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Trade/HistoryView.swift:53,89,111-113`.
- **Exact fix:** in `HistoryView.swift` replace `Color.buyGreen` → `Color.pnlPositive` and `Color.sellRed` → `Color.pnlNegative` at lines 53, 89, 111, 112. (All four are text-on-background contexts where pnl tokens have better contrast: 9.67:1 / 5.74:1 vs 7.49:1 / 4.55:1.)

### [P2] — No spacing / radius / elevation / motion token layer; 30+ inline magic values

- **What/Why:** the DS has color + type + 2 components but **no dimensional tokens at all**. Inline values found: paddings 2/4/6/7/8/10/12/14/16/20/24/32 (7pt at `PositionsStripView.swift:88,120`, 14pt at `TradeButtons.swift:43` and `ToastView.swift:27` break the 8pt grid); stack spacings 0/1/2/6/8/10/12/14/16/20/24; corner radii **2.5, 8, 10, 12** + Capsule (`TradeScreenView.swift:226`, `TradePanelView.swift:149`, `PositionsStripView.swift:90`, `OrderConfirmSheet.swift:65`); one `shadow(radius: 6)` with no color/y (`ToastView.swift:32`); one animation `.easeInOut(0.2)` (`TradeScreenView.swift:76`); disabled opacity `0.35` hand-duplicated in 4 files (`TradeButtons.swift:20`, `OrderConfirmSheet.swift:88`, `LoginView.swift:65`, `RegisterView.swift:69`); minHeights 34/50/52 ad hoc. Violates Consistency + Composition.
- **Location:** throughout `Features/**` (refs above).
- **Exact fix:** add `DesignSystem/AppTokens.swift`:
  ```swift
  import SwiftUI
  enum AppSpacing { static let xxs: CGFloat = 2; static let xs: CGFloat = 4
      static let sm: CGFloat = 8; static let md: CGFloat = 12; static let lg: CGFloat = 16
      static let xl: CGFloat = 24; static let xxl: CGFloat = 32 }
  enum AppRadius { static let sm: CGFloat = 8; static let md: CGFloat = 10; static let lg: CGFloat = 12 }
  enum AppElevation { static let toast = (color: Color.black.opacity(0.4), radius: CGFloat(8), y: CGFloat(4)) }
  enum AppMotion { static let quick = Animation.snappy(duration: 0.15)
      static let standard = Animation.spring(response: 0.3, dampingFraction: 0.8) }
  extension Color { static let disabledOpacity = 0.35 }  // or a `Dim` enum
  ```
  Migrate: 7→8 (`PositionsStripView.swift:88,120`), 14→12 or 16 (`TradeButtons.swift:43`), radii 2.5 stays a one-off for the grabber but 8/10/12 become `AppRadius.*`, `ToastView.swift:32` → `.shadow(color: AppElevation.toast.color, radius: AppElevation.toast.radius, y: AppElevation.toast.y)`.

### [P2] — No press state on any custom button; zero springs anywhere

- **What/Why:** every custom control uses `.buttonStyle(.plain)` (`TradeButtons.swift:24,49`, `TradePanelView.swift:214,228`, `PositionsStripView.swift:96,116`, `LoginView.swift:69`, `OrderConfirmSheet.swift:91`), so touches give no visual feedback — haptics fire but pixels don't move. The only animation in the app is the toast's easeInOut. Robinhood-grade feel needs press scale + spring. Violates Motion & Micro-interactions.
- **Location:** `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:24,49` (+ call sites above).
- **Exact fix:** add to `TradeButtons.swift`:
  ```swift
  struct PressableButtonStyle: ButtonStyle {
      func makeBody(configuration: Configuration) -> some View {
          configuration.label
              .scaleEffect(configuration.isPressed ? 0.97 : 1)
              .opacity(configuration.isPressed ? 0.85 : 1)
              .animation(.snappy(duration: 0.15), value: configuration.isPressed)
      }
  }
  ```
  Replace `.buttonStyle(.plain)` with `.buttonStyle(PressableButtonStyle())` at the call sites listed. Change the toast animation at `TradeScreenView.swift:76` to `.animation(.spring(response: 0.3, dampingFraction: 0.8), value: tradeViewModel.toast)`.

### [P2] — Hardcoded raw colors bypass tokens (and one silently forks the accent)

- **What/Why:** bypasses found: `DrawingOverlayView.swift:38` hardcodes `UIColor(red: 0.337, green: 0.561, blue: 0.969)` — a hand-copy of `appAccent`'s dark value that will drift if the token changes and never adapts to light mode; `OrderConfirmSheet.swift:47` `.orange` warning (no warning token exists); `DrawingOverlayView.swift:39` `.systemOrange`, `:336` `.black`, `:350` `.white`; `ChartView.swift:23-30` a per-feature hardcoded overlay palette (`.systemOrange/.systemCyan/.systemPurple/.systemGray/.systemTeal`) plus `:60,76-77,91-92,104` pane colors; `CandleChartRepresentable.swift:112-114,136-137` `.systemGreen/.systemRed/.systemBlue`; `OrderConfirmSheet.swift:86`, `LoginView.swift:66`, `RegisterView.swift:70`, `RiskDisclaimerView.swift:28` hardcoded `.white` label color (breaks if fills ever flip light). Also **no global tint**: `ZeroDTETraderApp.swift:7-11` never sets `.tint(.appAccent)`, so Form toggles, the `.borderedProminent` Unlock button (`RootView.swift:73`) and Form buttons render default iOS blue — a third blue in the product. Violates Color&Contrast + Consistency.
- **Location:** refs above.
- **Exact fix:**
  - In `AppColors.swift` add `static let appWarning = Color(uiColor: .systemOrange)` and expose UIKit twins: `extension UIColor { static let appAccent = UIColor(Color.appAccent) }` (or move the dynamic providers into UIColor-first definitions shared by both). `DrawingOverlayView.swift:38` → `private let accentColor = UIColor.appAccent`.
  - `OrderConfirmSheet.swift:47` → `.foregroundStyle(Color.appWarning)`; `DrawingOverlayView.swift:39` → `UIColor.appWarning`.
  - `ZeroDTETraderApp.swift`: `RootView(container: container).tint(.appAccent)`.
  - Move `ChartView.swift:23-30` into the DS as `enum ChartPalette { static let overlayColors: [String: UIColor] = [...] }` so desktop/iOS chart palettes share one source of truth.

### [P2] — Loading states are 100% spinners, zero skeletons; no offline/reconnecting state

- **What/Why:** 8 `ProgressView` sites (`ChartView.swift:45`, `HistoryView.swift:22`, `RootView.swift:49`, `TradePanelView.swift:132`, `OrderConfirmSheet.swift:34,79`, `ProfileView.swift:53`, `WebullCredentialsForm.swift:30`, `PositionsStripView.swift:76`) and no `.redacted`/shimmer anywhere — the chart area is a blank dark rect + spinner on every symbol switch, which reads as "app froze" on a slow socket. `QuoteSocketClient` reconnects (`RootView.swift:35`) with no UI signal — a trader can stare at a stale price with zero indication the stream is dead. Violates State Coverage.
- **Location:** `apps/ios/0dteTrader/Features/Chart/ChartView.swift:44-47`; `App/RootView.swift:35,49`; `Core/Networking/QuoteSocketClient.swift` (state exists, no UI consumer).
- **Exact fix:**
  - Chart loading: replace the bare spinner with the last candle set dimmed + redacted overlay — in `ChartView.swift:44-47`: `CandleChartRepresentable(...)` keeps rendering cached candles, and overlay `ProgressView()` only when `viewModel.candles.isEmpty`; add `.redacted(reason: .placeholder)` skeleton rows for `HistoryView` (3 `HistoryRow` placeholders with `Text("0000.00").redacted(reason: .placeholder)`).
  - Offline: surface `quoteSocket` connection state as a banner above the positions strip — `TradeScreenView.swift` overlay: `if !quoteSocket.isConnected { Label("Reconnecting…", systemImage: "wifi.exclamationmark").font(.caption).foregroundStyle(.white).padding(.horizontal, 12).padding(.vertical, 6).background(Color.sellRed).clipShape(Capsule()) }` with the toast spring.

### [P2] — Disabled buttons keep full-opacity white labels; reads "enabled" and fails the meaning of disabled

- **What/Why:** `TradeActionButton` dims only the fill (`color.opacity(0.35)`) while the white `.headline` stays at 100% opacity (`TradeButtons.swift:18-20`) — measured 11.31:1 label contrast in the _disabled_ state, i.e. the label is as loud as enabled text and the two states differ only by fill brightness (and not at all for color-blind users in some conditions). HIG convention is to dim the whole control. Violates A11y + Color.
- **Location:** `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:16-22`; same pattern `OrderConfirmSheet.swift:86-88`, `LoginView.swift:63-66`, `RegisterView.swift:67-70`.
- **Exact fix:** in `TradeButtons.swift` label builder: `.foregroundStyle(.white.opacity(isEnabled ? 1 : 0.55))` (and same at the other three sites), or simply drop the manual fill swap and rely on `.disabled` + `.brightness(isEnabled ? 0 : -0.15)` on the label. Also centralize the `0.35` per the token finding above.

### [P2] — No reduce-motion handling; drawing overlay burns a 30fps CADisplayLink when idle

- **What/Why:** the toast transition (`TradeScreenView.swift:72,76`) slides regardless of the Reduce Motion setting; `DrawingOverlayView.tick()` calls `setNeedsDisplay()` 30×/s for the entire app lifetime (`DrawingOverlayView.swift:64-73`) even with zero drawings — measurable battery/GPU cost on a screen traders keep open all day. Violates Motion + A11y.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:68-76`; `Features/Chart/DrawingOverlayView.swift:59-73`.
- **Exact fix:** in `TradeScreenView` add `@Environment(\.accessibilityReduceMotion) private var reduceMotion` and use `.transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))`. In `DrawingOverlayView`, delete the `CADisplayLink` and call `setNeedsDisplay()` from `model.objectWillChange` (ChartDrawingsModel is an ObservableObject) and after each gesture state change — drawing/alert edits already funnel through `model.add/update/updateAlert`.

### [P3] — 9pt axis labels on indicator panes, inconsistent with the 10pt main chart

- **What/Why:** `IndicatorPaneRepresentable.swift:49` sets pane label font at 9pt while `CandleChartRepresentable.swift:65,82` uses 10pt — below the comfortable legibility floor on a 460ppi phone and visually mismatched when panes stack. Violates Typography + DataViz.
- **Location:** `apps/ios/0dteTrader/Features/Chart/IndicatorPaneRepresentable.swift:49`.
- **Exact fix:** `.monospacedDigitSystemFont(ofSize: 9, weight: .regular)` → `.monospacedDigitSystemFont(ofSize: 10, weight: .regular)`.

### [P3] — No crosshair / OHLC inspection on the chart

- **What/Why:** `highlightPerTapEnabled = false` and no long-press highlight (`CandleChartRepresentable.swift:57`) — there is no way to read an exact candle's OHLC or a precise price/time, table stakes for the TradingView bar this app cites. Violates DataViz.
- **Location:** `apps/ios/0dteTrader/Features/Chart/CandleChartRepresentable.swift:56-57`.
- **Exact fix:** set `chart.highlightPerTapEnabled = true` with `chart.highlightPerDragEnabled = true`, style the highlight: `candleSet.highlightColor = UIColor.appAccent; candleSet.highlightLineWidth = 0.5; candleSet.highlightLineDashLengths = [4, 4]`, and render the highlighted candle's OHLC in the header slot (bind via `ChartViewDelegate` `chartValueSelected` into `ChartViewModel.highlightedCandle`, displayed with `.priceCaption` at `ChartView.swift:131-137`).

### [P3] — One-off fonts bypass the type scale

- **What/Why:** `.largeTitle.bold()` (`LoginView.swift:20`), `.title.bold()` (`RiskDisclaimerView.swift:11`), `.title3.bold()` (`OrderConfirmSheet.swift:21`), `.system(size: 44)` fixed-size glyph (`RootView.swift:66`) — four ad-hoc display styles with no token; the 44pt icon ignores Dynamic Type. Violates Typography + Consistency.
- **Location:** refs above.
- **Exact fix:** add to `AppTypography.swift`: `static let screenTitle = Font.title.bold()` and `static let heroTitle = Font.largeTitle.bold()`; use them at the three text sites. `RootView.swift:66` → `Image(systemName: "lock.fill").font(.largeTitle).foregroundStyle(.secondary)` (or keep 44 via `.imageScale(.large)` + symbol configuration that scales).

### [P3] — `Format.price` never groups thousands; large futures prices render as raw digits

- **What/Why:** `String(format: "%.2f")` (`Formatters.swift:6`) renders ES at `6543.25` instead of `6,543.25`; position notional/buying power (`OrderConfirmSheet.swift:43` `estBuyingPower`) can reach 5–6 digits with no grouping — harder to parse at a glance mid-trade. Violates Density/legibility.
- **Location:** `apps/ios/0dteTrader/DesignSystem/Formatters.swift:5-7`.
- **Exact fix:**
  ```swift
  private static let priceFormatter: NumberFormatter = {
      let f = NumberFormatter(); f.numberStyle = .decimal
      f.minimumFractionDigits = 2; f.maximumFractionDigits = 2
      f.groupingSeparator = ","; f.usesGroupingSeparator = true
      return f
  }()
  static func price(_ value: Double, fractionDigits: Int = 2) -> String {
      priceFormatter.minimumFractionDigits = fractionDigits
      priceFormatter.maximumFractionDigits = fractionDigits
      return priceFormatter.string(from: NSNumber(value: value)) ?? String(format: "%.\(fractionDigits)f", value)
  }
  ```

### [P3] — Drawing canvas and resize divider are VoiceOver-inaccessible

- **What/Why:** `TradeScreenView.swift:249` gives the divider a label but no `.accessibilityAdjustableAction`, so VoiceOver users cannot resize the panel at all; `DrawingOverlayView` annotations exist only in `draw(_:)` with zero accessibility elements. Violates A11y.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:249`; `Features/Chart/DrawingOverlayView.swift:257-268`.
- **Exact fix:** on the divider add `.accessibilityAdjustableAction { direction in splitFraction = min(0.5, max(0.25, splitFraction + (direction == .increment ? 0.05 : -0.05))) }` and `.accessibilityValue("\(Int(splitFraction * 100)) percent panel height")`. For the canvas, add one `UIAccessibilityElement` per drawing ("Trend line at 5,432.50") in `CandleChartRepresentable.ContainerView.layoutSubviews`.

## Quick wins vs structural work

**Landable in <1 hour:**

- P1 white-on-green: add `buyGreenFill`/`sellRedFill`/`appAccentFill` tokens and swap 6 call sites.
- P1 border token: one-line `appBorder` replacement + drop two `.opacity(0.5)`.
- P1 monospaced P&L: add `priceCaption`/`priceCaption2`, flip 4 `.font()` call sites + `priceLarge` in the header.
- P1 HistoryView green/red unification (4 symbol swaps).
- P3 9pt→10pt pane labels; P3 zero-Dynamic-Type lock glyph; P3 global `.tint(.appAccent)`; P2 `.orange` → `appWarning`; P2 UIKit accent twin for `DrawingOverlayView.swift:38`; P3 thousands grouping in `Format.price`.

**Needs refactor / design decision:**

- Spacing/radius/elevation/motion token layer + migration of ~40 inline values across 12 files.
- `PressableButtonStyle` rollout + spring audit (touches every custom control).
- Skeleton loading states (needs placeholder view variants for chart/history/panel) and the reconnecting banner (needs `QuoteSocketClient` connection-state publishing).
- Crosshair/OHLC highlight (delegate plumbing through the representable into the view model + header layout change).
- VoiceOver for the drawing canvas (accessibility element tree) and divider adjustable action.
- CADisplayLink removal in favor of change-driven redraws.
