# Screen i13: Chart view + chart/indicator representables

- **App:** iOS
- **Location:** `apps/ios/0dteTrader/Features/Chart/ChartView.swift` (header 115–173, state overlays 44–53, panes 57–108), `CandleChartRepresentable.swift` (axis setup 62–84, candle/volume styling 111–147, viewport 174–177, time labels 180–184), `IndicatorPaneRepresentable.swift` (axis 41–51, x-range 104–105, guides 108–115), `ChartViewModel.swift` (loading/error 86–99, live tick 122–163)
- **Visual:** UNVERIFIED-VISUAL — no macOS/Xcode available; layout reconstructed from code. Desktop-clone error-state reference `docs/ui-audit/shots/05-trade-split.png` **was** read: it shows the same pattern the iOS code produces — a single centered footnote-gray string ("No Webull credentials on file…") floating in a ~55%-of-viewport black void, no icon, no retry, no skeleton — confirming the state-coverage findings below are pixel-real, not theoretical.
- **Scores:** Composition 5/10 · Typography 6/10 · Color 5/10 · Density 6/10 · DataViz 4/10 · Motion 3/10 · States 3/10 · Platform 5/10 · A11y 3/10 · Consistency 3/10 → **Overall 43/100**
- **Score justifications:**
  - Composition 5 — header uses off-grid 12pt spacing/padding (`ChartView.swift:116,171`); pane heights 72/84/72/72 are arbitrary (84 is not an 8pt multiple) and consume up to 300pt of 932pt with no designed chart:pane ratio.
  - Typography 6 — prices correctly monospaced via `.priceMedium` (`ChartView.swift:133`), but axis labels are fixed 10pt and 9pt (`CandleChartRepresentable.swift:65,82`, `IndicatorPaneRepresentable.swift:49`), the only error text is `.footnote` secondary (`ChartView.swift:49-51`), and bid/ask render as "B … A …" (`ChartView.swift:134`).
  - Color 5 — every chart color bypasses the token system: `.systemGreen/.systemRed` candles instead of `buyGreen/sellRed` (`CandleChartRepresentable.swift:112-113`), overlay palette hardcoded in the view (`ChartView.swift:23-30`), `appAccent` re-declared as a raw literal in `DrawingOverlayView.swift:38`; RSI guide lines use `.separator` ≈2.4:1 on `appBackground`, below the 3:1 UI minimum.
  - Density 6 — header packs symbol/last/bid/ask/3 controls into ~40pt (good), but omits the trading-baseline day change Δ/% and any OHLC readout of the latest/hovered candle.
  - DataViz 4 — gridline restraint is genuinely good (0.25-alpha separator, no right-axis labels), but there is no crosshair/tooltip (`highlightPerTapEnabled = false`, `:57`), indicator panes never share the main chart's viewport (P0 below), and "HH:mm" labels are emitted even for the 1d interval (`:182`).
  - Motion 3 — bare `ProgressView` with no transition (`ChartView.swift:44-47`); indicator panes pop in/out via `if let` with no animation or layout transition (`:57-108`); no press states on any header control; nothing honors Reduce Motion.
  - States 3 — loading = spinner over DGCharts' "No chart data" text (two simultaneous conflicting messages); refresh errors with existing candles are set on the model but rendered nowhere (`ChartView.swift:48` vs `ChartViewModel.swift:94-98`); no retry, no offline state, no error haptic.
  - Platform 5 — native `Menu`s, SF Symbols, and `Haptics.selection()` on two buttons are right, but interval chip (~26pt), settings and drawing buttons (~31pt) all miss the 44pt minimum (`ChartView.swift:151-169,200-205`), and interval selection has no haptic.
  - A11y 3 — icon-only settings button has no `accessibilityLabel` (`ChartView.swift:159-169`), interval menu reads as "one m", the chart exposes no `AXChartDescriptor`, and up/down candles are filled identically so direction is color-only (`CandleChartRepresentable.swift:115-116`).
  - Consistency 3 — color decisions live in four different files as literals; zero spacing/radius/motion tokens; magic numbers 120, 0.45, ×5, 1.2/1.1, 0.7, 72/84 scattered through the renderables.

## Findings

### [P0] — Indicator sub-panes never align with the main chart's viewport

- **What/Why:** DataViz + Composition. `loadCandles` fetches 400 candles (`ChartViewModel.swift:91`), but the main chart shows only the last 120 (`visibleCount = 120`, `CandleChartRepresentable.swift:12,175-177`) and supports user pan/pinch. The sub-panes pin their x-range to the _entire_ series (`chart.xAxis.axisMinimum = -0.5; axisMaximum = count - 0.5`, `IndicatorPaneRepresentable.swift:104-105`) with all interaction disabled (`:36-39`). Result: from the very first load, RSI/MACD/Stoch/ATR values are horizontally compressed 400-wide while candles above are 120-wide — every indicator reads against the wrong candles. This is a correctness bug rendered as a design flaw; TradingView-class apps hard-sync pane viewports.
- **Location:** `apps/ios/0dteTrader/Features/Chart/CandleChartRepresentable.swift:174-177`, `apps/ios/0dteTrader/Features/Chart/IndicatorPaneRepresentable.swift:36-39,104-105`
- **Exact fix:** Drive each pane from the main chart's visible range. In `IndicatorPaneRepresentable` add a `var visibleRange: ClosedRange<Double>?` and replace lines 104–105 with:
  ```swift
  if let visibleRange {
      chart.xAxis.axisMinimum = visibleRange.lowerBound
      chart.xAxis.axisMaximum = visibleRange.upperBound
  } else {
      chart.xAxis.axisMinimum = -0.5
      chart.xAxis.axisMaximum = Double(max(xValueCount, 1)) - 0.5
  }
  ```
  In `CandleChartRepresentable`, conform the container to `ChartViewDelegate` and publish the range:
  ```swift
  // in makeUIView after configuring chart:
  chart.delegate = context.coordinator
  // Coordinator:
  final class Coordinator: NSObject, ChartViewDelegate {
      var onVisibleRange: ((ClosedRange<Double>) -> Void)?
      func chartTranslated(_ chartView: ChartViewBase, dX: CGFloat, dY: CGFloat) { emit(chartView) }
      func chartScaled(_ chartView: ChartViewBase, scaleX: CGFloat, scaleY: CGFloat) { emit(chartView) }
      private func emit(_ chartView: ChartViewBase) {
          onVisibleRange?(chartView.lowestVisibleX...chartView.highestVisibleX)
      }
  }
  ```
  Route `onVisibleRange` through a `@Published var visibleXRange` on `ChartViewModel` and pass it to every `IndicatorPaneRepresentable` in `ChartView.swift:58-107`. Panes stay non-interactive; the main chart remains the single gesture owner.

### [P1] — Refresh failures with cached candles are silently swallowed

- **What/Why:** State Coverage. `ChartViewModel.loadCandles` always sets `errorMessage` on failure (`ChartViewModel.swift:94-98`), but the view only renders it when `viewModel.candles.isEmpty` (`ChartView.swift:48`). A failed refresh on a symbol/interval switch leaves the user staring at stale candles with zero indication — a trust-critical flaw in a trading app. Desktop clone screenshot shows the empty-case twin of this: raw text, no recovery path.
- **Location:** `apps/ios/0dteTrader/Features/Chart/ChartView.swift:48-53`, `apps/ios/0dteTrader/Features/Chart/ChartViewModel.swift:94-98`
- **Exact fix:** Add a non-blocking stale-data banner above the chart when data exists but the last load failed. In `ChartView.body`, after `header` (line 34) insert:
  ```swift
  if let errorMessage = viewModel.errorMessage, !viewModel.candles.isEmpty {
      HStack(spacing: 8) {
          Image(systemName: "exclamationmark.triangle.fill")
              .font(.caption)
          Text(errorMessage)
              .font(.caption)
              .lineLimit(1)
          Spacer()
          Button("Retry") { Task { await viewModel.loadCandles() } }
              .font(.caption.weight(.semibold))
      }
      .foregroundStyle(Color.pnlNegative)
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      .background(Color.pnlNegative.opacity(0.12))
      .transition(.move(edge: .top).combined(with: .opacity))
  }
  ```
  and wrap the mutation in `withAnimation(.easeInOut(duration: 0.2))` by adding `.animation(.easeInOut(duration: 0.2), value: viewModel.errorMessage)` on the root `VStack` (line 109).

### [P1] — Loading and error states are an undecorated spinner and a footnote

- **What/Why:** State Coverage + Typography + Density. Loading shows a lone `ProgressView` (`ChartView.swift:44-47`) while the empty chart simultaneously renders DGCharts' `noDataText = "No chart data"` (`CandleChartRepresentable.swift:52`) — two conflicting messages stacked. The error state is a single `.footnote` `.secondary` line (`ChartView.swift:49-52`): no icon, no headline, no retry action. The desktop screenshot proves how empty this feels: ~500pt of dead black space around one gray sentence.
- **Location:** `apps/ios/0dteTrader/Features/Chart/ChartView.swift:44-53`, `apps/ios/0dteTrader/Features/Chart/CandleChartRepresentable.swift:52-54`
- **Exact fix:** Replace lines 44–53 of `ChartView.swift` with a designed state layer:
  ```swift
  if viewModel.isLoading, viewModel.candles.isEmpty {
      VStack(spacing: 12) {
          ProgressView()
              .controlSize(.large)
              .tint(.secondary)
          Text("Loading \(viewModel.symbol)…")
              .font(.footnote)
              .foregroundStyle(.secondary)
      }
      .transition(.opacity)
  }
  if let errorMessage = viewModel.errorMessage, viewModel.candles.isEmpty {
      VStack(spacing: 12) {
          Image(systemName: "chart.xyaxis.line")
              .font(.largeTitle)
              .foregroundStyle(.tertiary)
          Text(errorMessage)
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)
          Button("Try Again") { Task { await viewModel.loadCandles() } }
              .font(.chipLabel)
              .padding(.horizontal, 16)
              .padding(.vertical, 8)
              .background(Color.appSurfaceElevated)
              .clipShape(Capsule())
      }
      .padding(24)
      .transition(.opacity)
  }
  ```
  Also set `chart.noDataText = ""` in `CandleChartRepresentable.swift:52` so the spinner never overlaps it, and call `Haptics.error()` in `ChartViewModel.loadCandles`'s catch blocks (`:94-98`).

### [P1] — Header controls miss the 44pt minimum hit target

- **What/Why:** Platform Fidelity + A11y. Interval chip: caption (~12pt line) + 6pt vertical padding ≈ 26pt tall (`ChartView.swift:151-157`). Settings and drawing buttons: `.subheadline` glyph (~15pt) + 8pt padding ≈ 31pt circles (`:162-168,200-205`). All three are the primary chart controls and all fall 13–18pt short of HIG's 44×44pt.
- **Location:** `apps/ios/0dteTrader/Features/Chart/ChartView.swift:150-169,199-206`
- **Exact fix:** Keep the visual size, expand the hit area. Add to the chip label (after line 156):
  ```swift
  .frame(minHeight: 44)
  .contentShape(Rectangle())
  ```
  and to both circle-button labels (after `.clipShape(Circle())` on lines 168 and 205):
  ```swift
  .frame(width: 44, height: 44)
  .contentShape(Circle())
  ```
  Apply the same `.frame(minHeight: 44)` to the symbol button label (line 127).

### [P1] — No crosshair or value inspection on the price chart

- **What/Why:** DataViz + Density, the single biggest "holy shit" gap. `highlightPerTapEnabled = false` (`CandleChartRepresentable.swift:57`) and no `MarkerView` exists, so a trader cannot read the OHLC/time of any candle — table stakes for Robinhood/TradingView. `highlightPerDragEnabled` defaults to false too, so even the SDK's built-in path is closed.
- **Location:** `apps/ios/0dteTrader/Features/Chart/CandleChartRepresentable.swift:56-58`
- **Exact fix:** Enable drag-highlight with a compact marker:
  ```swift
  chart.highlightPerTapEnabled = true
  chart.highlightPerDragEnabled = true
  let marker = ChartMarkerView() // new BalloonMarker subclass
  marker.chartView = chart
  chart.marker = marker
  candleSet.highlightColor = UIColor.separator
  candleSet.highlightLineWidth = 0.5
  candleSet.highlightLineDashLengths = [4, 3]
  candleSet.drawHorizontalHighlightIndicatorEnabled = true
  ```
  Marker content: `HH:mm  O 642.10  H 642.55  L 641.98  C 642.31` in `monospacedDigitSystemFont(ofSize: 10, weight: .medium)` on `UIColor(named:)`-free `appSurfaceElevated`-equivalent background (`UIColor(red: 0.157, green: 0.169, blue: 0.208, alpha: 1)`), 8pt corner radius, 8pt padding. Long-press-to-inspect (not tap) if the drawing overlay's tap routing conflicts — `DrawingOverlayView.point(inside:)` already yields in cursor mode, so drag-highlight works today.

### [P1] — Icon-only and abbreviated controls are invisible to VoiceOver

- **What/Why:** A11y. The settings button is image-only with no label (`ChartView.swift:159-169`) — VoiceOver reads the glyph name. The interval menu announces "one m" (`:151`). Bid/ask read as "B six hundred forty two… A…" (`:134`). The drawing menu correctly has a label (`:207`) — the pattern exists but wasn't applied.
- **Location:** `apps/ios/0dteTrader/Features/Chart/ChartView.swift:134,150-157,159-169`
- **Exact fix:**
  ```swift
  // after settings Button closing brace (line 169):
  .accessibilityLabel("Indicator settings")
  // after interval Menu closing brace (line 157):
  .accessibilityLabel("Chart interval")
  .accessibilityValue(viewModel.interval.rawValue)
  // replace line 134:
  Text("Bid \(Format.price(quote.bid))  Ask \(Format.price(quote.ask))")
  ```
  Additionally expose the chart to assistive tech with iOS 15's `AXChartDescriptor`: in `CandleChartRepresentable.ContainerView`, set `chart.accessibilityChartDescriptor` (a `AXCandleStickDataSeriesDescriptor` summary with symbol, interval, last price, and candle count) in `updateUIView`.

### [P2] — Chart colors bypass the design-token system in four places

- **What/Why:** Color&Contrast + Consistency. Candles use `.systemGreen/.systemRed` (`CandleChartRepresentable.swift:112-113`) while the rest of the app uses `buyGreen (0.098,0.722,0.357)` / `sellRed (0.882,0.227,0.263)` (`AppColors.swift:35-50`) — the chart's greens/reds literally differ from the P&L text next to it. Overlay palette is a hardcoded dict in the view (`ChartView.swift:23-30`), volume colors are literals (`:136-137`), and `DrawingOverlayView.swift:38` re-types `appAccent`'s RGB by hand. No chart tokens exist in `DesignSystem/`.
- **Location:** `apps/ios/0dteTrader/Features/Chart/CandleChartRepresentable.swift:112-114,136-137`, `ChartView.swift:23-30`, `DrawingOverlayView.swift:38-39`
- **Exact fix:** Add chart tokens to `AppColors.swift`:
  ```swift
  extension UIColor {
      static let chartUp = UIColor(Color.buyGreen)
      static let chartDown = UIColor(Color.sellRed)
      static let chartAccent = UIColor(Color.appAccent)
  }
  ```
  then replace `.systemGreen`/`.systemRed` with `.chartUp`/`.chartDown` at `CandleChartRepresentable.swift:112-113,136-137` and `IndicatorPaneRepresentable.swift:84`, replace the literal at `DrawingOverlayView.swift:38` with `.chartAccent`, and move `ChartView.overlayColors` (lines 23–30) into the same token file as a `static let chartOverlayColors: [String: UIColor]`.

### [P2] — Panes and state overlays appear/disappear with zero motion

- **What/Why:** Motion & Micro-interactions. Toggling RSI/MACD in settings inserts/removes 72–84pt panes via plain `if let` (`ChartView.swift:57-108`), snapping the price chart height instantly; the loading spinner and error text likewise cut in/out (`:44-53`). The Robinhood bar is a 200–250ms eased layout shift.
- **Location:** `apps/ios/0dteTrader/Features/Chart/ChartView.swift:44-53,57-108`
- **Exact fix:** Add one modifier to the root `VStack` (before `.background` on line 110):
  ```swift
  .animation(.spring(response: 0.35, dampingFraction: 0.85), value: viewModel.indicatorSettings)
  .animation(.easeInOut(duration: 0.2), value: viewModel.isLoading)
  ```
  plus `.transition(.opacity.combined(with: .move(edge: .bottom)))` on each `IndicatorPaneRepresentable` block. Gate for Reduce Motion:
  ```swift
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  // use .animation(reduceMotion ? nil : .spring(...), value: ...)
  ```

### [P2] — `DateFormatter` rebuilt on every tick; "HH:mm" is wrong for the 1d interval

- **What/Why:** DataViz + perf. `timeLabels` (`CandleChartRepresentable.swift:180-184`) allocates a new `DateFormatter` and re-maps all 600 candles on every `updateUIView` — which fires on every live quote (`ChartViewModel.swift:147`). On the `1d` interval every label reads "00:00". Cost is real: `DateFormatter` creation is famously expensive and this runs inside the render loop.
- **Location:** `apps/ios/0dteTrader/Features/Chart/CandleChartRepresentable.swift:180-184`
- **Exact fix:** Cache the formatter and switch format by interval:
  ```swift
  private static let timeFormatter: DateFormatter = {
      let f = DateFormatter(); f.dateFormat = "HH:mm"; return f
  }()
  private static let dayFormatter: DateFormatter = {
      let f = DateFormatter(); f.dateFormat = "MMM d"; return f
  }()

  private var timeLabels: [String] {
      let formatter = intervalSeconds >= 86_400 ? Self.dayFormatter : Self.timeFormatter
      return candles.map { formatter.string(from: $0.time) }
  }
  ```

### [P2] — Oscillator guide lines are below the 3:1 UI contrast floor

- **What/Why:** Color&Contrast + DataViz. RSI 30/70 and Stoch 20/80 guides render as 0.5pt `UIColor.separator` dashes (`IndicatorPaneRepresentable.swift:111-113`). Dark-mode separator (≈#545458) on `appBackground` (#0B0C10) measures ≈2.4:1 — under WCAG's 3:1 non-text minimum, and these lines carry the entire overbought/oversold meaning.
- **Location:** `apps/ios/0dteTrader/Features/Chart/IndicatorPaneRepresentable.swift:109-114`
- **Exact fix:**
  ```swift
  line.lineColor = UIColor.separator.withAlphaComponent(1.0).resolvedColor(with: .init(userInterfaceStyle: .dark)).withAlphaComponent(0.6)
  // simpler equivalent that passes 3:1 on both themes:
  line.lineColor = UIColor.secondaryLabel
  line.lineWidth = 0.5
  line.lineDashLengths = [4, 3]
  ```
  (`secondaryLabel` ≈ #EBEBF5@60% ≈ 4.5:1 on `appBackground` in dark, 4.6:1 in light.)

### [P2] — Up/down candles are distinguishable by color alone

- **What/Why:** A11y (color-independent meaning). Both `increasingFilled` and `decreasingFilled` are `true` with `shadowColorSameAsCandle = true` (`CandleChartRepresentable.swift:115-117`), so ~8% of male users cannot tell an up candle from a down one at a glance. The classic TradingView solution is hollow up-candles.
- **Location:** `apps/ios/0dteTrader/Features/Chart/CandleChartRepresentable.swift:112-117`
- **Exact fix:**
  ```swift
  candleSet.increasingFilled = false   // hollow body = up
  candleSet.decreasingFilled = true    // solid body = down
  ```
  (One-line, reversible; if product prefers solid-up, instead add a per-app "colorblind candle" toggle in `IndicatorSettings`.)

### [P3] — Off-grid spacing and arbitrary pane heights

- **What/Why:** Composition&Proportion. `HStack(spacing: 12)` + `.padding(.horizontal, 12)` (`ChartView.swift:116,171`) are 4pt off the 8pt grid; chip padding 10/6 (`:153-154`); MACD pane is 84pt (10.5×8) while siblings are 72 (`:65,81,98,107`). With all four indicators on, panes take 300/932pt (32%) with no designed ratio — the price chart deserves the golden-ratio ~62% share.
- **Location:** `apps/ios/0dteTrader/Features/Chart/ChartView.swift:65,81,98,107,116,153-154,171`
- **Exact fix:** Standardize: spacing/padding 12 → 16 (outer) and 8 (inner stack); chip `.padding(.horizontal, 12).padding(.vertical, 6)`; make every pane height 72 (change line 81 `.frame(height: 84)` → `72`) or derive from a single `private let paneHeight: CGFloat = 72` constant at the top of `ChartView`.

### [P3] — Duplicate time labels and magic scale constants

- **What/Why:** DataViz + Consistency. `xAxis.granularity = 1` with `setLabelCount(6)` (`CandleChartRepresentable.swift:68-69`) prints one label per candle index — adjacent 1m candles in the same minute share "HH:mm" (duplicate labels). Volume compression factor `maxVolume * 5` (`:146`), `shadowWidth 0.7`, `barSpace 0.2`, `lineWidth 1.2/1.1` (`:118-119,157`, `IndicatorPaneRepresentable.swift:72`) are unnamed magic numbers.
- **Location:** `apps/ios/0dteTrader/Features/Chart/CandleChartRepresentable.swift:68-69,118-119,146,157`
- **Exact fix:** Set `xAxis.granularity = max(1, (visibleCount / 6).rounded(.up))` … or simpler, keep granularity 1 but dedupe in `timeLabels`: return `""` when the label equals the previous candle's. Introduce named constants at file scope:
  ```swift
  private enum ChartMetrics {
      static let visibleCandles: Double = 120
      static let volumeHeightRatio: Double = 5   // bars occupy bottom 1/5
      static let shadowWidth: CGFloat = 0.7
      static let barSpace: CGFloat = 0.2
      static let overlayLineWidth: CGFloat = 1.2
  }
  ```

### [P3] — Header omits day change (Δ/%) — the one number every trader expects

- **What/Why:** Information Density. The header shows symbol, last, bid/ask (`ChartView.swift:130-138`) but no change vs previous close — present on every Robinhood/TradingView chart header. `Quote` already feeds `quote.last`; prev-close is available from the first candle of the day or the quote DTO.
- **Location:** `apps/ios/0dteTrader/Features/Chart/ChartView.swift:130-138`
- **Exact fix:** Extend the quote `VStack` (line 131):
  ```swift
  HStack(spacing: 4) {
      Text(Format.price(quote.last)).font(.priceMedium)
      if let change = viewModel.dayChange { // computed: last - prevClose
          Text("\(change >= 0 ? "+" : "")\(Format.price(change)) (\(String(format: "%.2f", change / prevClose * 100))%)")
              .font(.priceSmall.weight(.medium))
              .foregroundStyle(change >= 0 ? Color.pnlPositive : Color.pnlNegative)
              .accessibilityLabel(change >= 0 ? "Up \(Format.price(change)) today" : "Down \(Format.price(abs(change))) today")
      }
  }
  ```
  Sign is carried by the "+/−" glyph and the accessibility label, not color alone.

## Quick wins vs structural work

**Landable in <1 hour:**

- P1 hit-target frames (`contentShape` + 44pt frames) on chip and circle buttons.
- P1 accessibility labels on settings button, interval menu, and "Bid/Ask" text.
- P2 guide-line color → `UIColor.secondaryLabel`.
- P2 hollow-up candles (one-line flip).
- P2 pane/state animations (two `.animation` modifiers + transitions).
- P2 cached `DateFormatter`s + "MMM d" for 1d.
- P3 spacing/height grid fixes; P3 deduped time labels; P3 `ChartMetrics` constants.
- Set `noDataText = ""` so the spinner never overlaps "No chart data".

**Needs refactor (>1 hour):**

- P0 viewport sync between main chart and sub-panes (delegate → published range → pane inputs).
- P1 crosshair/marker (new `BalloonMarker` subclass + touch-routing check against `DrawingOverlayView`).
- P1 designed loading/empty/error component + stale-data banner (touches `ChartView` and `ChartViewModel` error surfacing).
- P2 chart color tokens in `DesignSystem/` and sweep of all four literal sites.
- P3 day-change readout (needs prev-close plumbed through `Quote`/candles).
- `AXChartDescriptor` for the candle series (VoiceOver chart support).
