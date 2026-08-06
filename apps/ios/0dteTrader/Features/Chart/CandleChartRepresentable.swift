import DGCharts
import SwiftUI
import UIKit

/// Candlestick chart with indicator line overlays, optional volume bars, and
/// the drawing-annotation overlay, backed by DanielGindi/Charts
/// `CombinedChartView` (bars behind candles, indicator lines on top).
struct CandleChartRepresentable: UIViewRepresentable {
    let candles: [Candle]
    let overlays: [IndicatorSeries]
    let overlayColors: [String: UIColor]
    let indicatorFillPlans: [IndicatorLiveRenderPlan]
    let indicatorProfileRows: [PriceProfileRow]
    var visibleCount: Double = ChartMetrics.visibleCandles
    var showVolume: Bool = false
    /// TradingView-style volume-weighted candle body width; wick stays fixed.
    var volumeWeightedCandleWidth: Bool = false
    var intervalSeconds: TimeInterval = 60
    var drawingsModel: ChartDrawingsModel?
    /// Merged stateful-script model: candle repaints, line series, and geometry.
    var scriptModel: TwcRenderModel?
    /// Current options structure snapshot for the right-edge profile.
    var optionsAnalyticsSnapshot: OptionsAnalyticsSnapshotDTO?
    var optionsAnalyticsSettings: OptionsAnalyticsSettings = .default
    /// Chart trading: the order-line model, its settings, and the open
    /// positions whose entry lines are drawn.
    var chartOrdersModel: ChartOrdersModel?
    var chartTradingSettings: ChartTradingSettings = .default
    var entryLines: [EntryLineModel] = []
    /// Whether a contract is selected for a new line to trade; the placement
    /// guide is suppressed entirely without one.
    var canPlaceChartOrder: Bool = false
    /// Level the open placement card refers to; nil when it is closed. This
    /// only says who owns the guide's level, not whether one is showing.
    var placementPrice: Double?
    weak var orderLineDelegate: OrderLineOverlayDelegate?
    /// Three taps on the chart toggle the fullscreen/split layout.
    var onTripleTap: (() -> Void)?
    var resetToken: Int = 0

    /// CombinedChartView that reports the end of each draw pass. DGCharts
    /// recomputes the auto-scaled y-axis (and its value→pixel matrix) inside
    /// draw(_:), so price-anchored sibling overlays must repaint after the
    /// chart draws — repainting on gesture callbacks alone leaves them one
    /// frame behind on a stale scale.
    final class PostDrawChartView: CombinedChartView {
        var onPostDraw: (() -> Void)?

        override func draw(_ rect: CGRect) {
            super.draw(rect)
            onPostDraw?()
        }
    }

    /// Axis renderers that lay a tight drop shadow under their labels.
    ///
    /// The scales float over the candles now instead of sitting in gutters of
    /// their own, so a label can land on a wick. DGCharts draws axis text with
    /// a font and a color and nothing else — there is no shadow attribute to
    /// pass — but a `CGContext` shadow set before the super call covers every
    /// glyph it draws. Same treatment the quote readout uses over the same
    /// candles, and it costs no opaque plate.
    final class ShadowedYAxisRenderer: YAxisRenderer {
        /// The x-axis whose labels float along the bottom of the same plot.
        weak var timeAxis: XAxis?

        override func renderAxisLabels(context: CGContext) {
            context.saveGState()
            context.setShadow(offset: .zero, blur: ChartMetrics.axisLabelShadowBlur, color: UIColor.black.cgColor)
            super.renderAxisLabels(context: context)
            context.restoreGState()
        }

        /// Both scales print inside the plot, so the bottom-left corner is
        /// claimed twice: the lowest price label and the leftmost time label
        /// were drawing over each other ("738.0" through "15:20").
        ///
        /// The price label yields, because the time strip's position is fixed
        /// while the price scale's is not — the levels move under every tick,
        /// so insetting the strip to clear them would mean insetting it by the
        /// worst case forever. Only the label goes; its grid line stays, so the
        /// level is still legible from its neighbours.
        ///
        /// Conditionally, via the axis's own `drawBottomYLabelEntryEnabled`
        /// rather than by reimplementing the label loop: the bottom entry can
        /// sit a long way up the plot, and dropping it unconditionally would
        /// cost a reading that was never in the way.
        override func drawYLabels(
            context: CGContext,
            fixedPosition: CGFloat,
            positions: [CGPoint],
            offset: CGFloat,
            // Spelled out: DGCharts' `TextAlignment` is an alias for this, and
            // SwiftUI's same-named enum is also in scope in this file.
            textAlign: NSTextAlignment
        ) {
            let wasEnabled = axis.drawBottomYLabelEntryEnabled
            defer { axis.drawBottomYLabelEntryEnabled = wasEnabled }
            // `positions` runs in entry order, and entries ascend in value —
            // so the first is the lowest price, the one nearest the strip.
            if let timeAxis, let lowest = positions.first {
                let stripTop = viewPortHandler.contentBottom
                    - timeAxis.yOffset
                    - timeAxis.labelRotatedHeight
                if lowest.y + offset + axis.labelFont.lineHeight > stripTop {
                    axis.drawBottomYLabelEntryEnabled = false
                }
            }
            super.drawYLabels(
                context: context,
                fixedPosition: fixedPosition,
                positions: positions,
                offset: offset,
                textAlign: textAlign
            )
        }
    }

    /// The x-axis twin of `ShadowedYAxisRenderer`; see its note.
    final class ShadowedXAxisRenderer: XAxisRenderer {
        override func renderAxisLabels(context: CGContext) {
            context.saveGState()
            context.setShadow(offset: .zero, blur: ChartMetrics.axisLabelShadowBlur, color: UIColor.black.cgColor)
            super.renderAxisLabels(context: context)
            context.restoreGState()
        }
    }

    /// Hosts the chart plus the annotation overlay at identical frames so the
    /// overlay can reuse the chart's pixel coordinate space directly.
    final class ContainerView: UIView {
        let chart = PostDrawChartView()
        let twcOverlay = TwcOverlayView()
        let indicatorFillOverlay = IndicatorFillOverlayView()
        let indicatorProfileOverlay = IndicatorPriceProfileOverlayView()
        let optionsAnalyticsOverlay = OptionsAnalyticsOverlayView()
        let overlay = DrawingOverlayView()
        /// Topmost: an order line must win the touch over a drawing, because
        /// mis-grabbing a trend line when you meant to move a stop is the
        /// expensive mistake.
        let orderLineOverlay = OrderLineOverlayView()
        var onTripleTap: (() -> Void)?

        override init(frame: CGRect) {
            super.init(frame: frame)
            // Fill geometry sits below candles and line data so its translucent
            // color never mutes the live price marks it is explaining.
            addSubview(indicatorFillOverlay)
            addSubview(chart)
            // Read-only geometry overlays below the interactive drawing overlay.
            addSubview(twcOverlay)
            addSubview(indicatorProfileOverlay)
            addSubview(optionsAnalyticsOverlay)
            addSubview(overlay)
            addSubview(orderLineOverlay)
            indicatorFillOverlay.chart = chart
            twcOverlay.chart = chart
            indicatorProfileOverlay.chart = chart
            optionsAnalyticsOverlay.chart = chart
            overlay.chart = chart
            orderLineOverlay.chart = chart
            chart.onPostDraw = { [weak self] in
                guard let self else { return }
                self.indicatorFillOverlay.setNeedsDisplay()
                self.twcOverlay.setNeedsDisplay()
                self.indicatorProfileOverlay.setNeedsDisplay()
                self.optionsAnalyticsOverlay.setNeedsDisplay()
                self.overlay.setNeedsDisplay()
                self.orderLineOverlay.setNeedsDisplay()
            }

            // A tap on empty chart space summons the placement guide at that
            // level, and the next one dismisses it. It hangs off the chart
            // rather than the order overlay because the overlay's
            // `point(inside:)` deliberately refuses empty space so the chart
            // keeps pan and zoom — which makes the chart exactly the view a tap
            // reaches when no order line, pill, handle or drawing wanted it.
            // `cancelsTouchesInView` stays on so DGCharts still sees the touch.
            let placementTap = UITapGestureRecognizer(
                target: self,
                action: #selector(handlePlacementTap(_:))
            )
            placementTap.delegate = self
            placementTap.cancelsTouchesInView = false
            chart.addGestureRecognizer(placementTap)

            // Three taps toggle the fullscreen layout — the only way in and out
            // of it now that the toolbar button is gone. It shares the chart
            // with the guide's single tap, so the guide has to wait to find out
            // whether a second tap is coming: `require(toFail:)` costs every
            // summon the double-tap interval (~0.35s). Paid deliberately, on the
            // grounds that a guide that appears a beat late is recoverable and a
            // guide that flickers on, off and on again under a layout change is
            // an order control the user did not ask for.
            let fullscreenTap = UITapGestureRecognizer(
                target: self,
                action: #selector(handleFullscreenTap)
            )
            fullscreenTap.numberOfTapsRequired = 3
            fullscreenTap.delegate = self
            fullscreenTap.cancelsTouchesInView = false
            chart.addGestureRecognizer(fullscreenTap)
            placementTap.require(toFail: fullscreenTap)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) is not supported")
        }

        @objc private func handlePlacementTap(_ recognizer: UITapGestureRecognizer) {
            orderLineOverlay.toggleGuide(at: recognizer.location(in: orderLineOverlay))
        }

        /// Internal rather than private so the wiring can be asserted: a real
        /// triple tap cannot be injected into a simulator from a test.
        @objc func handleFullscreenTap() {
            onTripleTap?()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            chart.frame = bounds
            indicatorFillOverlay.frame = bounds
            twcOverlay.frame = bounds
            indicatorProfileOverlay.frame = bounds
            optionsAnalyticsOverlay.frame = bounds
            overlay.frame = bounds
            orderLineOverlay.frame = bounds
            // TradingView-style over-scroll: allow dragging the newest candle
            // well past mid-screen into empty space (and slightly past the
            // oldest on the left).
            chart.setDragOffsetX(bounds.width * 0.45)
        }
    }
}

extension CandleChartRepresentable.ContainerView: UIGestureRecognizerDelegate {
    /// The placement tap only observes: it must run alongside DGCharts' own
    /// recognizers and the gesture controller's pinch/pan, never instead of
    /// them. A chart that stopped panning because a `+` might be summoned would
    /// be a bad trade.
    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        true
    }
}

extension CandleChartRepresentable {
    /// Keeps the annotation overlays' time/price-anchored shapes redrawn in
    /// sync with the chart viewport on pan/zoom.
    final class Coordinator: NSObject, ChartViewDelegate {
        weak var chart: CombinedChartView?
        var onTransform: (() -> Void)?
        var lastResetToken: Int = 0
        // TradingView-style pinch/vertical-pan and the y-axis auto/manual
        // state machine live in the shared controller.
        let gestures = ChartGestureController()

        func chartTranslated(_ chartView: ChartViewBase, dX: CGFloat, dY: CGFloat) {
            onTransform?()
        }

        func chartScaled(_ chartView: ChartViewBase, scaleX: CGFloat, scaleY: CGFloat) {
            onTransform?()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> ContainerView {
        let container = ContainerView()
        let chart = container.chart
        // Draw volume bars first, then candles, indicator lines on top.
        chart.drawOrder = [
            CombinedChartView.DrawOrder.bar.rawValue,
            CombinedChartView.DrawOrder.candle.rawValue,
            CombinedChartView.DrawOrder.line.rawValue,
        ]
        chart.legend.enabled = false
        // The designed loading/empty states in ChartView own this surface.
        chart.noDataText = ""
        chart.backgroundColor = .clear
        chart.doubleTapToZoomEnabled = false
        chart.highlightPerTapEnabled = false
        chart.highlightPerDragEnabled = false
        // DGCharts' built-in pan keeps the x-axis; the gesture controller
        // owns vertical panning through the axis range (matrix y-translation
        // is clamped to the fitted range, so it can't over-scroll).
        chart.dragXEnabled = true
        chart.dragYEnabled = false
        // Built-in pinch is fully disabled in favor of the gesture
        // controller's directional pinch (horizontal → time, vertical →
        // price, diagonal → both).
        chart.pinchZoomEnabled = false
        chart.scaleXEnabled = false
        chart.scaleYEnabled = false
        chart.isMultipleTouchEnabled = true
        // TradingView y-axis model: auto-fit the visible window until a
        // vertical gesture switches the axis to manual control.
        chart.autoScaleMinMaxEnabled = true

        let redrawOverlays: () -> Void = { [weak container] in
            container?.indicatorFillOverlay.setNeedsDisplay()
            container?.overlay.setNeedsDisplay()
            container?.twcOverlay.setNeedsDisplay()
            container?.indicatorProfileOverlay.setNeedsDisplay()
            container?.optionsAnalyticsOverlay.setNeedsDisplay()
            container?.orderLineOverlay.setNeedsDisplay()
        }
        context.coordinator.onTransform = redrawOverlays
        chart.delegate = context.coordinator
        context.coordinator.chart = chart

        context.coordinator.gestures.onTransform = redrawOverlays
        context.coordinator.gestures.attach(to: chart)

        // Both scales print inside the plot rather than in reserved gutters, so
        // the candles run the full width and height of the card and the chrome
        // seated in its corners lines up with a real border instead of with the
        // inside edge of an axis strip. `needsOffset` is false for both inside
        // positions, which is what actually gives the space back; what is left
        // is `minOffset`, an even 10pt on all four sides.
        let priceAxisRenderer = ShadowedYAxisRenderer(
            viewPortHandler: chart.viewPortHandler,
            axis: chart.leftAxis,
            transformer: chart.getTransformer(forAxis: .left)
        )
        // So the price scale knows where the time strip starts and can stand
        // its lowest label down when the two want the same corner.
        priceAxisRenderer.timeAxis = chart.xAxis
        chart.leftYAxisRenderer = priceAxisRenderer
        chart.xAxisRenderer = ShadowedXAxisRenderer(
            viewPortHandler: chart.viewPortHandler,
            axis: chart.xAxis,
            transformer: chart.getTransformer(forAxis: .left)
        )

        let xAxis = chart.xAxis
        xAxis.labelPosition = .bottomInside
        // The axis line would now be drawn 10pt inboard of the card's bottom
        // border, where it reads as a stray rule rather than as the axis.
        xAxis.drawAxisLineEnabled = false
        xAxis.labelTextColor = .hudAxisLabel
        xAxis.labelFont = UIFont(name: "JetBrainsMono-Regular", size: 10) ?? .monospacedDigitSystemFont(ofSize: 10, weight: .regular)
        xAxis.gridColor = UIColor.hudStroke.withAlphaComponent(0.1)
        xAxis.axisLineColor = UIColor.hudStroke.withAlphaComponent(0.35)
        xAxis.granularity = 1
        xAxis.setLabelCount(6, force: false)

        // Right axis carries the (hidden-label) volume scale, compressed into
        // the bottom of the pane so bars never crowd the candles.
        let rightAxis = chart.rightAxis
        rightAxis.enabled = true
        rightAxis.drawLabelsEnabled = false
        rightAxis.drawGridLinesEnabled = false
        rightAxis.axisLineColor = .clear
        rightAxis.axisMinimum = 0

        let leftAxis = chart.leftAxis
        leftAxis.labelPosition = .insideChart
        leftAxis.labelTextColor = .hudAxisLabel
        leftAxis.labelFont = UIFont(name: "JetBrainsMono-Regular", size: 10) ?? .monospacedDigitSystemFont(ofSize: 10, weight: .regular)
        leftAxis.gridColor = UIColor.hudStroke.withAlphaComponent(0.1)
        leftAxis.axisLineColor = .clear

        return container
    }

    func updateUIView(_ container: ContainerView, context: Context) {
        let chart = container.chart
        container.overlay.model = drawingsModel
        container.overlay.firstTime = candles.first?.time.timeIntervalSince1970 ?? 0
        container.overlay.intervalSeconds = intervalSeconds
        container.overlay.candles = candles
        container.twcOverlay.model = scriptModel
        container.twcOverlay.candles = candles
        container.indicatorFillOverlay.plans = indicatorFillPlans
        container.indicatorProfileOverlay.rows = indicatorProfileRows
        container.optionsAnalyticsOverlay.snapshot = optionsAnalyticsSnapshot
        container.optionsAnalyticsOverlay.settings = optionsAnalyticsSettings
        container.orderLineOverlay.model = chartOrdersModel
        container.orderLineOverlay.settings = chartTradingSettings
        container.orderLineOverlay.entryLines = entryLines
        container.orderLineOverlay.canPlaceChartOrder = canPlaceChartOrder
        container.orderLineOverlay.placementPrice = placementPrice
        container.orderLineOverlay.delegate = orderLineDelegate
        container.onTripleTap = onTripleTap
        // Keep the button rows clear of the analytics rail when it is on. The
        // rail sizes itself from the chart's content rect, not the view bounds,
        // so measuring from bounds would drift by the axis gutter and leave the
        // rows either overlapping the rail or short of it.
        let analyticsContent = container.chart.viewPortHandler.contentRect
        container.orderLineOverlay.rightInset = optionsAnalyticsSnapshot != nil
            && optionsAnalyticsSettings.enabled
            ? (container.bounds.width - analyticsContent.maxX)
                + CGFloat(OptionsAnalyticsPresentation.railWidth(for: analyticsContent.width))
            : 0

        guard !candles.isEmpty else {
            chart.data = nil
            chart.notifyDataSetChanged()
            chart.accessibilityValue = nil
            container.indicatorFillOverlay.setNeedsDisplay()
            container.overlay.setNeedsDisplay()
            container.indicatorProfileOverlay.setNeedsDisplay()
            container.optionsAnalyticsOverlay.setNeedsDisplay()
            container.orderLineOverlay.setNeedsDisplay()
            return
        }
        let previousCount = (chart.data as? CombinedChartData)?.candleData?.entryCount ?? 0

        // Dashed accent line + axis tag at the last price (mockup's glowing
        // price tag; CoreGraphics can't bloom, so a bright tag stands in).
        chart.leftAxis.removeAllLimitLines()
        if let lastClose = candles.last?.close {
            let priceLine = ChartLimitLine(limit: lastClose)
            priceLine.lineColor = UIColor.appAccent.withAlphaComponent(0.7)
            priceLine.lineWidth = 0.75
            priceLine.lineDashLengths = [4, 3]
            priceLine.drawLabelEnabled = false
            chart.leftAxis.addLimitLine(priceLine)
        }

        let candleEntries = candles.enumerated().map { index, candle in
            CandleChartDataEntry(
                x: Double(index),
                shadowH: candle.high,
                shadowL: candle.low,
                open: candle.open,
                close: candle.close
            )
        }
        let candleSet = CandleChartDataSet(entries: candleEntries, label: "Price")
        if let regimeColors = scriptModel?.candleColors {
            // TWC regime candles: per-bar colors override the up/down palette.
            // DGCharts falls back to `colors[index]` when the increasing/
            // decreasing colors are nil; hidden (nil) bars keep the default.
            candleSet.increasingColor = nil
            candleSet.decreasingColor = nil
            candleSet.colors = candles.enumerated().map { index, candle in
                if index < regimeColors.count, let color = regimeColors[index] {
                    return UIColor(twcColor: color)
                }
                return candle.close >= candle.open ? .chartUp : .chartDown
            }
            candleSet.increasingFilled = true
            candleSet.decreasingFilled = true
        } else {
            candleSet.increasingColor = .chartUp
            candleSet.decreasingColor = .chartDown
            // Hollow up / solid down so direction isn't carried by color alone.
            candleSet.increasingFilled = false
            candleSet.decreasingFilled = true
        }
        candleSet.neutralColor = .systemBlue
        candleSet.shadowColorSameAsCandle = true
        candleSet.shadowWidth = ChartMetrics.shadowWidth
        candleSet.barSpace = ChartMetrics.barSpace
        candleSet.drawValuesEnabled = false
        candleSet.axisDependency = .left
        candleSet.highlightColor = UIColor.hudStroke.withAlphaComponent(0.5)
        candleSet.highlightLineWidth = 0.5
        candleSet.highlightLineDashLengths = [4, 3]
        candleSet.drawHorizontalHighlightIndicatorEnabled = true

        let data = CombinedChartData()
        data.candleData = CandleChartData(dataSet: candleSet)

        if showVolume {
            var volumeEntries: [BarChartDataEntry] = []
            var volumeColors: [UIColor] = []
            var maxVolume = 0.0
            for (index, candle) in candles.enumerated() {
                let volume = Double(candle.volume)
                maxVolume = max(maxVolume, volume)
                volumeEntries.append(BarChartDataEntry(x: Double(index), y: volume))
                volumeColors.append(
                    candle.close >= candle.open
                        ? UIColor.chartUp.withAlphaComponent(0.45)
                        : UIColor.chartDown.withAlphaComponent(0.45)
                )
            }
            let volumeSet = BarChartDataSet(entries: volumeEntries, label: "Volume")
            volumeSet.colors = volumeColors
            volumeSet.drawValuesEnabled = false
            volumeSet.axisDependency = .right
            data.barData = BarChartData(dataSet: volumeSet)
            // Bars occupy the bottom ~20% of the pane.
            chart.rightAxis.axisMaximum = max(maxVolume, 1) * ChartMetrics.volumeHeightRatio
        }

        var lineSets: [LineChartDataSet] = []
        for series in overlays {
            var runEntries: [ChartDataEntry] = []
            func flushRun() {
                guard !runEntries.isEmpty else { return }
                let set = LineChartDataSet(entries: runEntries, label: series.name)
                set.mode = .linear
                set.lineWidth = ChartMetrics.overlayLineWidth
                set.drawCirclesEnabled = false
                set.drawValuesEnabled = false
                set.setColor(overlayColors[series.id] ?? .systemOrange)
                set.axisDependency = .left
                lineSets.append(set)
                runEntries = []
            }
            for (index, value) in series.values.enumerated() {
                guard index < candles.count else { break }
                if let value {
                    runEntries.append(ChartDataEntry(x: Double(index), y: value))
                } else {
                    flushRun()
                }
            }
            flushRun()
        }
        // TWC line series: split each line's contiguous non-nil runs into
        // separate datasets so gaps break the line (Pine linebr) instead of
        // bridging across them.
        var twcLineSets: [LineChartDataSet] = []
        for line in scriptModel?.lines ?? [] {
            var runEntries: [ChartDataEntry] = []
            func flushRun() {
                guard runEntries.count >= 1 else {
                    runEntries = []
                    return
                }
                let set = LineChartDataSet(entries: runEntries, label: line.id)
                set.mode = .linear
                set.lineWidth = CGFloat(line.lineWidth)
                set.drawCirclesEnabled = false
                set.drawValuesEnabled = false
                set.highlightEnabled = false
                set.setColor(UIColor(twcColor: line.color))
                set.axisDependency = .left
                twcLineSets.append(set)
                runEntries = []
            }
            for (index, value) in line.values.enumerated() {
                guard index < candles.count else { break }
                if let value {
                    runEntries.append(ChartDataEntry(x: Double(index), y: value))
                } else {
                    flushRun()
                }
            }
            flushRun()
        }

        if !lineSets.isEmpty || !twcLineSets.isEmpty {
            data.lineData = LineChartData(dataSets: lineSets + twcLineSets)
        }

        chart.data = data
        chart.xAxis.valueFormatter = IndexAxisValueFormatter(values: timeLabels)
        // 12 bars of empty space past the newest candle (TradingView right
        // offset). Scale 1 = the entire history, so pinching out from the
        // default 120-bar window has the full range to travel through. Must
        // be set before notifyDataSetChanged so the value→pixel transform
        // includes the gap when the snap below positions the viewport.
        chart.xAxis.axisMinimum = -0.5
        chart.xAxis.axisMaximum = Double(candles.count - 1) + 12
        chart.notifyDataSetChanged()

        // `chart.data = data` above rebuilds `subRenderers` from scratch with
        // a fresh stock CandleStickChartRenderer (CombinedChartView.data's
        // setter calls createRenderers() on every assignment), so the swap
        // has to be reinstalled after every update rather than once at
        // makeUIView — a renderer installed there would be silently replaced
        // on the very next SwiftUI update.
        if let combinedRenderer = chart.renderer as? CombinedChartRenderer, volumeWeightedCandleWidth {
            if let index = combinedRenderer.subRenderers.firstIndex(where: { $0 is CandleStickChartRenderer }) {
                let custom = VolumeWeightedCandleStickChartRenderer(
                    dataProvider: chart,
                    animator: chart.chartAnimator,
                    viewPortHandler: chart.viewPortHandler
                )
                custom.volumes = candles.map { Double($0.volume) }
                combinedRenderer.subRenderers[index] = custom
            }
        }
        container.indicatorFillOverlay.setNeedsDisplay()
        container.overlay.setNeedsDisplay()
        container.indicatorProfileOverlay.setNeedsDisplay()
        // Candle changes shift the price↔pixel transform, so repaint the rail.
        container.optionsAnalyticsOverlay.setNeedsDisplay()

        if let last = candles.last {
            chart.accessibilityLabel = "Price chart"
            chart.accessibilityValue = "\(candles.count) candles, last close \(Format.price(last.close))"
        }

        // Snap to the default view on first load; on live appends just keep
        // the newest candle in view without fighting the user's pan/zoom.
        if previousCount != candles.count {
            if previousCount == 0 {
                snapToDefaultView(chart, coordinator: context.coordinator)
            } else {
                chart.moveViewToX(Double(candles.count - 1))
            }
        }

        if resetToken != context.coordinator.lastResetToken {
            context.coordinator.lastResetToken = resetToken
            snapToDefaultView(chart, coordinator: context.coordinator)
        }
    }

    /// Default view: the newest ~120 candles with the right-offset gap,
    /// price axis reset to fit. Used on first load and by the "A" button.
    private func snapToDefaultView(_ chart: CombinedChartView, coordinator: Coordinator) {
        coordinator.gestures.resetToAuto()
        chart.fitScreen()
        let totalRange = Double(candles.count) + 12
        let scale = max(1, totalRange / visibleCount)
        chart.zoom(scaleX: CGFloat(scale), scaleY: 1, x: chart.bounds.width, y: 0)
        chart.moveViewToX(Double(candles.count - 1))
    }

    /// X-axis labels, deduped so adjacent candles in the same minute/day
    /// don't print the same label twice.
    private var timeLabels: [String] {
        var labels: [String] = []
        labels.reserveCapacity(candles.count)
        var previous = ""
        for candle in candles {
            let label = ChartTimeFormat.string(for: candle.time, intervalSeconds: intervalSeconds)
            labels.append(label == previous ? "" : label)
            previous = label
        }
        return labels
    }
}
