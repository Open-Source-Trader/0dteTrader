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
    var visibleCount: Double = 120
    var showVolume: Bool = false
    var intervalSeconds: TimeInterval = 60
    var drawingsModel: ChartDrawingsModel?

    /// Hosts the chart plus the annotation overlay at identical frames so the
    /// overlay can reuse the chart's pixel coordinate space directly.
    final class ContainerView: UIView {
        let chart = CombinedChartView()
        let overlay = DrawingOverlayView()

        override init(frame: CGRect) {
            super.init(frame: frame)
            addSubview(chart)
            addSubview(overlay)
            overlay.chart = chart
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) is not supported")
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            chart.frame = bounds
            overlay.frame = bounds
        }
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
        chart.noDataText = "No chart data"
        chart.noDataFont = .preferredFont(forTextStyle: .footnote)
        chart.noDataTextColor = .secondaryLabel
        chart.backgroundColor = .clear
        chart.doubleTapToZoomEnabled = false
        chart.highlightPerTapEnabled = false
        chart.dragEnabled = true
        chart.pinchZoomEnabled = true
        chart.setScaleMinima(10, scaleYmin: 1)

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

        guard !candles.isEmpty else {
            chart.data = nil
            chart.notifyDataSetChanged()
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
        candleSet.increasingColor = .systemGreen
        candleSet.decreasingColor = .systemRed
        candleSet.neutralColor = .systemBlue
        candleSet.increasingFilled = true
        candleSet.decreasingFilled = true
        candleSet.shadowColorSameAsCandle = true
        candleSet.shadowWidth = 0.7
        candleSet.barSpace = 0.2
        candleSet.drawValuesEnabled = false
        candleSet.axisDependency = .left

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
                        ? UIColor.systemGreen.withAlphaComponent(0.45)
                        : UIColor.systemRed.withAlphaComponent(0.45)
                )
            }
            let volumeSet = BarChartDataSet(entries: volumeEntries, label: "Volume")
            volumeSet.colors = volumeColors
            volumeSet.drawValuesEnabled = false
            volumeSet.axisDependency = .right
            data.barData = BarChartData(dataSet: volumeSet)
            // Bars occupy the bottom ~20% of the pane.
            chart.rightAxis.axisMaximum = max(maxVolume, 1) * 5
        }

        let lineSets: [LineChartDataSet] = overlays.compactMap { series in
            let entries: [ChartDataEntry] = series.values.enumerated().compactMap { index, value in
                guard let value, index < candles.count else { return nil }
                return ChartDataEntry(x: Double(index), y: value)
            }
            guard !entries.isEmpty else { return nil }
            let set = LineChartDataSet(entries: entries, label: series.name)
            set.mode = .linear
            set.lineWidth = 1.2
            set.drawCirclesEnabled = false
            set.drawValuesEnabled = false
            set.setColor(overlayColors[series.id] ?? .systemOrange)
            set.axisDependency = .left
            return set
        }
        if !lineSets.isEmpty {
            data.lineData = LineChartData(dataSets: lineSets)
        }

        chart.data = data
        chart.xAxis.valueFormatter = IndexAxisValueFormatter(values: timeLabels)
        chart.notifyDataSetChanged()

        // Keep the latest candle in view on first load and when a new candle
        // forms, but never fight the user's manual pan/zoom on ticks.
        if previousCount != candles.count {
            chart.setVisibleXRangeMaximum(visibleCount)
            chart.moveViewToX(Double(candles.count - 1))
        }
    }

    private var timeLabels: [String] {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return candles.map { formatter.string(from: $0.time) }
    }
}
