import XCTest
@testable import ZeroDTETrader

final class GexPresentationTests: XCTestCase {
    func testDollarTextFormatsBillionsMillionsAndThousands() {
        XCTAssertEqual(GexPresentation.dollarText(1_250_000_000), "+$1.3B")
        XCTAssertEqual(GexPresentation.dollarText(-800_000_000), "-$800.0M")
        XCTAssertEqual(GexPresentation.dollarText(42_000_000), "+$42.0M")
        XCTAssertEqual(GexPresentation.dollarText(5_200), "+$5K")
        XCTAssertEqual(GexPresentation.dollarText(0), "+$0")
    }

    func testBandHalfHeightIsQuarterOfTightestSpacing() {
        // SPY-style $1 strikes -> 0.25 bands that never touch.
        XCTAssertEqual(GexPresentation.bandHalfHeight(strikes: [583, 584, 585], spot: 584), 0.25)
        // $5-spaced strikes -> 1.25.
        XCTAssertEqual(GexPresentation.bandHalfHeight(strikes: [580, 585, 595], spot: 585), 1.25)
    }

    func testBandHalfHeightFallsBackForSingleStrike() {
        let half = GexPresentation.bandHalfHeight(strikes: [585], spot: 584.32)
        XCTAssertEqual(half, 584.32 * 0.005 / 4, accuracy: 1e-9)
        // Degenerate zero spot still yields a usable width.
        XCTAssertEqual(GexPresentation.bandHalfHeight(strikes: [585], spot: 0), 0.25)
    }

    func testBandAlphaFloorsScalesAndCaps() {
        XCTAssertEqual(GexPresentation.bandAlpha(intensity: 0, cap: 0.55), 0.15, accuracy: 1e-9)
        XCTAssertEqual(GexPresentation.bandAlpha(intensity: 1, cap: 0.55), 0.55, accuracy: 1e-9)
        XCTAssertEqual(GexPresentation.bandAlpha(intensity: 0.5, cap: 0.6), 0.45, accuracy: 1e-9)
        // Negative intensity (shouldn't occur) never dips below the floor.
        XCTAssertEqual(GexPresentation.bandAlpha(intensity: -1, cap: 0.55), 0.15, accuracy: 1e-9)
    }
}
