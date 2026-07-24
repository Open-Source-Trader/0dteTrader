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

    func testArm_bypass_submitsDirectlyWithoutArmingTicket() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        chainViewModel.isAutoMode = true

        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel, bypass: true)

        // Bypass submits directly instead of opening the confirm sheet, so no
        // ticket is armed (the background submit fails harmlessly in tests).
        XCTAssertNil(tradeViewModel.armedTicket)
    }

    func testArm_withoutBypass_armsTicket() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        chainViewModel.isAutoMode = true

        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertNotNil(tradeViewModel.armedTicket)
    }

    func testSetQuantity_clampsToValidRange() {
        let (tradeViewModel, _) = makeViewModels()
        tradeViewModel.setQuantity(0)
        XCTAssertEqual(tradeViewModel.quantity, 1)
        tradeViewModel.setQuantity(5000)
        XCTAssertEqual(tradeViewModel.quantity, 1000)
    }
}
