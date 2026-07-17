import Charts
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
        chart.dragEnabled = false
        chart.pinchZoomEnabled = false
        chart.scaleXEnabled = false
        chart.scaleYEnabled = false

        let xAxis = chart.xAxis
        xAxis.drawLabelsEnabled = false
        xAxis.drawGridLinesEnabled = false
        xAxis.drawAxisLineEnabled = false

        chart.rightAxis.enabled = false
        let leftAxis = chart.leftAxis
        leftAxis.labelTextColor = .secondaryLabel
        leftAxis.labelFont = .monospacedDigitSystemFont(ofSize: 9, weight: .regular)
        leftAxis.gridColor = UIColor.separator.withAlphaComponent(0.25)
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
                    entryColors.append(value >= 0 ? .systemGreen : .systemRed)
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

        // Align the pane's x-range with the main chart's candle indices.
        chart.xAxis.axisMinimum = -0.5
        chart.xAxis.axisMaximum = Double(max(xValueCount, 1)) - 0.5

        let leftAxis = chart.leftAxis
        leftAxis.removeAllLimitLines()
        for limit in guideLines {
            let line = ChartLimitLine(limit: limit)
            line.lineColor = UIColor.separator
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
    }
}
