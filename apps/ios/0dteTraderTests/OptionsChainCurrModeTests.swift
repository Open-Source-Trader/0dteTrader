import XCTest
@testable import ZeroDTETrader

/// CURR mode on the chain view model: menu filtering to held contracts,
/// most-recent preselection, and mutual exclusion with AUTO.
@MainActor
final class OptionsChainCurrModeTests: XCTestCase {
    private let expirationNear = "2026-07-17"
    private let expirationFar = "2026-07-24"

    private func makeViewModel() -> OptionsChainViewModel {
        let baseURL = URL(string: "http://localhost:0")!
        let sessionStore = SessionStore(keychainStore: KeychainStore(service: "test.curr"), baseURL: baseURL)
        let apiClient = APIClient(baseURL: baseURL, sessionStore: sessionStore)
        return OptionsChainViewModel(apiClient: apiClient)
    }

    private func contract(_ symbol: String, expiration: String, strike: Double, type: OptionType) -> OptionContract {
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

    private func position(_ symbol: String, quantity: Int = 1, openedAt: Date? = nil) -> Position {
        Position(
            symbol: symbol,
            assetClass: .option,
            quantity: quantity,
            avgPrice: 1,
            markPrice: 1.1,
            unrealizedPnl: 10,
            multiplier: 100,
            underlyingEntryPrice: nil,
            openedAt: openedAt
        )
    }

    private var callNear500: OptionContract { contract("SPY-C-500", expiration: expirationNear, strike: 500, type: .call) }
    private var callNear505: OptionContract { contract("SPY-C-505", expiration: expirationNear, strike: 505, type: .call) }
    private var putNear500: OptionContract { contract("SPY-P-500", expiration: expirationNear, strike: 500, type: .put) }
    private var callFar510: OptionContract { contract("SPY-C-510", expiration: expirationFar, strike: 510, type: .call) }

    /// Seeds the full chain; selection starts on the near 500 call.
    private func seedChain(_ viewModel: OptionsChainViewModel) {
        let chain = OptionsChain(
            underlying: "SPY",
            underlyingPrice: 502,
            expirations: [expirationNear, expirationFar],
            contracts: [callNear500, callNear505, putNear500, callFar510]
        )
        viewModel.setChainForTesting(chain, expiration: expirationNear, strike: 500)
    }

    // MARK: - Held-contract filtering

    func testHasHeldContracts_falseWithoutPositions() {
        let viewModel = makeViewModel()
        seedChain(viewModel)
        XCTAssertFalse(viewModel.hasHeldContracts)
    }

    func testHeldContracts_excludeShortsAndUnresolvedSymbols() {
        let viewModel = makeViewModel()
        seedChain(viewModel)
        viewModel.positionsProvider = { [
            self.position(self.callNear505.symbol, quantity: -1), // short
            self.position("SPY-UNKNOWN"), // not on the chain
        ] }
        XCTAssertFalse(viewModel.hasHeldContracts)
    }

    func testCurrFiltersExpirationsAndStrikesToHoldings() {
        let viewModel = makeViewModel()
        seedChain(viewModel)
        viewModel.positionsProvider = { [
            self.position(self.callNear505.symbol),
            self.position(self.callFar510.symbol),
        ] }

        viewModel.isCurrMode = true

        XCTAssertEqual(viewModel.expirations, [expirationNear, expirationFar])
        // Preselection landed on the first holding (no openedAt): near 505.
        XCTAssertEqual(viewModel.selectedExpiration, expirationNear)
        XCTAssertEqual(viewModel.strikes, [505])
        XCTAssertEqual(viewModel.selectedContract?.symbol, callNear505.symbol)
    }

    // MARK: - Preselection

    func testCurrPreselectsMostRecentlyOpenedHolding() {
        let viewModel = makeViewModel()
        seedChain(viewModel)
        let earlier = DateParsing.dateTime("2026-07-16T14:30:00Z")
        let later = DateParsing.dateTime("2026-07-17T15:45:00Z")
        XCTAssertNotNil(earlier)
        XCTAssertNotNil(later)
        viewModel.positionsProvider = { [
            self.position(self.callNear505.symbol, openedAt: earlier),
            self.position(self.callFar510.symbol, openedAt: later),
        ] }

        viewModel.isCurrMode = true

        XCTAssertEqual(viewModel.selectedContract?.symbol, callFar510.symbol)
        XCTAssertEqual(viewModel.selectedExpiration, expirationFar)
        XCTAssertEqual(viewModel.selectedStrike, 510)
        XCTAssertEqual(viewModel.optionType, .call)
    }

    /// The CALL/PUT toggle is the user's: enabling CURR with CALL selected
    /// stays on calls when one is held, even when a put was listed first.
    func testCurrPreselectPrefersTheToggledSide() {
        let viewModel = makeViewModel()
        seedChain(viewModel)
        viewModel.positionsProvider = { [
            self.position(self.putNear500.symbol),
            self.position(self.callFar510.symbol),
        ] }
        XCTAssertEqual(viewModel.optionType, .call)

        viewModel.isCurrMode = true

        XCTAssertEqual(viewModel.selectedContract?.symbol, callFar510.symbol)
        XCTAssertEqual(viewModel.optionType, .call)
    }

    /// Only a side with nothing held flips the toggle on enable.
    func testCurrEnableFlipsSideOnlyWhenToggledSideHoldsNothing() {
        let viewModel = makeViewModel()
        seedChain(viewModel)
        viewModel.positionsProvider = { [self.position(self.putNear500.symbol)] }
        XCTAssertEqual(viewModel.optionType, .call)

        viewModel.isCurrMode = true

        XCTAssertEqual(viewModel.optionType, .put)
        XCTAssertEqual(viewModel.selectedContract?.symbol, putNear500.symbol)
    }

    // MARK: - CALL/PUT toggle inside CURR

    func testTogglingSideInCurrRepreselectsThatSidesHolding() {
        let viewModel = makeViewModel()
        seedChain(viewModel)
        viewModel.positionsProvider = { [
            self.position(self.callNear505.symbol),
            self.position(self.putNear500.symbol),
        ] }
        viewModel.isCurrMode = true
        XCTAssertEqual(viewModel.selectedContract?.symbol, callNear505.symbol)

        viewModel.optionType = .put

        XCTAssertEqual(viewModel.expirations, [expirationNear])
        XCTAssertEqual(viewModel.strikes, [500])
        XCTAssertEqual(viewModel.selectedContract?.symbol, putNear500.symbol)

        viewModel.optionType = .call

        XCTAssertEqual(viewModel.selectedContract?.symbol, callNear505.symbol)
    }

    func testTogglingToAnUnheldSideClearsTheSelection() {
        let viewModel = makeViewModel()
        seedChain(viewModel)
        viewModel.positionsProvider = { [self.position(self.callNear505.symbol)] }
        viewModel.isCurrMode = true

        viewModel.optionType = .put

        XCTAssertTrue(viewModel.expirations.isEmpty)
        XCTAssertTrue(viewModel.strikes.isEmpty)
        XCTAssertNil(viewModel.selectedContract)
    }

    // MARK: - Expiration change inside CURR

    func testSelectExpirationInCurr_landsOnHeldStrike() {
        let viewModel = makeViewModel()
        seedChain(viewModel)
        viewModel.positionsProvider = { [
            self.position(self.callNear505.symbol),
            self.position(self.callFar510.symbol),
        ] }
        viewModel.isCurrMode = true

        viewModel.selectExpiration(expirationFar)

        XCTAssertEqual(viewModel.selectedStrike, 510)
        XCTAssertEqual(viewModel.selectedContract?.symbol, callFar510.symbol)
    }

    // MARK: - Mutual exclusion

    func testCurrAndAutoAreMutuallyExclusive() {
        let viewModel = makeViewModel()
        seedChain(viewModel)
        viewModel.positionsProvider = { [self.position(self.callNear505.symbol)] }

        viewModel.isAutoMode = true
        viewModel.isCurrMode = true
        XCTAssertFalse(viewModel.isAutoMode)

        viewModel.isAutoMode = true
        XCTAssertFalse(viewModel.isCurrMode)
        XCTAssertTrue(viewModel.isAutoMode)
    }
}
