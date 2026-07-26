import XCTest
@testable import ZeroDTETrader

final class PlacementGuideTests: XCTestCase {
    private let min = 500.0
    private let max = 520.0

    func testKeepsAGuideThatIsAlreadyInView() {
        XCTAssertEqual(
            resolveGuidePrice(current: 507.5, lastPrice: 510, min: min, max: max),
            507.5
        )
    }

    func testParksAtTheLastPriceWhenThereIsNoGuideYet() {
        XCTAssertEqual(resolveGuidePrice(current: nil, lastPrice: 510, min: min, max: max), 510)
    }

    func testReanchorsToTheLastPriceWhenTheAxisPansAway() {
        XCTAssertEqual(resolveGuidePrice(current: 480, lastPrice: 510, min: min, max: max), 510)
    }

    func testClampsIntoViewWhenTheLastPriceIsOffScreenToo() {
        XCTAssertEqual(resolveGuidePrice(current: 480, lastPrice: 470, min: min, max: max), 500)
        XCTAssertEqual(resolveGuidePrice(current: 560, lastPrice: 570, min: min, max: max), 520)
    }

    func testFallsBackToTheMiddleWithNothingToSeedFrom() {
        XCTAssertEqual(resolveGuidePrice(current: nil, lastPrice: nil, min: min, max: max), 510)
    }

    func testLeavesTheGuideAloneWhenTheRangeIsDegenerate() {
        XCTAssertEqual(
            resolveGuidePrice(current: 507.5, lastPrice: 510, min: 520, max: 500),
            507.5
        )
        XCTAssertEqual(
            resolveGuidePrice(current: 507.5, lastPrice: 510, min: .nan, max: 520),
            507.5
        )
    }

    func testIgnoresANonFiniteGuideOrLastPrice() {
        XCTAssertEqual(resolveGuidePrice(current: .nan, lastPrice: 510, min: min, max: max), 510)
        XCTAssertEqual(resolveGuidePrice(current: nil, lastPrice: .nan, min: min, max: max), 510)
    }

    func testCountsTheVisibleEdgesAsInView() {
        XCTAssertEqual(resolveGuidePrice(current: 500, lastPrice: 510, min: min, max: max), 500)
        XCTAssertEqual(resolveGuidePrice(current: 520, lastPrice: 510, min: min, max: max), 520)
    }

    func testNeverHandsBackANonFiniteLevel() {
        XCTAssertNil(resolveGuidePrice(current: .nan, lastPrice: 510, min: .nan, max: 520))
    }
}
