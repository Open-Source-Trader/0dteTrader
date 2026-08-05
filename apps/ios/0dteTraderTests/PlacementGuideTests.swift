import XCTest
@testable import ZeroDTETrader

final class PlacementGuideTests: XCTestCase {
    // Named for the bounds rather than `min`/`max` so the bare identifiers keep
    // resolving to `Swift.min`/`Swift.max` inside this class, the same collision
    // `resolveGuidePrice` sidesteps with its `min lowerBound:` label.
    private let lowerBound = 500.0
    private let upperBound = 520.0

    func testKeepsAGuideThatIsInViewExactlyWhereItWasSummoned() {
        XCTAssertEqual(
            resolveGuidePrice(current: 507.5, min: lowerBound, max: upperBound),
            507.5
        )
    }

    func testHasNoGuideUntilOneHasBeenSummoned() {
        XCTAssertNil(resolveGuidePrice(current: nil, min: lowerBound, max: upperBound))
    }

    func testDismissesTheGuideWhenTheAxisPansTheLevelOutOfView() {
        // Not re-anchored to anything: the level is one the user pointed at, and
        // quietly moving it elsewhere would arm an order they never chose.
        XCTAssertNil(resolveGuidePrice(current: 480, min: lowerBound, max: upperBound))
        XCTAssertNil(resolveGuidePrice(current: 560, min: lowerBound, max: upperBound))
    }

    func testCountsTheVisibleEdgesAsInView() {
        XCTAssertEqual(resolveGuidePrice(current: 500, min: lowerBound, max: upperBound), 500)
        XCTAssertEqual(resolveGuidePrice(current: 520, min: lowerBound, max: upperBound), 520)
    }

    func testHoldsTheLevelWhenTheRangeIsDegenerate() {
        // No usable price transform this frame is a fact about the chart, not
        // about where the user put the guide, so it must not dismiss one.
        XCTAssertEqual(resolveGuidePrice(current: 507.5, min: 520, max: 500), 507.5)
        XCTAssertEqual(resolveGuidePrice(current: 507.5, min: .nan, max: 520), 507.5)
        // An axis zoomed to a single price is the realistic degenerate case, and
        // the strict `upperBound > lowerBound` guard has to reject it too.
        XCTAssertEqual(resolveGuidePrice(current: 507.5, min: 510, max: 510), 507.5)
    }

    func testNeverHandsBackANonFiniteLevel() {
        XCTAssertNil(resolveGuidePrice(current: .nan, min: lowerBound, max: upperBound))
        XCTAssertNil(resolveGuidePrice(current: .infinity, min: lowerBound, max: upperBound))
        XCTAssertNil(resolveGuidePrice(current: .nan, min: .nan, max: 520))
    }

    /// The order-line rows must never reach into the placement handle's touch
    /// target while a guide is showing. Both hit paths check the handle before
    /// the rows, so a pill that overlapped it would lose the touch — and the
    /// rightmost pill is ✕, which cancels a working order. This asserts the
    /// geometry directly rather than the constants that feed it, so any future
    /// change to either derivation fails here instead of silently covering a
    /// live-money control.
    @MainActor
    func testRowsNeverReachIntoTheHandlesTouchTarget() {
        let overlay = OrderLineOverlayView(frame: .zero)
        overlay.settings = .default
        overlay.canPlaceChartOrder = true
        // Any level will do: the band is reserved at every y, not just the
        // guide's, so that the rows stay aligned as it is dragged past them.
        overlay.guidePrice = 500
        XCTAssertTrue(overlay.isGuideShowing, "the guide must be showing for this to mean anything")
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

    /// And they get the width back when no guide is showing. The band exists to
    /// keep ✕ out from under the handle; with no handle drawn there is nothing
    /// to avoid, and charging every row for it would shrink the pills for free.
    @MainActor
    func testRowsReclaimTheHandlesBandWithNoGuideShowing() {
        let overlay = OrderLineOverlayView(frame: CGRect(x: 0, y: 0, width: 430, height: 400))
        overlay.settings = .default
        overlay.canPlaceChartOrder = true
        overlay.guidePrice = nil
        XCTAssertFalse(overlay.isGuideShowing)
        XCTAssertEqual(overlay.rowRightEdge, 430 - AppOrderLine.rowRightMargin)
        // …and the rail still pushes them in when it is on.
        overlay.rightInset = 64
        XCTAssertEqual(overlay.rowRightEdge, 430 - AppOrderLine.rowRightMargin - 64)
    }

    /// The handle sits flush against the pane's right border regardless of the
    /// options-analytics rail. The rows clear the rail because they are a column
    /// of values it would overlap; the handle is a single chip the user reaches
    /// for at the edge, and inset past the rail it lands where nobody aims.
    @MainActor
    func testTheHandleStaysFlushRightWhateverTheRailDoes() {
        let overlay = OrderLineOverlayView(frame: CGRect(x: 0, y: 0, width: 430, height: 400))
        let flush = 430 - AppPlacementGuide.handleMargin - AppPlacementGuide.handleSize
        for inset in [0.0, 64.0, 180.0] as [CGFloat] {
            overlay.rightInset = inset
            XCTAssertEqual(overlay.handleLeft, flush, "inset \(inset) moved the handle")
        }
    }

    /// The `+` handle and the reset button share a column: same width, same
    /// left edge, same right edge, at every pane width. They line up because
    /// both read `ChartMetrics.cornerControl*`, and this is what fails if
    /// someone gives either one a number of its own again.
    @MainActor
    func testTheHandleAndTheResetButtonShareAColumn() {
        let overlay = OrderLineOverlayView(frame: .zero)
        for width in [320.0, 430.0, 1024.0] as [CGFloat] {
            overlay.frame = CGRect(x: 0, y: 0, width: width, height: 400)
            let resetLeft = width - ChartMetrics.cornerControlInset - ChartMetrics.cornerControlSize
            let resetRight = width - ChartMetrics.cornerControlInset
            XCTAssertEqual(overlay.handleLeft, resetLeft, "left edges differ at width \(width)")
            XCTAssertEqual(
                overlay.handleLeft + AppPlacementGuide.handleSize,
                resetRight,
                "right edges differ at width \(width)"
            )
        }
    }

    /// …and sharing that column is exactly why the drag has to stop short of
    /// the bottom. `A` is a SwiftUI view laid over the overlay, so it takes
    /// every touch inside its own frame; a handle dragged under it could never
    /// be picked up again.
    @MainActor
    func testTheGuideCannotBeDraggedUnderTheResetButton() {
        let height: CGFloat = 400
        let overlay = OrderLineOverlayView(frame: CGRect(x: 0, y: 0, width: 430, height: height))
        let resetTop = height - ChartMetrics.cornerControlInset - ChartMetrics.cornerControlSize
        // The handle's bottom edge at the clamp, versus the top of `A`.
        XCTAssertLessThanOrEqual(
            overlay.guideDragMaxY + AppPlacementGuide.handleSize / 2,
            resetTop,
            "the handle's bottom edge reaches into the reset button"
        )
        // And it is a clamp, not a ban: most of the pane is still reachable.
        XCTAssertGreaterThan(overlay.guideDragMaxY, height * 0.85)
    }

    // MARK: - Row line

    /// A row's line is drawn in two segments — left edge to `row.left`, and
    /// `row.right` out to the pane's border — so it emerges on the far side of
    /// the ✕ instead of stopping at the buttons. Both ends are derived from the
    /// row as laid out, so they cannot drift from the pills they bracket.
    @MainActor
    func testARowsLineResumesPastItsButtonsAndRunsToTheBorder() {
        let width: CGFloat = 430
        let overlay = OrderLineOverlayView(frame: CGRect(x: 0, y: 0, width: width, height: 400))
        overlay.settings = .default
        // The options-analytics rail on, which is what pulls the row inboard far
        // enough for the right-hand segment to be worth drawing.
        overlay.rightInset = 120
        let row = overlay.layoutRow(
            target: .order("id"),
            y: 100,
            labels: [(.quantity, "1"), (.kind, "LIMIT"), (.orderType, "MID"), (.close, "✕")]
        )

        // `right` is the ✕'s trailing edge, not a second derivation of the row's
        // extent — the two would drift apart the moment layout changed.
        XCTAssertEqual(row.right, row.pills.last?.frame.maxX)
        XCTAssertEqual(row.right, overlay.rowRightEdge)
        XCTAssertLessThan(row.left, row.right)

        // Segment 1 stops short of the first pill, segment 2 starts clear of the
        // last one, and segment 2 reaches the pane's true border rather than the
        // rail's inset edge — a line that stopped at the rail would end in the
        // middle of the chart with nothing to explain why.
        XCTAssertLessThan(row.left - AppOrderLine.rowLineGap, row.pills[0].frame.minX)
        XCTAssertGreaterThan(row.right + AppOrderLine.rowLineGap, row.right)
        XCTAssertGreaterThan(width, row.right + AppOrderLine.rowLineGap)
        XCTAssertGreaterThan(width - (row.right + AppOrderLine.rowLineGap), overlay.rightInset / 2)
    }

    // MARK: - Accessibility

    /// Everyone else dismisses the guide with a second tap on empty chart space.
    /// VoiceOver cannot make that tap, so without the custom action a summoned
    /// guide could never be put away without a pointer. It is offered only while
    /// one is showing — a dismiss on the dormant handle would do nothing.
    @MainActor
    func testVoiceOverCanDismissAGuideItSummoned() {
        let overlay = OrderLineOverlayView(frame: CGRect(x: 0, y: 0, width: 430, height: 400))
        overlay.settings = .default
        overlay.canPlaceChartOrder = true

        // Dormant: an element to focus, but nothing to dismiss.
        overlay.guidePrice = nil
        overlay.handleFrame = .zero
        let dormant = overlay.placementAccessibilityElement()
        XCTAssertEqual(dormant?.accessibilityLabel, "Show the order placement guide")
        XCTAssertNil(dormant?.accessibilityCustomActions)

        // Showing: the action is there and it actually puts the guide away.
        overlay.guidePrice = 500
        overlay.handleFrame = CGRect(x: overlay.handleLeft, y: 100, width: 20, height: 20)
        let showing = overlay.placementAccessibilityElement()
        let actions = showing?.accessibilityCustomActions
        XCTAssertEqual(actions?.count, 1)
        XCTAssertEqual(actions?.first?.name, "Dismiss the placement guide")
        XCTAssertTrue(actions?.first?.actionHandler?(actions![0]) ?? false)
        XCTAssertNil(overlay.guidePrice)
        XCTAssertFalse(overlay.isGuideShowing)

        // And a second invocation reports failure rather than silently
        // succeeding at nothing.
        XCTAssertFalse(actions?.first?.actionHandler?(actions![0]) ?? true)
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
