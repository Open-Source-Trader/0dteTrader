import DGCharts
import SwiftUI
import UIKit

/// Compact OHLC marker shown while tap/drag-highlighting the candle chart.
final class ChartMarkerView: MarkerView {
    var candles: [Candle] = []
    var intervalSeconds: TimeInterval = 60

    private let paddingH: CGFloat = 8
    private let paddingV: CGFloat = 6

    private let textLabel: UILabel = {
        let label = UILabel()
        label.font = .monospacedDigitSystemFont(ofSize: 10, weight: .medium)
        label.textColor = .white
        label.numberOfLines = 1
        return label
    }()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Color.appSurfaceElevated)
        layer.cornerRadius = 8
        addSubview(textLabel)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func refreshContent(entry: ChartDataEntry, highlight: Highlight) {
        let index = Int(entry.x.rounded())
        guard candles.indices.contains(index) else { return }
        let candle = candles[index]
        let time = ChartTimeFormat.string(for: candle.time, intervalSeconds: intervalSeconds)
        textLabel.text = "\(time)  O \(Format.price(candle.open))  H \(Format.price(candle.high))  L \(Format.price(candle.low))  C \(Format.price(candle.close))"
        textLabel.sizeToFit()
        let contentSize = textLabel.bounds.size
        bounds = CGRect(
            x: 0, y: 0,
            width: contentSize.width + paddingH * 2,
            height: contentSize.height + paddingV * 2
        )
        textLabel.frame = CGRect(
            x: paddingH, y: paddingV,
            width: contentSize.width, height: contentSize.height
        )
    }

    override func offset(forValueAtPoint point: CGPoint, chart: ChartViewBase) -> CGPoint {
        var offset = CGPoint(x: -bounds.width / 2, y: -bounds.height - 12)
        // Keep the marker fully on screen near the edges.
        if point.x + offset.x < 0 {
            offset.x = -point.x + 4
        } else if point.x + offset.x + bounds.width > chart.bounds.width {
            offset.x = chart.bounds.width - point.x - bounds.width - 4
        }
        if point.y + offset.y < 0 {
            offset.y = 12
        }
        return offset
    }
}

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
    /// Called with the main chart's visible x-range whenever the user pans or
    /// zooms, so non-interactive indicator panes can track the same window.
    var onVisibleRangeChange: ((ClosedRange<Double>) -> Void)?

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

    /// Publishes the main chart's visible x-range and keeps the annotation
    /// overlay's time/price-anchored shapes in sync on pan/zoom.
    final class Coordinator: NSObject, ChartViewDelegate {
        var onVisibleRange: ((ClosedRange<Double>) -> Void)?
        var onTransform: (() -> Void)?

        func chartTranslated(_ chartView: ChartViewBase, dX: CGFloat, dY: CGFloat) {
            emit(chartView)
            onTransform?()
        }

        func chartScaled(_ chartView: ChartViewBase, scaleX: CGFloat, scaleY: CGFloat) {
            emit(chartView)
            onTransform?()
        }

        func emit(_ chartView: ChartViewBase) {
            onVisibleRange?(chartView.lowestVisibleX...chartView.highestVisibleX)
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
        chart.highlightPerTapEnabled = true
        chart.highlightPerDragEnabled = true
        chart.dragEnabled = true
        chart.pinchZoomEnabled = true
        chart.setScaleMinima(10, scaleYmin: 1)

        let rangeCallback = onVisibleRangeChange
        context.coordinator.onVisibleRange = { range in rangeCallback?(range) }
        context.coordinator.onTransform = { [weak container] in
            container?.overlay.setNeedsDisplay()
            container?.twcOverlay.setNeedsDisplay()
            container?.gexOverlay.setNeedsDisplay()
        }
        chart.delegate = context.coordinator

        let marker = ChartMarkerView()
        marker.chartView = chart
        chart.marker = marker

        let xAxis = chart.xAxis
        xAxis.labelPosition = .bottom
        xAxis.labelTextColor = .secondaryLabel
        xAxis.labelFont = .monospacedDigitSystemFont(ofSize: 10, weight: .regular)
        xAxis.gridColor = UIColor.separator.withAlphaComponent(0.25)
        xAxis.axisLineColor = UIColor.separator
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
        leftAxis.labelTextColor = .secondaryLabel
        leftAxis.labelFont = .monospacedDigitSystemFont(ofSize: 10, weight: .regular)
        leftAxis.gridColor = UIColor.separator.withAlphaComponent(0.25)
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

        if let marker = chart.marker as? ChartMarkerView {
            marker.candles = candles
            marker.intervalSeconds = intervalSeconds
        }

        guard !candles.isEmpty else {
            chart.data = nil
            chart.notifyDataSetChanged()
            chart.accessibilityValue = nil
            container.overlay.setNeedsDisplay()
            container.gexOverlay.setNeedsDisplay()
            return
        }
        let previousCount = chart.data?.candleData?.entryCount ?? 0

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
        candleSet.highlightColor = UIColor.separator
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
        chart.notifyDataSetChanged()
        container.overlay.setNeedsDisplay()
        // Candle changes shift the price↔pixel transform; the GEX overlay's
        // didSet hooks only fire on model/settings changes, so repaint here.
        container.gexOverlay.setNeedsDisplay()

        if let last = candles.last {
            chart.accessibilityLabel = "Price chart"
            chart.accessibilityValue = "\(candles.count) candles, last close \(Format.price(last.close))"
        }

        // Keep the latest candle in view on first load and when a new candle
        // forms, but never fight the user's manual pan/zoom on ticks.
        if previousCount != candles.count {
            chart.setVisibleXRangeMaximum(visibleCount)
            chart.moveViewToX(Double(candles.count - 1))
            // Publish the initial window so the indicator panes match from
            // the first load, before any user gesture.
            context.coordinator.emit(chart)
        }
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
