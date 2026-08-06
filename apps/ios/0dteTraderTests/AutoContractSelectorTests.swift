import XCTest
@testable import ZeroDTETrader

/// Canonical AUTO expectation table (shared with the server's resolveAutoOtm):
/// strikes [100, 101, 102, 103], ATM anchor = nearest strike with equidistant
/// ties resolving toward the OTM side, then walk exactly one strike OTM.
final class AutoContractSelectorTests: XCTestCase {
    private let expiration = "2026-07-17"

    // Fixed "today" so nearest-expiration selection is deterministic.
    private var today: Date {
        DateParsing.day("2026-07-17") ?? Date(timeIntervalSince1970: 0)
    }

    // MARK: - Helpers

    private func contract(_ symbol: String, strike: Double, type: OptionType) -> OptionContract {
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

    /// The canonical ladder: strikes 100...103, both rights.
    private func makeChain() -> OptionsChain {
        var contracts: [OptionContract] = []
        for strike in [100.0, 101.0, 102.0, 103.0] {
            contracts.append(contract("C-\(Int(strike))", strike: strike, type: .call))
            contracts.append(contract("P-\(Int(strike))", strike: strike, type: .put))
        }
        return OptionsChain(
            underlying: "SPY",
            underlyingPrice: 101.5,
            expirations: [expiration],
            contracts: contracts
        )
    }

    private func select(_ type: OptionType, last: Double) -> OptionContract? {
        return AutoContractSelector.selectAutoOTM(
            chain: makeChain(),
            optionType: type,
            last: last,
            today: today
        )
    }

    // MARK: - Default offset (+1 from the ATM anchor)

    func testCall_lastBelowMidpoint_anchorsAtmBelow() {
        XCTAssertEqual(select(.call, last: 100.4)?.strike, 101) // ATM 100
    }

    func testCall_lastAboveMidpoint_anchorsAtmAbove() {
        XCTAssertEqual(select(.call, last: 100.6)?.strike, 102) // ATM 101
    }

    func testPut_lastAboveMidpoint_anchorsAtmAbove() {
        XCTAssertEqual(select(.put, last: 102.6)?.strike, 102) // ATM 103
    }

    func testPut_lastBelowMidpoint_anchorsAtmBelow() {
        XCTAssertEqual(select(.put, last: 102.4)?.strike, 101) // ATM 102
    }

    // MARK: - Exactly on a strike

    func testCall_exactlyOnStrike_walksOneUp() {
        XCTAssertEqual(select(.call, last: 101)?.strike, 102)
    }

    func testPut_exactlyOnStrike_walksOneDown() {
        XCTAssertEqual(select(.put, last: 101)?.strike, 100)
    }

    // MARK: - Equidistant ties resolve toward the OTM side

    func testCall_equidistantTie_anchorsHigher() {
        XCTAssertEqual(select(.call, last: 101.5)?.strike, 103) // ATM 102
    }

    func testPut_equidistantTie_anchorsLower() {
        XCTAssertEqual(select(.put, last: 101.5)?.strike, 100) // ATM 101
    }

    // MARK: - Ladder exhaustion → nil

    func testCall_atmAtTopOfLadder_returnsNil() {
        XCTAssertNil(select(.call, last: 102.99)) // ATM 103, nothing above
    }

    func testPut_atmAtBottomOfLadder_returnsNil() {
        XCTAssertNil(select(.put, last: 100.01)) // ATM 100, nothing below
    }

    func testEmptyChain_returnsNil() {
        let chain = OptionsChain(underlying: "SPY", underlyingPrice: 100, expirations: [], contracts: [])
        XCTAssertNil(AutoContractSelector.selectAutoOTM(chain: chain, optionType: .call, today: today))
        XCTAssertNil(AutoContractSelector.selectAutoOTM(chain: chain, optionType: .put, today: today))
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
