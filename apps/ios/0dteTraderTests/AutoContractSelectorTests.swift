import XCTest
@testable import ZeroDTETrader

final class AutoContractSelectorTests: XCTestCase {
    private let expiration0DTE = "2026-07-17"
    private let expirationLater = "2026-07-20"

    // Fixed "today" so nearest-expiration selection is deterministic.
    private var today: Date {
        DateParsing.day("2026-07-17") ?? Date(timeIntervalSince1970: 0)
    }

    // MARK: - Helpers

    private func contract(_ symbol: String, expiration: String, strike: Double, type: OptionType) -> OptionContract {
        OptionContract(
            symbol: symbol,
            underlying: "SPY",
            expiration: expiration,
            strike: strike,
            optionType: type,
            bid: 1.20,
            ask: 1.28,
            last: 1.24
        )
    }

    /// 0DTE strikes 500...505 (both types), later expiration strikes 510...515 (both types).
    /// Expirations intentionally unsorted.
    private func makeChain(price: Double = 502.13) -> OptionsChain {
        var contracts: [OptionContract] = []
        for strike in stride(from: 500.0, through: 505.0, by: 1.0) {
            contracts.append(contract("C0-\(Int(strike))", expiration: expiration0DTE, strike: strike, type: .call))
            contracts.append(contract("P0-\(Int(strike))", expiration: expiration0DTE, strike: strike, type: .put))
        }
        for strike in stride(from: 510.0, through: 515.0, by: 1.0) {
            contracts.append(contract("C1-\(Int(strike))", expiration: expirationLater, strike: strike, type: .call))
            contracts.append(contract("P1-\(Int(strike))", expiration: expirationLater, strike: strike, type: .put))
        }
        return OptionsChain(
            underlying: "SPY",
            underlyingPrice: price,
            expirations: [expirationLater, expiration0DTE],
            contracts: contracts
        )
    }

    // MARK: - Acceptance criteria (PRD §5.3)

    func testAutoCall_lastBetweenStrikes_picksLowestStrictlyAbove() {
        let chain = makeChain(price: 502.13)
        let selected = AutoContractSelector.selectAutoOTM(chain: chain, optionType: .call, today: today)
        XCTAssertEqual(selected?.strike, 503)
        XCTAssertEqual(selected?.optionType, .call)
        XCTAssertEqual(selected?.expiration, expiration0DTE)
    }

    /// A live `last` overrides the chain-load snapshot price: as the underlying
    /// crosses a strike, the AUTO pick moves with it.
    func testAutoCall_liveLastOverridesSnapshotPrice() {
        let chain = makeChain(price: 502.13)
        let selected = AutoContractSelector.selectAutoOTM(
            chain: chain,
            optionType: .call,
            last: 503.4,
            today: today
        )
        XCTAssertEqual(selected?.strike, 504)
    }

    func testAutoPut_lastBetweenStrikes_picksHighestStrictlyBelow() {
        let chain = makeChain(price: 502.13)
        let selected = AutoContractSelector.selectAutoOTM(chain: chain, optionType: .put, today: today)
        XCTAssertEqual(selected?.strike, 502)
        XCTAssertEqual(selected?.optionType, .put)
    }

    // MARK: - Price exactly on a strike → strictly above/below

    func testAutoCall_priceExactlyOnStrike_picksNextStrikeUp() {
        let chain = makeChain(price: 503.00)
        let selected = AutoContractSelector.selectAutoOTM(chain: chain, optionType: .call, today: today)
        XCTAssertEqual(selected?.strike, 504)
    }

    func testAutoPut_priceExactlyOnStrike_picksNextStrikeDown() {
        let chain = makeChain(price: 503.00)
        let selected = AutoContractSelector.selectAutoOTM(chain: chain, optionType: .put, today: today)
        XCTAssertEqual(selected?.strike, 502)
    }

    // MARK: - Expiration handling

    func testAutoCall_explicitExpiration_filtersToThatExpiration() {
        let chain = makeChain(price: 502.13)
        let selected = AutoContractSelector.selectAutoOTM(
            chain: chain,
            optionType: .call,
            expiration: expirationLater,
            today: today
        )
        XCTAssertEqual(selected?.strike, 510)
        XCTAssertEqual(selected?.expiration, expirationLater)
    }

    // MARK: - Empty / degenerate chains

    func testAutoCall_emptyChain_returnsNil() {
        let chain = OptionsChain(underlying: "SPY", underlyingPrice: 100, expirations: [], contracts: [])
        XCTAssertNil(AutoContractSelector.selectAutoOTM(chain: chain, optionType: .call, today: today))
        XCTAssertNil(AutoContractSelector.selectAutoOTM(chain: chain, optionType: .put, today: today))
    }

    func testAutoCall_noStrikeAboveLast_returnsNil() {
        let chain = makeChain(price: 506.00)
        XCTAssertNil(
            AutoContractSelector.selectAutoOTM(
                chain: chain,
                optionType: .call,
                expiration: expiration0DTE,
                today: today
            )
        )
    }

    func testAutoPut_noStrikeBelowLast_returnsNil() {
        let chain = makeChain(price: 499.50)
        XCTAssertNil(
            AutoContractSelector.selectAutoOTM(
                chain: chain,
                optionType: .put,
                expiration: expiration0DTE,
                today: today
            )
        )
    }

    // MARK: - Nearest expiration

    func testNearestExpiration_picksEarliestOnOrAfterToday() {
        let expirations = ["2026-07-20", "2026-07-17", "2026-07-18"]
        XCTAssertEqual(
            AutoContractSelector.nearestExpiration(expirations, today: today),
            "2026-07-17"
        )
    }

    func testNearestExpiration_todayPassed_picksNextFutureDate() {
        let laterToday = DateParsing.day("2026-07-19") ?? Date(timeIntervalSince1970: 0)
        let expirations = ["2026-07-17", "2026-07-20", "2026-07-18"]
        XCTAssertEqual(
            AutoContractSelector.nearestExpiration(expirations, today: laterToday),
            "2026-07-20"
        )
    }

    func testNearestExpiration_empty_returnsNil() {
        XCTAssertNil(AutoContractSelector.nearestExpiration([], today: today))
    }
}
