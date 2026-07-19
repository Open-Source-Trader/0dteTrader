import DGCharts
import SwiftUI
import UIKit

/// Sub-pane chart for oscillators: RSI (single line + 30/70 guides) and MACD
/// (histogram bars + MACD/signal lines). Shares the main chart's index-based x-axis.
struct IndicatorPaneRepresentable: UIViewRepresentable {
    enum SeriesKind: Equatable {
        case line
        case histogram
    }

    struct PaneSeries: Equatable {
        let id: String
        let kind: SeriesKind
        let values: [Double?]
    }

    let series: [PaneSeries]
    let colors: [String: UIColor]
    var guideLines: [Double] = []
    var yRange: ClosedRange<Double>?
    var xValueCount: Int
    /// The main chart's visible x-range; when set, the pane pins its window
    /// to it so indicator values align with the candles above.
    var visibleRange: ClosedRange<Double>?
    var onVisibleRangeChange: ((ClosedRange<Double>) -> Void)?

    func makeUIView(context: Context) -> CombinedChartView {
        let chart = CombinedChartView()
        chart.drawOrder = [
            CombinedChartView.DrawOrder.bar.rawValue,
            CombinedChartView.DrawOrder.line.rawValue,
        ]
        chart.legend.enabled = false
        chart.noDataText = ""
        chart.backgroundColor = .clear
        chart.doubleTapToZoomEnabled = false
        chart.highlightPerTapEnabled = false
        chart.dragEnabled = true
        chart.pinchZoomEnabled = false
        chart.scaleXEnabled = true
        chart.scaleYEnabled = false

        chart.delegate = context.coordinator

        let xAxis = chart.xAxis
        xAxis.drawLabelsEnabled = false
        xAxis.drawGridLinesEnabled = false
        xAxis.drawAxisLineEnabled = false

        chart.rightAxis.enabled = false
        let leftAxis = chart.leftAxis
        leftAxis.labelTextColor = .hudAxisLabel
        leftAxis.labelFont = UIFont(name: "JetBrainsMono-Regular", size: 9) ?? .monospacedDigitSystemFont(ofSize: 9, weight: .regular)
        leftAxis.gridColor = UIColor.hudStroke.withAlphaComponent(0.1)
        leftAxis.drawLimitLinesBehindDataEnabled = true

        return chart
    }

    func updateUIView(_ chart: CombinedChartView, context: Context) {
        let data = CombinedChartData()

        var lineSets: [LineChartDataSet] = []
        var barSets: [BarChartDataSet] = []

        for paneSeries in series {
            switch paneSeries.kind {
            case .line:
                let entries: [ChartDataEntry] = paneSeries.values.enumerated().compactMap { index, value in
                    guard let value else { return nil }
                    return ChartDataEntry(x: Double(index), y: value)
                }
                guard !entries.isEmpty else { continue }
                let set = LineChartDataSet(entries: entries, label: paneSeries.id)
                set.mode = .linear
                set.lineWidth = 1.1
                set.drawCirclesEnabled = false
                set.drawValuesEnabled = false
                set.setColor(colors[paneSeries.id] ?? .systemOrange)
                lineSets.append(set)

            case .histogram:
                var entries: [BarChartDataEntry] = []
                var entryColors: [UIColor] = []
                for (index, value) in paneSeries.values.enumerated() {
                    guard let value else { continue }
                    entries.append(BarChartDataEntry(x: Double(index), y: value))
                    entryColors.append(value >= 0 ? .chartUp : .chartDown)
                }
                guard !entries.isEmpty else { continue }
                let set = BarChartDataSet(entries: entries, label: paneSeries.id)
                set.colors = entryColors
                set.drawValuesEnabled = false
                barSets.append(set)
            }
        }

        if !barSets.isEmpty {
            data.barData = BarChartData(dataSets: barSets)
        }
        if !lineSets.isEmpty {
            data.lineData = LineChartData(dataSets: lineSets)
        }

        chart.data = data

        // Align the pane's x-range with the main chart's visible window when
        // known, else fall back to the full series.
        if let visibleRange {
            chart.xAxis.axisMinimum = visibleRange.lowerBound
            chart.xAxis.axisMaximum = visibleRange.upperBound
        } else {
            chart.xAxis.axisMinimum = -0.5
            chart.xAxis.axisMaximum = Double(max(xValueCount, 1)) - 0.5
        }

        let leftAxis = chart.leftAxis
        leftAxis.removeAllLimitLines()
        for limit in guideLines {
            let line = ChartLimitLine(limit: limit)
            line.lineColor = UIColor.hudStroke.withAlphaComponent(0.5)
            line.lineWidth = 0.5
            line.lineDashLengths = [4, 3]
            leftAxis.addLimitLine(line)
        }
        if let yRange {
            leftAxis.axisMinimum = yRange.lowerBound
            leftAxis.axisMaximum = yRange.upperBound
        } else {
            leftAxis.resetCustomAxisMin()
            leftAxis.resetCustomAxisMax()
        }
        chart.notifyDataSetChanged()

        context.coordinator.onVisibleRange = onVisibleRangeChange
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, ChartViewDelegate {
        var onVisibleRange: ((ClosedRange<Double>) -> Void)?

        func emit(_ chart: ChartViewBase) {
            guard let combined = chart as? CombinedChartView else { return }
            let low = combined.lowestVisibleX
            let high = combined.highestVisibleX
            guard low < high else { return }
            onVisibleRange?(low...high)
        }

        func chartTranslated(_ chartView: ChartViewBase, dX: CGFloat, dY: CGFloat) {
            emit(chartView)
        }

        func chartScaled(_ chartView: ChartViewBase, scaleX: CGFloat, scaleY: CGFloat) {
            emit(chartView)
        }
    }
}
