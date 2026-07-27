import UIKit
import XCTest
@testable import ZeroDTETrader

/// Three taps on the chart are the only route in and out of the fullscreen
/// layout now that the toolbar button is gone, so the wiring is worth pinning.
/// What UIKit does with a recognizer is not under test here; that the chart
/// carries one asking for three taps, that it sits alongside the placement
/// guide's single tap rather than replacing it, and that it reaches the layout
/// toggle, all are.
final class ChartTripleTapTests: XCTestCase {
    @MainActor
    func testTheChartCarriesBothTheGuidesTapAndAThreeTapRecognizer() {
        let container = CandleChartRepresentable.ContainerView(frame: .zero)
        let taps = (container.chart.gestureRecognizers ?? [])
            .compactMap { $0 as? UITapGestureRecognizer }
        // DGCharts brings its own tap recognizers to the same view, so these
        // filter rather than compare the whole set: ours are the two that do
        // not cancel touches, because a chart that stopped panning while a
        // layout toggle might be coming would be a bad trade.
        let triple = taps.filter { $0.numberOfTapsRequired == 3 }
        XCTAssertEqual(triple.count, 1)
        XCTAssertEqual(triple.first?.cancelsTouchesInView, false)
        XCTAssertTrue(taps.contains { $0.numberOfTapsRequired == 1 && !$0.cancelsTouchesInView })
    }

    @MainActor
    func testTheThirdTapReachesTheLayoutToggle() {
        let container = CandleChartRepresentable.ContainerView(frame: .zero)
        var toggles = 0
        container.onTripleTap = { toggles += 1 }
        container.handleFullscreenTap()
        XCTAssertEqual(toggles, 1)
    }
}
