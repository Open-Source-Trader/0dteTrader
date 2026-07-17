import XCTest
@testable import ZeroDTETrader

final class MidPriceTests: XCTestCase {
    private let accuracy = 1e-6

    /// Acceptance criteria (PRD §5.4): bid 1.20 / ask 1.28 → limit sent at 1.24.
    func testMidPrice_acceptanceCase() {
        XCTAssertEqual(PriceMath.midPrice(bid: 1.20, ask: 1.28), 1.24, accuracy: accuracy)
    }

    func testMidPrice_equalBidAsk() {
        XCTAssertEqual(PriceMath.midPrice(bid: 5.0, ask: 5.0), 5.0, accuracy: accuracy)
    }

    func testMidPrice_roundsToPenniesByDefault() {
        // 1.001 / 1.004 → raw mid 1.0025 → 1.00 rounded to 2 decimals.
        XCTAssertEqual(PriceMath.midPrice(bid: 1.001, ask: 1.004), 1.00, accuracy: accuracy)
    }

    func testMidPrice_customPrecision() {
        // Futures tick at quarters: precision 3 keeps 1.0025 → 1.003.
        XCTAssertEqual(PriceMath.midPrice(bid: 1.001, ask: 1.004, precision: 3), 1.003, accuracy: accuracy)
    }

    /// The domain model exposes the same mid used by the trade panel.
    func testOptionContract_mid_matchesPriceMath() {
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
        XCTAssertEqual(contract.mid, 1.24, accuracy: accuracy)
    }

    func testFuturesContract_mid_matchesPriceMath() {
        let contract = FuturesContract(
            symbol: "MESU26",
            root: "MES",
            expiration: "2026-09-18",
            frontMonth: true,
            bid: 6010.25,
            ask: 6010.75,
            last: 6010.50
        )
        XCTAssertEqual(contract.mid, 6010.5, accuracy: accuracy)
    }
}
