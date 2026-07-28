import Combine
import XCTest
@testable import ZeroDTETrader

/// `applyContractQuote` updates the chain's stored price for any subscribed
/// symbol, but `TradePanelView`/`OrderPricingRow` hold the chain view model as
/// `@ObservedObject` and only ever display `selectedContract` — so a tick for
/// anything else must not publish, or every held position's quote would
/// re-render the trade panel for a price nobody is showing.
@MainActor
final class OptionsChainQuoteTests: XCTestCase {
    private static let selected = OptionContract(
        symbol: "SPY260727C00505000",
        underlying: "SPY",
        expiration: "2026-07-27",
        strike: 505,
        optionType: .call,
        bid: 1.0,
        ask: 1.02,
        last: 1.01
    )

    private static let other = OptionContract(
        symbol: "SPY260727C00510000",
        underlying: "SPY",
        expiration: "2026-07-27",
        strike: 510,
        optionType: .call,
        bid: 0.5,
        ask: 0.52,
        last: 0.51
    )

    private func makeViewModel() -> OptionsChainViewModel {
        let baseURL = URL(string: "http://localhost:0")!
        let sessionStore = SessionStore(keychainStore: KeychainStore(service: "test.chainquote"), baseURL: baseURL)
        let apiClient = APIClient(baseURL: baseURL, sessionStore: sessionStore)
        let viewModel = OptionsChainViewModel(apiClient: apiClient)
        viewModel.optionType = .call
        viewModel.setChainForTesting(
            OptionsChain(
                underlying: "SPY",
                underlyingPrice: 505,
                expirations: [Self.selected.expiration],
                contracts: [Self.selected, Self.other]
            ),
            expiration: Self.selected.expiration,
            strike: Self.selected.strike
        )
        return viewModel
    }

    private func quote(for contract: OptionContract, bid: Double) -> Quote {
        Quote(
            symbol: contract.symbol,
            bid: bid,
            ask: contract.ask,
            last: contract.last,
            bidSize: 1,
            askSize: 1,
            volume: 0,
            timestamp: Date()
        )
    }

    func testApplyContractQuote_forSelectedContract_publishes() {
        let viewModel = makeViewModel()
        var publishCount = 0
        let cancellable = viewModel.objectWillChange.sink { _ in publishCount += 1 }
        defer { cancellable.cancel() }

        viewModel.applyContractQuote(quote(for: Self.selected, bid: 1.5))

        XCTAssertEqual(publishCount, 1)
        XCTAssertEqual(viewModel.selectedContract?.bid, 1.5)
    }

    func testApplyContractQuote_forOtherContract_updatesDataWithoutPublishing() {
        let viewModel = makeViewModel()
        var publishCount = 0
        let cancellable = viewModel.objectWillChange.sink { _ in publishCount += 1 }
        defer { cancellable.cancel() }

        viewModel.applyContractQuote(quote(for: Self.other, bid: 0.75))

        XCTAssertEqual(publishCount, 0, "a non-displayed contract's tick must not re-render the panel")
        // The data is still current for when the user later selects it.
        XCTAssertEqual(viewModel.chain?.contracts.first { $0.symbol == Self.other.symbol }?.bid, 0.75)
    }
}
