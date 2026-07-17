import Charts
import SwiftUI
import UIKit

/// Candlestick chart with indicator line overlays, backed by DanielGindi/Charts
/// `CombinedChartView` (candle data + line data, lines drawn on top).
struct CandleChartRepresentable: UIViewRepresentable {
    let candles: [Candle]
    let overlays: [IndicatorSeries]
    let overlayColors: [String: UIColor]
    var visibleCount: Double = 120

    func makeUIView(context: Context) -> CombinedChartView {
        let chart = CombinedChartView()
        // Draw candles first, indicator lines on top.
        chart.drawOrder = [
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

        chart.rightAxis.enabled = false
        let leftAxis = chart.leftAxis
        leftAxis.labelTextColor = .secondaryLabel
        leftAxis.labelFont = .monospacedDigitSystemFont(ofSize: 10, weight: .regular)
        leftAxis.gridColor = UIColor.separator.withAlphaComponent(0.25)
        leftAxis.axisLineColor = .clear

        return chart
    }

    func updateUIView(_ chart: CombinedChartView, context: Context) {
        guard !candles.isEmpty else {
            chart.data = nil
            chart.notifyDataSetChanged()
            return
        }
        let previousCount = chart.data?.entryCount ?? 0

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

        let data = CombinedChartData()
        data.candleData = CandleChartData(dataSet: candleSet)

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
