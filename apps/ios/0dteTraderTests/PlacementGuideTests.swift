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

    /// The order-line rows must never reach into the placement handle's touch
    /// target. Both hit paths check the handle before the rows, so a pill that
    /// overlapped it would lose the touch — and the rightmost pill is ✕, which
    /// cancels a working order. This asserts the geometry directly rather than
    /// the constants that feed it, so any future change to either derivation
    /// fails here instead of silently covering a live-money control.
    @MainActor
    func testRowsNeverReachIntoTheHandlesTouchTarget() {
        let overlay = OrderLineOverlayView(frame: .zero)
        // Narrow and wide panes, with the options-analytics rail off and on.
        for width in [320.0, 430.0, 1024.0] as [CGFloat] {
            for inset in [0.0, 64.0, 180.0] as [CGFloat] {
                overlay.frame = CGRect(x: 0, y: 0, width: width, height: 400)
                overlay.rightInset = inset
                XCTAssertLessThanOrEqual(
                    overlay.rowRightEdge + AppOrderLine.pillGap / 2,
                    overlay.handleTouchLeft,
                    "rows overlap the handle at width \(width), inset \(inset)"
                )
            }
        }
    }

    // MARK: - Level input

    /// The defect the desktop twin shipped: holding the raw text only while it
    /// was *unparseable* snapped `"4300."` back to its canonical form mid-word,
    /// so typing `4300.50` produced `430050`. The draft has to survive every
    /// keystroke, which means the shape check has to accept the trailing point.
    func testAcceptsALevelBeingTypedOneKeystrokeAtATime() {
        var draft = ""
        for key in "4300.50" {
            let next = draft + String(key)
            XCTAssertTrue(isLevelInputShape(next), "rejected \(next)")
            draft = next
        }
        XCTAssertEqual(draft, "4300.50")
        XCTAssertEqual(parseLevelInput(draft), 4300.5)
        XCTAssertEqual(parseLevelInput("4300."), 4300)
    }

    func testRejectsShapesThatAreNotDecimalPrices() {
        // Every one of these is something `Double(_:)` reads happily and nobody
        // means to type into a dollar level.
        for text in ["1e5", "0x1f", "-3", " 42 ", "4.3.0", "inf", "nan", "4,300", "٤٣"] {
            XCTAssertFalse(isLevelInputShape(text), "accepted \(text)")
            XCTAssertNil(parseLevelInput(text), "parsed \(text)")
        }
    }

    /// A `Binding` setter that rejects a keystroke by returning early does not
    /// reliably revert the text field, so the field could show `4300..` while
    /// the model held `4300.` — valid, submittable, and not what is on screen.
    /// Sanitising means every input maps to something the model can hold.
    func testSanitisingLeavesOnlyAShapeTheFieldCanHold() {
        let cases = [
            ("4300..", "4300."),
            ("4300.5.0", "4300.50"),
            ("1e5", "15"),
            ("0x1f", "01"),
            ("-3", "3"),
            (" 42 ", "42"),
            ("$4,300.50", "4300.50"),
            ("٤٣", ""),
        ]
        for (raw, expected) in cases {
            let clean = sanitiseLevelInput(raw, foldingComma: false)
            XCTAssertEqual(clean, expected, "sanitising \(raw)")
            // Whatever comes out must be something the field can hold, always.
            XCTAssertTrue(isLevelInputShape(clean), "unholdable shape from \(raw)")
        }
    }

    func testFoldsTheCommaOnlyForCommaDecimalLocales() {
        // The `decimalPad` decimal key emits `,` in these locales, so it has to
        // mean "decimal point" there.
        XCTAssertEqual(sanitiseLevelInput("4300,50", foldingComma: true), "4300.50")
        // Elsewhere a comma can only be a grouping mark; promoting it would turn
        // 1,234.56 into 1.234.
        XCTAssertEqual(sanitiseLevelInput("1,234.56", foldingComma: false), "1234.56")
    }

    func testHasNoLevelAboveTheMaximum() {
        // Desktop caps its stepper at 100000; without the same bound on the way
        // in, a pasted twenty-digit level is finite, passes every guard, and is
        // armable.
        XCTAssertEqual(parseLevelInput("100000"), 100_000)
        XCTAssertNil(parseLevelInput("100000.01"))
        XCTAssertNil(parseLevelInput("999999999999999999999999"))
    }

    func testHasNoLevelWhileTheFieldIsEmptyOrZero() {
        // Zero used to pass every guard — it is finite — and PLACE would arm a
        // chart order at a trigger price of zero.
        for text in ["", ".", "0", "0.00", "00.0"] {
            XCTAssertNil(parseLevelInput(text), "parsed \(text) as a level")
        }
    }
}
