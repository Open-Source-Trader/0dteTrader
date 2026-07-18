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

    /// The charted symbol may be a specific contract ("MESU26"); the order's
    /// underlying must be the futures root the server can resolve.
    func testArm_futures_sendsRootAsUnderlying() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        tradeViewModel.assetClass = .future
        tradeViewModel.setFuturesContractsForTesting([
            FuturesContract(
                symbol: "MESU26",
                root: "MES",
                expiration: "2026-09-18",
                frontMonth: true,
                bid: 6010.25,
                ask: 6010.75,
                last: 6010.50
            ),
        ])
        tradeViewModel.selectedFutureSymbol = "MESU26"

        tradeViewModel.arm(side: .buy, underlying: "MESU26", chainViewModel: chainViewModel)

        XCTAssertEqual(tradeViewModel.armedTicket?.request.underlying, "MES")
        XCTAssertEqual(tradeViewModel.armedTicket?.request.selection.contractSymbol, "MESU26")
    }

    func testSetQuantity_clampsToValidRange() {
        let (tradeViewModel, _) = makeViewModels()
        tradeViewModel.setQuantity(0)
        XCTAssertEqual(tradeViewModel.quantity, 1)
        tradeViewModel.setQuantity(5000)
        XCTAssertEqual(tradeViewModel.quantity, 1000)
    }
}
