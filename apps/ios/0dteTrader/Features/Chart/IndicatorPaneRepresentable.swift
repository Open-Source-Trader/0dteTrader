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
        // Built-in pinch is fully disabled in favor of the coordinator's
        // directional pinch (horizontal → time, vertical → price, diagonal → both).
        chart.pinchZoomEnabled = false
        chart.scaleXEnabled = false
        chart.scaleYEnabled = false
        chart.isMultipleTouchEnabled = true

        chart.delegate = context.coordinator
        context.coordinator.chart = chart

        let pinch = UIPinchGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDirectionalPinch(_:))
        )
        pinch.delegate = context.coordinator
        chart.addGestureRecognizer(pinch)

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
        if let yRange {
            leftAxis.axisMinimum = yRange.lowerBound
            leftAxis.axisMaximum = yRange.upperBound
        } else {
            leftAxis.resetCustomAxisMin()
            leftAxis.resetCustomAxisMax()
        }
        chart.notifyDataSetChanged()

        // Snap to the default window on first data arrival; after that the
        // pane keeps its own zoom (fully independent of the main chart).
        if context.coordinator.lastCount == 0 && xValueCount > 0 {
            snapToDefaultView(chart)
        }
        context.coordinator.lastCount = xValueCount

        if resetToken != context.coordinator.lastResetToken {
            context.coordinator.lastResetToken = resetToken
            snapToDefaultView(chart)
        }
    }

    /// Default view: the newest ~120 bars, y reset to fit. Used on first
    /// load and by the pane's "A" button.
    private func snapToDefaultView(_ chart: CombinedChartView) {
        chart.fitScreen()
        let scale = max(1, Double(xValueCount) / ChartMetrics.visibleCandles)
        chart.zoom(scaleX: CGFloat(scale), scaleY: 1, x: chart.bounds.width, y: 0)
        chart.moveViewToX(Double(xValueCount - 1))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, ChartViewDelegate, UIGestureRecognizerDelegate {
        weak var chart: CombinedChartView?
        var lastResetToken: Int = 0
        var lastCount: Int = 0
        private var lastXDist: CGFloat = 0
        private var lastYDist: CGFloat = 0

        // Same directional pinch as the main chart: horizontal spread zooms
        // the x-axis, vertical spread zooms y, diagonal zooms both.
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
}
