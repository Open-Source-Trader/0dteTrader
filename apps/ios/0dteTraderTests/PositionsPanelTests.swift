import XCTest
@testable import ZeroDTETrader

/// The positions drawer's pure row models: formatting, ordering by openedAt,
/// and the trim quantity math they gate on.
final class PositionsPanelTests: XCTestCase {
    private let today = DateParsing.day("2026-08-04") ?? Date(timeIntervalSince1970: 0)

    private func contract(_ symbol: String, strike: Double, type: OptionType, expiration: String) -> OptionContract {
        OptionContract(
            symbol: symbol,
            underlying: "SPY",
            expiration: expiration,
            strike: strike,
            optionType: type,
            bid: 1.0,
            ask: 1.04,
            last: 1.02
        )
    }

    private func position(
        _ symbol: String,
        quantity: Int = 2,
        avgPrice: Double = 1.85,
        markPrice: Double = 2.09,
        unrealizedPnl: Double = 24,
        openedAt: Date? = nil
    ) -> Position {
        Position(
            symbol: symbol,
            assetClass: .option,
            quantity: quantity,
            avgPrice: avgPrice,
            markPrice: markPrice,
            unrealizedPnl: unrealizedPnl,
            multiplier: 100,
            underlyingEntryPrice: nil,
            openedAt: openedAt
        )
    }

    // MARK: - Row formatting

    func testRowFormatsLabelEntryMarkAndPnl() {
        let call = contract("SPY-C-500", strike: 500, type: .call, expiration: "2026-08-08")
        let rows = PositionsPanelRowBuilder.positionRows(
            positions: [position(call.symbol)],
            contractResolver: { $0 == call.symbol ? call : nil },
            today: today
        )

        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].label, "500C Aug 8")
        XCTAssertEqual(rows[0].quantity, "+2")
        XCTAssertEqual(rows[0].entry, "1.85")
        XCTAssertEqual(rows[0].mark, "2.09")
        XCTAssertEqual(rows[0].pnl, "+24.00")
        XCTAssertTrue(rows[0].pnlIsPositive)
    }

    func testRowNegativePnlAndUnresolvedContractFallsBackToSymbol() {
        let rows = PositionsPanelRowBuilder.positionRows(
            positions: [position("SPY260808P00500000", unrealizedPnl: -18.5)],
            contractResolver: { _ in nil },
            today: today
        )

        XCTAssertEqual(rows[0].label, "SPY260808P00500000")
        XCTAssertEqual(rows[0].pnl, "-18.50")
        XCTAssertFalse(rows[0].pnlIsPositive)
    }

    func testFlatPositionsAreDropped() {
        let rows = PositionsPanelRowBuilder.positionRows(
            positions: [position("SPY-FLAT", quantity: 0)],
            contractResolver: { _ in nil },
            today: today
        )
        XCTAssertTrue(rows.isEmpty)
    }

    // MARK: - Ordering (most recently opened first, unknown last)

    func testRowsOrderByOpenedAtDescendingWithUnknownLast() {
        let early = DateParsing.dateTime("2026-08-04T13:30:00Z")
        let late = DateParsing.dateTime("2026-08-04T15:45:00Z")
        XCTAssertNotNil(early)
        XCTAssertNotNil(late)

        let rows = PositionsPanelRowBuilder.positionRows(
            positions: [
                position("C-NO-DATE"),
                position("A-EARLY", openedAt: early),
                position("B-LATE", openedAt: late),
            ],
            contractResolver: { _ in nil },
            today: today
        )

        XCTAssertEqual(rows.map(\.id), ["B-LATE", "A-EARLY", "C-NO-DATE"])
    }

    func testRowsWithoutOpenedAtOrderBySymbolForStability() {
        let rows = PositionsPanelRowBuilder.positionRows(
            positions: [position("B-SYM"), position("A-SYM")],
            contractResolver: { _ in nil },
            today: today
        )
        XCTAssertEqual(rows.map(\.id), ["A-SYM", "B-SYM"])
    }

    // MARK: - Trim quantity (desktop TradeStore.trimHalf parity: floor, no-op at 0)

    func testTrimQuantityHalvesRoundingDown() {
        XCTAssertEqual(TradeViewModel.trimQuantity(5), 2)
        XCTAssertEqual(TradeViewModel.trimQuantity(2), 1)
        XCTAssertEqual(TradeViewModel.trimQuantity(1), 0)
        XCTAssertEqual(TradeViewModel.trimQuantity(-5), 2)
    }

    func testCanTrimFollowsTrimQuantity() {
        let rows = PositionsPanelRowBuilder.positionRows(
            positions: [position("ONE-LOT", quantity: 1), position("TWO-LOT", quantity: 2)],
            contractResolver: { _ in nil },
            today: today
        )
        XCTAssertEqual(rows.first { $0.id == "ONE-LOT" }?.canTrim, false)
        XCTAssertEqual(rows.first { $0.id == "TWO-LOT" }?.canTrim, true)
    }
}
