import XCTest
@testable import ZeroDTETrader

@MainActor
final class TradeViewModelArmTests: XCTestCase {
    private func makeViewModels() -> (TradeViewModel, OptionsChainViewModel) {
        let baseURL = URL(string: "http://localhost:0")!
        let sessionStore = SessionStore(keychainStore: KeychainStore(service: "test.arm"), baseURL: baseURL)
        let apiClient = APIClient(baseURL: baseURL, sessionStore: sessionStore)
        return (TradeViewModel(apiClient: apiClient), OptionsChainViewModel(apiClient: apiClient))
    }

    func testArm_autoOTM_encodesServerSideSelection() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        chainViewModel.isAutoMode = true

        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel)

        let request = tradeViewModel.armedTicket?.request
        XCTAssertEqual(request?.underlying, "SPY")
        XCTAssertEqual(request?.assetClass, "option")
        XCTAssertEqual(request?.selection.mode, "auto_otm")
        XCTAssertEqual(request?.selection.optionType, "call")
        XCTAssertNil(request?.selection.strike)
    }

    // MARK: - Selling into an open position

    private static let contract = OptionContract(
        symbol: "SPY260727C00505000",
        underlying: "SPY",
        expiration: "2026-07-27",
        strike: 505,
        optionType: .call,
        bid: 1.0,
        ask: 1.02,
        last: 1.01
    )

    private func position(_ quantity: Int, symbol: String = contract.symbol) -> Position {
        Position(
            symbol: symbol,
            assetClass: .option,
            quantity: quantity,
            avgPrice: 1,
            markPrice: 1.2,
            unrealizedPnl: 20,
            multiplier: 100,
            underlyingEntryPrice: 505
        )
    }

    /// Arms the chain on the fixed contract so `selectedContract` resolves.
    private func selectContract(_ chainViewModel: OptionsChainViewModel) {
        chainViewModel.optionType = .call
        chainViewModel.setChainForTesting(
            OptionsChain(
                underlying: "SPY",
                underlyingPrice: 505,
                expirations: [Self.contract.expiration],
                contracts: [Self.contract]
            ),
            expiration: Self.contract.expiration,
            strike: Self.contract.strike
        )
    }

    func testArm_sellWithMatchingLong_closesThePositionInstead() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        selectContract(chainViewModel)
        tradeViewModel.setPositionsForTesting([position(3)])
        tradeViewModel.setQuantity(3)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        let ticket = tradeViewModel.armedTicket
        XCTAssertEqual(ticket?.request.quantity, 3)
        XCTAssertEqual(ticket?.request.selection.mode, "explicit")
        XCTAssertEqual(ticket?.request.selection.strike, 505)
        XCTAssertEqual(ticket?.summary.hasPrefix("CLOSE 3"), true)
    }

    /// A larger ticket quantity would flip through zero into a short nobody
    /// asked for, so it is capped at the position size.
    func testArm_sellCapsTicketQuantityAtThePosition() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        selectContract(chainViewModel)
        tradeViewModel.setPositionsForTesting([position(2)])
        tradeViewModel.setQuantity(10)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertEqual(tradeViewModel.armedTicket?.request.quantity, 2)
    }

    /// A smaller ticket quantity is a partial scale-out, and the summary says so.
    func testArm_sellHonorsSmallerTicketQuantityAsPartialClose() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        selectContract(chainViewModel)
        tradeViewModel.setPositionsForTesting([position(10)])
        tradeViewModel.setQuantity(3)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertEqual(tradeViewModel.armedTicket?.request.quantity, 3)
        XCTAssertEqual(tradeViewModel.armedTicket?.summary.contains("CLOSE 3 of 10"), true)
    }

    func testArm_buyIsUnaffected() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        selectContract(chainViewModel)
        tradeViewModel.setPositionsForTesting([position(3)])
        tradeViewModel.setQuantity(1)

        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertEqual(tradeViewModel.armedTicket?.request.quantity, 1)
        XCTAssertEqual(tradeViewModel.armedTicket?.summary.contains("CLOSE"), false)
    }

    func testArm_sellOpensAShortWhenThePositionIsADifferentContract() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        selectContract(chainViewModel)
        tradeViewModel.setPositionsForTesting([position(3, symbol: "SPY260727P00500000")])
        tradeViewModel.setQuantity(1)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertEqual(tradeViewModel.armedTicket?.request.quantity, 1)
        XCTAssertEqual(tradeViewModel.armedTicket?.summary.contains("CLOSE"), false)
    }

    func testArm_sellDoesNotTreatAnExistingShortAsSomethingToClose() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        selectContract(chainViewModel)
        tradeViewModel.setPositionsForTesting([position(-3)])
        tradeViewModel.setQuantity(1)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertEqual(tradeViewModel.armedTicket?.request.quantity, 1)
    }

    func testSetQuantity_clampsToValidRange() {
        let (tradeViewModel, _) = makeViewModels()
        tradeViewModel.setQuantity(0)
        XCTAssertEqual(tradeViewModel.quantity, 1)
        tradeViewModel.setQuantity(5000)
        XCTAssertEqual(tradeViewModel.quantity, 1000)
    }
}
