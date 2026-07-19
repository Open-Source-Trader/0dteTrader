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
    var visibleCount: Double = ChartMetrics.visibleCandles
    var showVolume: Bool = false
    var intervalSeconds: TimeInterval = 60
    var drawingsModel: ChartDrawingsModel?
    /// TWC Heatmap render model: candle repaints, extra line series, and the
    /// read-only geometry overlay (nil when the script indicator is off).
    var twcModel: TwcRenderModel?
    /// GEX/DEX level structure for the read-only overlay (nil when disabled
    /// or before the first successful fetch for the current symbol).
    var gexModel: GexLevels?
    var gexSettings: GexSettings = .default
    var gexStale: Bool = false
    var resetToken: Int = 0

    /// Hosts the chart plus the annotation overlay at identical frames so the
    /// overlay can reuse the chart's pixel coordinate space directly.
    final class ContainerView: UIView {
        let chart = CombinedChartView()
        let twcOverlay = TwcOverlayView()
        let gexOverlay = GexOverlayView()
        let overlay = DrawingOverlayView()

        override init(frame: CGRect) {
            super.init(frame: frame)
            addSubview(chart)
            // Read-only geometry overlays below the interactive drawing overlay.
            addSubview(twcOverlay)
            addSubview(gexOverlay)
            addSubview(overlay)
            twcOverlay.chart = chart
            gexOverlay.chart = chart
            overlay.chart = chart
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) is not supported")
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            chart.frame = bounds
            twcOverlay.frame = bounds
            gexOverlay.frame = bounds
            overlay.frame = bounds
        }
    }

    /// Keeps the annotation overlays' time/price-anchored shapes redrawn in
    /// sync with the chart viewport on pan/zoom.
    final class Coordinator: NSObject, ChartViewDelegate, UIGestureRecognizerDelegate {
        weak var chart: CombinedChartView?
        var onTransform: (() -> Void)?
        var lastResetToken: Int = 0
        private var lastXDist: CGFloat = 0
        private var lastYDist: CGFloat = 0

        func chartTranslated(_ chartView: ChartViewBase, dX: CGFloat, dY: CGFloat) {
            onTransform?()
        }

        func chartScaled(_ chartView: ChartViewBase, scaleX: CGFloat, scaleY: CGFloat) {
            onTransform?()
        }

        // TradingView pinch semantics: horizontal finger spread zooms the
        // time axis, vertical spread zooms the price axis, diagonal zooms
        // both. DGCharts' built-in pinch can't do this (it locks to one axis
        // per gesture), so the spread is decomposed here and applied to the
        // viewport matrix directly.
        @objc func handleDirectionalPinch(_ recognizer: UIPinchGestureRecognizer) {
            guard let chart, recognizer.numberOfTouches >= 2 else { return }
            let p1 = recognizer.location(ofTouch: 0, in: chart)
            let p2 = recognizer.location(ofTouch: 1, in: chart)
            let xDist = abs(p1.x - p2.x)
            let yDist = abs(p1.y - p2.y)
            switch recognizer.state {
            case .began:
                chart.stopDeceleration()
                lastXDist = xDist
                lastYDist = yDist
            case .changed:
                // Axes with under 30pt of finger spread stay put — the ratio
                // of two tiny distances amplifies touch noise into jitter.
                let scaleX = lastXDist > 30 && xDist > 0 ? xDist / lastXDist : 1
                let scaleY = lastYDist > 30 && yDist > 0 ? yDist / lastYDist : 1
                let center = CGPoint(x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2)
                var matrix = CGAffineTransform(translationX: center.x, y: center.y)
                    .scaledBy(x: scaleX, y: scaleY)
                    .translatedBy(x: -center.x, y: -center.y)
                matrix = chart.viewPortHandler.touchMatrix.concatenating(matrix)
                _ = chart.viewPortHandler.refresh(newMatrix: matrix, chart: chart, invalidate: true)
                lastXDist = xDist
                lastYDist = yDist
                onTransform?()
            default:
                break
            }
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            true
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
        chart.dragEnabled = true
        // Built-in pinch is fully disabled in favor of the coordinator's
        // directional pinch (horizontal → time, vertical → price, diagonal → both).
        chart.pinchZoomEnabled = false
        chart.scaleXEnabled = false
        chart.scaleYEnabled = false
        chart.isMultipleTouchEnabled = true

        context.coordinator.onTransform = { [weak container] in
            container?.overlay.setNeedsDisplay()
            container?.twcOverlay.setNeedsDisplay()
            container?.gexOverlay.setNeedsDisplay()
        }
        chart.delegate = context.coordinator
        context.coordinator.chart = chart

        let pinch = UIPinchGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDirectionalPinch(_:))
        )
        pinch.delegate = context.coordinator
        chart.addGestureRecognizer(pinch)

        let xAxis = chart.xAxis
        xAxis.labelPosition = .bottom
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
        container.twcOverlay.model = twcModel
        container.twcOverlay.candles = candles
        container.gexOverlay.model = gexModel
        container.gexOverlay.settings = gexSettings
        container.gexOverlay.stale = gexStale

        guard !candles.isEmpty else {
            chart.data = nil
            chart.notifyDataSetChanged()
            chart.accessibilityValue = nil
            container.overlay.setNeedsDisplay()
            container.gexOverlay.setNeedsDisplay()
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
        if let regimeColors = twcModel?.candleColors {
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

        let lineSets: [LineChartDataSet] = overlays.compactMap { series in
            let entries: [ChartDataEntry] = series.values.enumerated().compactMap { index, value in
                guard let value, index < candles.count else { return nil }
                return ChartDataEntry(x: Double(index), y: value)
            }
            guard !entries.isEmpty else { return nil }
            let set = LineChartDataSet(entries: entries, label: series.name)
            set.mode = .linear
            set.lineWidth = ChartMetrics.overlayLineWidth
            set.drawCirclesEnabled = false
            set.drawValuesEnabled = false
            set.setColor(overlayColors[series.id] ?? .systemOrange)
            set.axisDependency = .left
            return set
        }
        // TWC line series: split each line's contiguous non-nil runs into
        // separate datasets so gaps break the line (Pine linebr) instead of
        // bridging across them.
        var twcLineSets: [LineChartDataSet] = []
        for line in twcModel?.lines ?? [] {
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
        container.overlay.setNeedsDisplay()
        // Candle changes shift the price↔pixel transform; the GEX overlay's
        // didSet hooks only fire on model/settings changes, so repaint here.
        container.gexOverlay.setNeedsDisplay()

        if let last = candles.last {
            chart.accessibilityLabel = "Price chart"
            chart.accessibilityValue = "\(candles.count) candles, last close \(Format.price(last.close))"
        }

        // Snap to the default view on first load; on live appends just keep
        // the newest candle in view without fighting the user's pan/zoom.
        if previousCount != candles.count {
            if previousCount == 0 {
                snapToDefaultView(chart)
            } else {
                chart.moveViewToX(Double(candles.count - 1))
            }
        }

        if resetToken != context.coordinator.lastResetToken {
            context.coordinator.lastResetToken = resetToken
            snapToDefaultView(chart)
        }
    }

    /// Default view: the newest ~120 candles with the right-offset gap,
    /// price axis reset to fit. Used on first load and by the "A" button.
    private func snapToDefaultView(_ chart: CombinedChartView) {
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
