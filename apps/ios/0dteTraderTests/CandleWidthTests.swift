import XCTest
@testable import ZeroDTETrader

/// Pure-math coverage for `CandleWidth`, mirroring
/// apps/desktop/src/features/chart/candleWidth.test.ts case-for-case.
final class CandleWidthTests: XCTestCase {
    private let normalWidth: CGFloat = 10
    private let minRatio: CGFloat = 0.20
    private let maxRatio: CGFloat = 0.95

    private func width(_ volume: Double, _ referenceVolume: Double) -> CGFloat {
        CandleWidth.calculate(
            volume: volume,
            referenceVolume: referenceVolume,
            normalCandleWidth: normalWidth,
            minimumWidthRatio: minRatio,
            maximumWidthRatio: maxRatio
        )
    }

    func testZeroVolumeGetsMinimumWidth() {
        XCTAssertEqual(width(0, 100), normalWidth * minRatio, accuracy: 1e-9)
    }

    func testAtOrAboveReferenceVolumeGetsMaximumWidth() {
        XCTAssertEqual(width(100, 100), normalWidth * maxRatio, accuracy: 1e-9)
        XCTAssertEqual(width(500, 100), normalWidth * maxRatio, accuracy: 1e-9)
    }

    func testIntermediateVolumeInterpolatesLinearly() {
        let minWidth = normalWidth * minRatio
        let maxWidth = normalWidth * maxRatio
        XCTAssertEqual(width(50, 100), minWidth + (maxWidth - minWidth) * 0.5, accuracy: 1e-9)
    }

    func testExtremeOutlierClampsToMaximumWidth() {
        XCTAssertEqual(width(1_000_000, 100), normalWidth * maxRatio, accuracy: 1e-9)
    }

    func testInvalidVolumeTreatedAsZero() {
        let zeroWidth = width(0, 100)
        XCTAssertEqual(width(.nan, 100), zeroWidth, accuracy: 1e-9)
        XCTAssertEqual(width(-50, 100), zeroWidth, accuracy: 1e-9)
        XCTAssertEqual(width(.infinity, 100), zeroWidth, accuracy: 1e-9)
    }

    func testZeroOrInvalidReferenceVolumeFallsBackToNormalWidth() {
        XCTAssertEqual(width(100, 0), normalWidth)
        XCTAssertEqual(width(100, -5), normalWidth)
        XCTAssertEqual(width(100, .nan), normalWidth)
    }

    func testNeverReturnsWidthBelowOnePixel() {
        let tiny = CandleWidth.calculate(
            volume: 0,
            referenceVolume: 100,
            normalCandleWidth: 1,
            minimumWidthRatio: minRatio,
            maximumWidthRatio: maxRatio
        )
        XCTAssertEqual(tiny, 1)
    }

    func testPercentileEmptyArrayReturnsZero() {
        XCTAssertEqual(CandleWidth.percentile([], 0.95), 0)
    }

    func testPercentileSingleElementReturnsThatValue() {
        XCTAssertEqual(CandleWidth.percentile([42], 0.95), 42)
    }

    func testReferenceVolumeEmptyRangeIsZero() {
        XCTAssertEqual(CandleWidth.referenceVolume([]), 0)
    }

    func testReferenceVolumeAllZeroOrInvalidIsZero() {
        XCTAssertEqual(CandleWidth.referenceVolume([0, 0, 0]), 0)
        XCTAssertEqual(CandleWidth.referenceVolume([.nan, -1, 0]), 0)
    }

    func testReferenceVolumeComputesP95OverVisibleVolumes() {
        let visible = (1...100).map { Double($0) }
        // p95 rank = 0.95 * 99 = 94.05 -> interpolate between sorted[94]=95 and sorted[95]=96
        XCTAssertEqual(CandleWidth.referenceVolume(visible), 95.05, accuracy: 1e-9)
    }

    func testReferenceVolumeSingleVisibleCandle() {
        XCTAssertEqual(CandleWidth.referenceVolume([42]), 42)
    }
}
