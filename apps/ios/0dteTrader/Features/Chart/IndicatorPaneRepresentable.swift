import DGCharts
import SwiftUI
import UIKit

/// Sub-pane chart for oscillators: RSI (single line + 30/70 guides) and MACD
/// (histogram bars + MACD/signal lines). Fully independent pan/zoom — the
/// pane keeps its own viewport, separate from the main chart's.
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
    var resetToken: Int = 0

    /// Pane chart that keeps the TradingView-style over-scroll allowance in
    /// sync with its size (the pane has no container view to hook).
    final class PaneChartView: CombinedChartView {
        override func layoutSubviews() {
            super.layoutSubviews()
            setDragOffsetX(bounds.width * 0.45)
        }
    }

    func makeUIView(context: Context) -> CombinedChartView {
        let chart = PaneChartView()
        chart.drawOrder = [
            CombinedChartView.DrawOrder.bar.rawValue,
            CombinedChartView.DrawOrder.line.rawValue,
        ]
        chart.legend.enabled = false
        chart.noDataText = ""
        chart.backgroundColor = .clear
        chart.doubleTapToZoomEnabled = false
        chart.highlightPerTapEnabled = false
        // DGCharts' built-in pan keeps the x-axis; the gesture controller
        // owns vertical panning through the axis range.
        chart.dragXEnabled = true
        chart.dragYEnabled = false
        // Built-in pinch is fully disabled in favor of the gesture
        // controller's directional pinch (horizontal → time, vertical →
        // value, diagonal → both).
        chart.pinchZoomEnabled = false
        chart.scaleXEnabled = false
        chart.scaleYEnabled = false
        chart.isMultipleTouchEnabled = true
        // TradingView y-axis model: auto-fit (or the pane's fixed range)
        // until a vertical gesture switches the axis to manual control.
        chart.autoScaleMinMaxEnabled = true

        chart.delegate = context.coordinator
        context.coordinator.chart = chart
        context.coordinator.gestures.defaultYRange = yRange
        context.coordinator.gestures.attach(to: chart)

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

        let leftAxis = chart.leftAxis
        leftAxis.removeAllLimitLines()
        for limit in guideLines {
            let line = ChartLimitLine(limit: limit)
            line.lineColor = UIColor.hudStroke.withAlphaComponent(0.5)
            line.lineWidth = 0.5
            line.lineDashLengths = [4, 3]
            leftAxis.addLimitLine(line)
        }
        // Only re-apply the default y-range while the axis is auto-fitted —
        // live ticks must not clobber a range the user set with a vertical
        // pinch or pan.
        context.coordinator.gestures.defaultYRange = yRange
        if context.coordinator.gestures.yMode == .auto {
            if let yRange {
                leftAxis.axisMinimum = yRange.lowerBound
                leftAxis.axisMaximum = yRange.upperBound
            } else {
                leftAxis.resetCustomAxisMin()
                leftAxis.resetCustomAxisMax()
            }
        }
        // Same 12-bar right-offset gap as the main chart so the pane can
        // scroll past the newest bar into empty space.
        chart.xAxis.axisMinimum = -0.5
        chart.xAxis.axisMaximum = Double(xValueCount - 1) + 12
        chart.notifyDataSetChanged()

        // Snap to the default window on first data arrival; after that the
        // pane keeps its own zoom (fully independent of the main chart).
        if context.coordinator.lastCount == 0 && xValueCount > 0 {
            snapToDefaultView(chart, coordinator: context.coordinator)
        }
        context.coordinator.lastCount = xValueCount

        if resetToken != context.coordinator.lastResetToken {
            context.coordinator.lastResetToken = resetToken
            snapToDefaultView(chart, coordinator: context.coordinator)
        }
    }

    /// Default view: the newest ~120 bars, y reset to fit. Used on first
    /// load and by the pane's "A" button.
    private func snapToDefaultView(_ chart: CombinedChartView, coordinator: Coordinator) {
        coordinator.gestures.resetToAuto()
        chart.fitScreen()
        let totalRange = Double(xValueCount) + 12
        let scale = max(1, totalRange / ChartMetrics.visibleCandles)
        chart.zoom(scaleX: CGFloat(scale), scaleY: 1, x: chart.bounds.width, y: 0)
        chart.moveViewToX(Double(xValueCount - 1))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, ChartViewDelegate {
        weak var chart: CombinedChartView?
        var lastResetToken: Int = 0
        var lastCount: Int = 0
        // Same TradingView-style pinch/vertical-pan as the main chart, with
        // this pane's own independent y-axis state machine.
        let gestures = ChartGestureController()
    }
}
