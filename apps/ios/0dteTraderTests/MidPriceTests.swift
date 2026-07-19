import XCTest
@testable import ZeroDTETrader

final class MidPriceTests: XCTestCase {
    private let accuracy = 1e-6

    /// Acceptance criteria (PRD §5.4): bid 1.20 / ask 1.28 → limit sent at 1.24.
    func testMidPrice_acceptanceCase() throws {
        XCTAssertEqual(try XCTUnwrap(PriceMath.midPrice(bid: 1.20, ask: 1.28)), 1.24, accuracy: accuracy)
    }

    func testMidPrice_equalBidAsk() throws {
        // A locked market (bid == ask) is a valid, if unusual, quote.
        XCTAssertEqual(try XCTUnwrap(PriceMath.midPrice(bid: 5.0, ask: 5.0)), 5.0, accuracy: accuracy)
    }

    func testMidPrice_roundsToPenniesByDefault() throws {
        // 1.001 / 1.004 → raw mid 1.0025 → 1.00 rounded to 2 decimals.
        XCTAssertEqual(try XCTUnwrap(PriceMath.midPrice(bid: 1.001, ask: 1.004)), 1.00, accuracy: accuracy)
    }

    func testMidPrice_customPrecision() throws {
        // Sub-penny precision is available for finer-quoted instruments.
        XCTAssertEqual(try XCTUnwrap(PriceMath.midPrice(bid: 1.001, ask: 1.004, precision: 3)), 1.003, accuracy: accuracy)
    }

    func testMidPrice_zeroOrNegativeSides_returnNil() {
        XCTAssertNil(PriceMath.midPrice(bid: 0, ask: 0))
        XCTAssertNil(PriceMath.midPrice(bid: 0, ask: 1.05))
        XCTAssertNil(PriceMath.midPrice(bid: 1.0, ask: 0))
        XCTAssertNil(PriceMath.midPrice(bid: -1, ask: 2))
    }

    func testMidPrice_crossedSpread_returnsNil() {
        XCTAssertNil(PriceMath.midPrice(bid: 1.1, ask: 1.0))
    }

    func testMidPrice_nanInputs_returnNil() {
        XCTAssertNil(PriceMath.midPrice(bid: .nan, ask: 1.0))
        XCTAssertNil(PriceMath.midPrice(bid: 1.0, ask: .nan))
    }

    /// The domain model exposes the same mid used by the trade panel.
    func testOptionContract_mid_matchesPriceMath() throws {
        let contract = OptionContract(
            symbol: "SPY260717C00503000",
            underlying: "SPY",
            expiration: "2026-07-17",
            strike: 503,
            optionType: .call,
            bid: 1.20,
            ask: 1.28,
            last: 1.25
        )
        XCTAssertEqual(try XCTUnwrap(contract.mid), 1.24, accuracy: accuracy)
    }

    func testOptionContract_mid_nilOnEmptyQuote() {
        let contract = OptionContract(
            symbol: "SPY260717C00503000",
            underlying: "SPY",
            expiration: "2026-07-17",
            strike: 503,
            optionType: .call,
            bid: 0,
            ask: 0,
            last: 0
        )
        XCTAssertNil(contract.mid)
    }
}
