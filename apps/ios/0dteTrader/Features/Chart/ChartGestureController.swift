import DGCharts
import UIKit

/// Shared TradingView-style gesture handling for the candle chart and the
/// indicator sub-panes: a directional pinch (horizontal finger spread zooms
/// the time axis, vertical spread zooms the value axis, diagonal zooms both)
/// plus a one-finger vertical pan. The y-axis follows TradingView's model —
/// it auto-fits the visible window until the user zooms or pans vertically,
/// then stays under manual control until the next reset.
///
/// The x-axis is zoomed through the viewport matrix (so DGCharts' built-in
/// pan keeps working alongside it), but the y-axis is zoomed by rewriting
/// `leftAxis.axisMinimum/axisMaximum` directly: DGCharts' viewport clamps
/// `scaleY >= 1` and pins translation to the fitted range, so free vertical
/// movement past the data is only possible through the axis range.
final class ChartGestureController: NSObject, UIGestureRecognizerDelegate {
    enum YAxisMode {
        case auto
        case manual
    }

    private(set) var yMode: YAxisMode = .auto
    /// Fixed default y-range for bounded panes (RSI/Stoch 0...100);
    /// nil auto-fits the visible data.
    var defaultYRange: ClosedRange<Double>?
    var onTransform: (() -> Void)?

    private weak var chart: BarLineChartViewBase?

    // Pinch state. An axis engages once the finger spread along it has moved
    // `engageThreshold` points from where the gesture began, and stays
    // engaged for the rest of the gesture — a per-frame gate would toggle
    // scaling on and off around the threshold and read as jitter.
    private let engageThreshold: CGFloat = 12
    private var startXDist: CGFloat = 0
    private var startYDist: CGFloat = 0
    private var lastXDist: CGFloat = 0
    private var xEngaged = false
    private var yEngaged = false
    private var yBaseDist: CGFloat = 0
    private var yBaseRange: Double = 0
    private var yAnchorValue: Double = 0

    private var lastPanY: CGFloat = 0

    func attach(to chart: BarLineChartViewBase) {
        self.chart = chart

        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch(_:)))
        pinch.delegate = self
        chart.addGestureRecognizer(pinch)

        let pan = UIPanGestureRecognizer(target: self, action: #selector(handleVerticalPan(_:)))
        pan.maximumNumberOfTouches = 1
        pan.delegate = self
        chart.addGestureRecognizer(pan)
    }

    /// Re-enters auto-fit: restores the pane's fixed range when it has one,
    /// otherwise hands the y-range back to DGCharts' visible-window autoscale.
    /// Called from the reset path before the viewport snap.
    func resetToAuto() {
        guard let chart else { return }
        yMode = .auto
        let axis = chart.leftAxis
        if let defaultYRange {
            axis.axisMinimum = defaultYRange.lowerBound
            axis.axisMaximum = defaultYRange.upperBound
        } else {
            axis.resetCustomAxisMin()
            axis.resetCustomAxisMax()
        }
        chart.autoScaleMinMaxEnabled = true
        chart.notifyDataSetChanged()
    }

    /// Freezes the currently displayed y-range under manual control:
    /// assigning axisMinimum/axisMaximum sets the custom-range flags, so
    /// live data updates keep the user's range instead of refitting.
    private func enterManualIfNeeded() {
        guard yMode == .auto, let chart else { return }
        let axis = chart.leftAxis
        let minValue = axis.axisMinimum
        let maxValue = axis.axisMaximum
        axis.axisMinimum = minValue
        axis.axisMaximum = maxValue
        chart.autoScaleMinMaxEnabled = false
        yMode = .manual
    }

    @objc private func handlePinch(_ recognizer: UIPinchGestureRecognizer) {
        guard let chart else { return }
        switch recognizer.state {
        case .began, .changed:
            guard recognizer.numberOfTouches >= 2 else { return }
            let p1 = recognizer.location(ofTouch: 0, in: chart)
            let p2 = recognizer.location(ofTouch: 1, in: chart)
            pinchChanged(
                chart: chart,
                began: recognizer.state == .began,
                xDist: abs(p1.x - p2.x),
                yDist: abs(p1.y - p2.y),
                mid: CGPoint(x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2)
            )
        case .ended, .cancelled, .failed:
            // Axis label widths may have changed; recompute the offsets.
            chart.notifyDataSetChanged()
            onTransform?()
        default:
            break
        }
    }

    private func pinchChanged(chart: BarLineChartViewBase, began: Bool, xDist: CGFloat, yDist: CGFloat, mid: CGPoint) {
        if began {
            chart.stopDeceleration()
            startXDist = xDist
            startYDist = yDist
            xEngaged = false
            yEngaged = false
            return
        }

        if !xEngaged, abs(xDist - startXDist) >= engageThreshold {
            xEngaged = true
            lastXDist = xDist
        }
        if !yEngaged, abs(yDist - startYDist) >= engageThreshold {
            yEngaged = true
            enterManualIfNeeded()
            yBaseDist = yDist
            let axis = chart.leftAxis
            yBaseRange = axis.axisMaximum - axis.axisMinimum
            yAnchorValue = chart.valueForTouchPoint(point: mid, axis: .left).y
        }

        if xEngaged {
            if lastXDist > 20, xDist > 0 {
                // Incremental step so DGCharts' simultaneous pan supplies the
                // midpoint translation; together they keep the candle between
                // the fingers pinned. The anchor must be in touch-matrix
                // space, which starts after the left axis gutter.
                let step = min(max(xDist / lastXDist, 0.5), 2.0)
                let anchorX = mid.x - chart.viewPortHandler.offsetLeft
                var matrix = CGAffineTransform(translationX: anchorX, y: 0)
                    .scaledBy(x: step, y: 1)
                    .translatedBy(x: -anchorX, y: 0)
                matrix = chart.viewPortHandler.touchMatrix.concatenating(matrix)
                _ = chart.viewPortHandler.refresh(newMatrix: matrix, chart: chart, invalidate: true)
            }
            lastXDist = xDist
        }

        if yEngaged {
            // Cumulative zoom from the engagement spread, solved so the value
            // that was between the fingers stays pinned under the (moving)
            // midpoint — one formula covers zoom and vertical travel with no
            // frame-to-frame drift.
            let scale = min(max(yDist / max(yBaseDist, 40), 0.05), 20)
            let newRange = yBaseRange / Double(scale)
            let content = chart.viewPortHandler.contentRect
            let fromBottom = content.height > 0 ? (content.maxY - mid.y) / content.height : 0.5
            let axis = chart.leftAxis
            axis.axisMinimum = yAnchorValue - Double(fromBottom) * newRange
            axis.axisMaximum = axis.axisMinimum + newRange
            chart.notifyDataSetChanged()
        }
        onTransform?()
    }

    @objc private func handleVerticalPan(_ recognizer: UIPanGestureRecognizer) {
        guard let chart else { return }
        switch recognizer.state {
        case .began:
            chart.stopDeceleration()
            enterManualIfNeeded()
            lastPanY = recognizer.translation(in: chart).y
        case .changed:
            let translationY = recognizer.translation(in: chart).y
            let dy = translationY - lastPanY
            lastPanY = translationY
            let content = chart.viewPortHandler.contentRect
            guard content.height > 0 else { return }
            let axis = chart.leftAxis
            let shift = Double(dy) * (axis.axisMaximum - axis.axisMinimum) / Double(content.height)
            axis.axisMinimum += shift
            axis.axisMaximum += shift
            chart.notifyDataSetChanged()
            onTransform?()
        default:
            break
        }
    }

    // MARK: - UIGestureRecognizerDelegate

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        // A deliberate vertical drag unlocks auto-fit; mostly-horizontal
        // drags in auto mode stay with DGCharts' x-pan. Once manual, every
        // drag also pans the y-range (TradingView's unlocked behavior).
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        if yMode == .manual { return true }
        let velocity = pan.velocity(in: chart)
        return abs(velocity.y) > abs(velocity.x)
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        true
    }
}
