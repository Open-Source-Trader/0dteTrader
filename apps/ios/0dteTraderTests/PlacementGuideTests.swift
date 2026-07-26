import XCTest
@testable import ZeroDTETrader

final class PlacementGuideTests: XCTestCase {
    // Named for the bounds rather than `min`/`max` so the bare identifiers keep
    // resolving to `Swift.min`/`Swift.max` inside this class, the same collision
    // `resolveGuidePrice` sidesteps with its `min lowerBound:` label.
    private let lowerBound = 500.0
    private let upperBound = 520.0
    // Deliberately not the midpoint (510). An in-range last price that collided
    // with the midpoint fallback would let "re-anchored to the last price" and
    // "fell all the way through" pass the same assertion, so deleting a branch
    // would not fail the test that names it.
    private let lastPrice = 512.0

    func testKeepsAGuideThatIsAlreadyInView() {
        XCTAssertEqual(
            resolveGuidePrice(
                current: 507.5,
                lastPrice: lastPrice,
                min: lowerBound,
                max: upperBound
            ),
            507.5
        )
    }

    func testParksAtTheLastPriceWhenThereIsNoGuideYet() {
        XCTAssertEqual(
            resolveGuidePrice(current: nil, lastPrice: lastPrice, min: lowerBound, max: upperBound),
            512
        )
    }

    func testReanchorsToTheLastPriceWhenTheAxisPansAway() {
        XCTAssertEqual(
            resolveGuidePrice(current: 480, lastPrice: lastPrice, min: lowerBound, max: upperBound),
            512
        )
    }

    func testClampsIntoViewWhenTheLastPriceIsOffScreenToo() {
        XCTAssertEqual(
            resolveGuidePrice(current: 480, lastPrice: 470, min: lowerBound, max: upperBound),
            500
        )
        XCTAssertEqual(
            resolveGuidePrice(current: 560, lastPrice: 570, min: lowerBound, max: upperBound),
            520
        )
    }

    func testFallsBackToTheMiddleWithNothingToSeedFrom() {
        XCTAssertEqual(
            resolveGuidePrice(current: nil, lastPrice: nil, min: lowerBound, max: upperBound),
            510
        )
    }

    func testLeavesTheGuideAloneWhenTheRangeIsDegenerate() {
        XCTAssertEqual(
            resolveGuidePrice(current: 507.5, lastPrice: lastPrice, min: 520, max: 500),
            507.5
        )
        XCTAssertEqual(
            resolveGuidePrice(current: 507.5, lastPrice: lastPrice, min: .nan, max: 520),
            507.5
        )
        // An axis zoomed to a single price is the realistic degenerate case, and
        // the strict `upperBound > lowerBound` guard has to reject it too.
        XCTAssertEqual(
            resolveGuidePrice(current: 507.5, lastPrice: lastPrice, min: 510, max: 510),
            507.5
        )
    }

    func testIgnoresANonFiniteGuideOrLastPrice() {
        XCTAssertEqual(
            resolveGuidePrice(current: .nan, lastPrice: lastPrice, min: lowerBound, max: upperBound),
            512
        )
        XCTAssertEqual(
            resolveGuidePrice(
                current: .infinity,
                lastPrice: lastPrice,
                min: lowerBound,
                max: upperBound
            ),
            512
        )
        // Nothing usable to seed from once a NaN last price is discarded, so this
        // one lands on the midpoint rather than the last price.
        XCTAssertEqual(
            resolveGuidePrice(current: nil, lastPrice: .nan, min: lowerBound, max: upperBound),
            510
        )
    }

    func testCountsTheVisibleEdgesAsInView() {
        XCTAssertEqual(
            resolveGuidePrice(current: 500, lastPrice: lastPrice, min: lowerBound, max: upperBound),
            500
        )
        XCTAssertEqual(
            resolveGuidePrice(current: 520, lastPrice: lastPrice, min: lowerBound, max: upperBound),
            520
        )
    }

    func testNeverHandsBackANonFiniteLevel() {
        XCTAssertNil(
            resolveGuidePrice(current: .nan, lastPrice: lastPrice, min: .nan, max: 520)
        )
    }
}
