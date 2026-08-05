import XCTest
@testable import ZeroDTETrader

@MainActor
final class TradeViewModelArmTests: XCTestCase {
    private func makeViewModels(autoOtmOffset: Int = 1) -> (TradeViewModel, OptionsChainViewModel) {
        let baseURL = URL(string: "http://localhost:0")!
        let sessionStore = SessionStore(keychainStore: KeychainStore(service: "test.arm"), baseURL: baseURL)
        let apiClient = APIClient(baseURL: baseURL, sessionStore: sessionStore)
        return (
            TradeViewModel(apiClient: apiClient),
            OptionsChainViewModel(apiClient: apiClient, autoOtmOffset: { autoOtmOffset })
        )
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
        // The default offset is omitted so older servers see the old shape.
        XCTAssertNil(request?.selection.otmOffset)
    }

    func testArm_autoCarriesConfiguredOtmOffset() {
        let (tradeViewModel, chainViewModel) = makeViewModels(autoOtmOffset: 2)
        chainViewModel.isAutoMode = true

        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertEqual(tradeViewModel.armedTicket?.request.selection.otmOffset, 2)
        XCTAssertEqual(tradeViewModel.armedTicket?.summary.contains("+2 OTM"), true)
    }

    func testArm_autoOffsetZero_sendsZeroAndSaysATM() {
        let (tradeViewModel, chainViewModel) = makeViewModels(autoOtmOffset: 0)
        chainViewModel.isAutoMode = true

        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertEqual(tradeViewModel.armedTicket?.request.selection.otmOffset, 0)
        XCTAssertEqual(tradeViewModel.armedTicket?.summary.contains("AUTO ATM"), true)
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

    /// Arms the chain on the fixed contract so `selectedContract` resolves,
    /// and wires `optionContractResolver` the way `TradeScreenView` does in
    /// production — the close-detection path resolves held positions through
    /// it rather than trusting `selectedContract`, which can be a different,
    /// AUTO-drifted strike than what is actually held.
    private func selectContract(
        _ tradeViewModel: TradeViewModel,
        _ chainViewModel: OptionsChainViewModel,
        contracts: [OptionContract] = [TradeViewModelArmTests.contract]
    ) {
        chainViewModel.optionType = .call
        chainViewModel.setChainForTesting(
            OptionsChain(
                underlying: "SPY",
                underlyingPrice: 505,
                expirations: [Self.contract.expiration],
                contracts: contracts
            ),
            expiration: Self.contract.expiration,
            strike: Self.contract.strike
        )
        tradeViewModel.optionContractResolver = { symbol in
            contracts.first { $0.symbol == symbol }
        }
    }

    func testArm_sellWithMatchingLong_closesThePositionInstead() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        selectContract(tradeViewModel, chainViewModel)
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
        selectContract(tradeViewModel, chainViewModel)
        tradeViewModel.setPositionsForTesting([position(2)])
        tradeViewModel.setQuantity(10)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertEqual(tradeViewModel.armedTicket?.request.quantity, 2)
    }

    /// A smaller ticket quantity is a partial scale-out, and the summary says so.
    func testArm_sellHonorsSmallerTicketQuantityAsPartialClose() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        selectContract(tradeViewModel, chainViewModel)
        tradeViewModel.setPositionsForTesting([position(10)])
        tradeViewModel.setQuantity(3)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertEqual(tradeViewModel.armedTicket?.request.quantity, 3)
        XCTAssertEqual(tradeViewModel.armedTicket?.summary.contains("CLOSE 3 of 10"), true)
    }

    func testArm_buyIsUnaffected() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        selectContract(tradeViewModel, chainViewModel)
        tradeViewModel.setPositionsForTesting([position(3)])
        tradeViewModel.setQuantity(1)

        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertEqual(tradeViewModel.armedTicket?.request.quantity, 1)
        XCTAssertEqual(tradeViewModel.armedTicket?.summary.contains("CLOSE"), false)
    }

    /// SELL is only ever a close in this app: with no matching long to close,
    /// the arm refuses rather than opening a short nobody asked for.
    func testArm_sellWithOnlyANonMatchingPosition_refusesInsteadOfShorting() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        selectContract(tradeViewModel, chainViewModel)
        tradeViewModel.setPositionsForTesting([position(3, symbol: "SPY260727P00500000")])
        tradeViewModel.setQuantity(1)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertNil(tradeViewModel.armedTicket)
        XCTAssertEqual(tradeViewModel.toast?.message, "No open position to sell")
    }

    func testArm_sellWithNothingHeld_toastsAndArmsNothing() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        selectContract(tradeViewModel, chainViewModel)
        tradeViewModel.setQuantity(1)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertNil(tradeViewModel.armedTicket)
        XCTAssertEqual(tradeViewModel.toast?.message, "No open position to sell")
    }

    /// Reproduces the reported incident: AUTO mode's live strike has drifted
    /// off the strike actually held (e.g. after a sharp move in the
    /// underlying), so the two contracts no longer share a symbol. Matching
    /// on underlying + expiration + right (ignoring strike) still finds the
    /// held put and closes it at ITS strike — not the drifted one the panel
    /// currently displays — instead of silently opening a new naked short.
    func testArm_sellClosesHeldPositionEvenWhenAutoStrikeHasDrifted() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        let heldPut = OptionContract(
            symbol: "SPY260727P00500000",
            underlying: "SPY",
            expiration: Self.contract.expiration,
            strike: 500,
            optionType: .put,
            bid: 1.0,
            ask: 1.02,
            last: 1.01
        )
        let driftedPut = OptionContract(
            symbol: "SPY260727P00490000",
            underlying: "SPY",
            expiration: Self.contract.expiration,
            strike: 490,
            optionType: .put,
            bid: 0.5,
            ask: 0.52,
            last: 0.51
        )
        selectContract(tradeViewModel, chainViewModel, contracts: [heldPut, driftedPut])
        chainViewModel.optionType = .put
        chainViewModel.isAutoMode = true
        chainViewModel.underlyingLast = 495 // puts AUTO's OTM pick at 490, not the held 500 strike
        tradeViewModel.setPositionsForTesting([position(2, symbol: heldPut.symbol)])
        tradeViewModel.setQuantity(2)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        let ticket = tradeViewModel.armedTicket
        XCTAssertEqual(ticket?.request.selection.strike, 500, "must close the HELD strike, not AUTO's drifted pick")
        XCTAssertEqual(ticket?.request.quantity, 2)
        XCTAssertEqual(ticket?.summary.hasPrefix("CLOSE 2"), true)
    }

    /// Two held legs at different strikes, same underlying/expiration/right
    /// (e.g. a put spread): the higher-P/L leg closes first, and the summary
    /// says "of <total>" so the user sees the other leg is still open.
    func testArm_sellWithMultipleMatchingLegs_closesHighestPnlLegFirst() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        let legA = OptionContract(
            symbol: "SPY260727P00500000",
            underlying: "SPY",
            expiration: Self.contract.expiration,
            strike: 500,
            optionType: .put,
            bid: 1.0,
            ask: 1.02,
            last: 1.01
        )
        let legB = OptionContract(
            symbol: "SPY260727P00495000",
            underlying: "SPY",
            expiration: Self.contract.expiration,
            strike: 495,
            optionType: .put,
            bid: 0.5,
            ask: 0.52,
            last: 0.51
        )
        selectContract(tradeViewModel, chainViewModel, contracts: [legA, legB])
        chainViewModel.optionType = .put
        chainViewModel.isAutoMode = false
        chainViewModel.selectedStrike = 500
        var lowPnlLeg = position(2, symbol: legA.symbol)
        lowPnlLeg.unrealizedPnl = 5
        var highPnlLeg = position(3, symbol: legB.symbol)
        highPnlLeg.unrealizedPnl = 50
        tradeViewModel.setPositionsForTesting([lowPnlLeg, highPnlLeg])
        tradeViewModel.setQuantity(10)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        let ticket = tradeViewModel.armedTicket
        XCTAssertEqual(ticket?.request.selection.strike, 495, "closes the higher-P/L leg first")
        XCTAssertEqual(ticket?.request.quantity, 3)
        XCTAssertEqual(ticket?.summary.hasPrefix("CLOSE 3 of 5"), true)
    }

    func testArm_sellDoesNotTreatAnExistingShortAsSomethingToClose() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        selectContract(tradeViewModel, chainViewModel)
        tradeViewModel.setPositionsForTesting([position(-3)])
        tradeViewModel.setQuantity(1)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        // A short is not something a SELL closes — and selling would only
        // deepen it, so the arm refuses outright.
        XCTAssertNil(tradeViewModel.armedTicket)
        XCTAssertEqual(tradeViewModel.toast?.message, "No open position to sell")
    }

    // MARK: - CURR mode

    /// Seeds the chain + positions and switches CURR on, wired the way
    /// `TradeScreenView` does it (`positionsProvider` → live positions).
    private func enableCurr(
        _ tradeViewModel: TradeViewModel,
        _ chainViewModel: OptionsChainViewModel,
        contracts: [OptionContract] = [TradeViewModelArmTests.contract],
        positions: [Position]
    ) {
        selectContract(tradeViewModel, chainViewModel, contracts: contracts)
        tradeViewModel.setPositionsForTesting(positions)
        chainViewModel.positionsProvider = { tradeViewModel.positions }
        chainViewModel.isCurrMode = true
    }

    func testArm_currBuy_armsExplicitAddForHeldContract() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        enableCurr(tradeViewModel, chainViewModel, positions: [position(2)])
        tradeViewModel.setQuantity(1)

        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel)

        let request = tradeViewModel.armedTicket?.request
        XCTAssertEqual(request?.selection.mode, "explicit")
        XCTAssertEqual(request?.selection.strike, 505)
        XCTAssertEqual(request?.quantity, 1)
        XCTAssertEqual(tradeViewModel.armedTicket?.summary.contains("CLOSE"), false)
    }

    func testArm_currSell_clampsToHeldQuantity() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        enableCurr(tradeViewModel, chainViewModel, positions: [position(2)])
        tradeViewModel.setQuantity(10)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        let ticket = tradeViewModel.armedTicket
        XCTAssertEqual(ticket?.request.quantity, 2)
        XCTAssertEqual(ticket?.request.selection.mode, "explicit")
        XCTAssertEqual(ticket?.summary.hasPrefix("CLOSE 2"), true)
    }

    func testArm_currSell_partialCloseSaysOfTotal() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        enableCurr(tradeViewModel, chainViewModel, positions: [position(10)])
        tradeViewModel.setQuantity(3)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertEqual(tradeViewModel.armedTicket?.request.quantity, 3)
        XCTAssertEqual(tradeViewModel.armedTicket?.summary.contains("CLOSE 3 of 10"), true)
    }

    /// A holding resolved from its OCC symbol carries zero quotes until its
    /// expiration's contracts load — the ticket must refuse to arm off a
    /// 0.00 display rather than trade blind.
    func testArm_currRefusesWhileQuotesStillLoading() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        selectContract(tradeViewModel, chainViewModel)
        let occ = "SPY990122C00510000" // not on the seeded chain
        tradeViewModel.setPositionsForTesting([position(2, symbol: occ)])
        chainViewModel.positionsProvider = { tradeViewModel.positions }
        chainViewModel.isCurrMode = true
        tradeViewModel.setQuantity(1)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertNil(tradeViewModel.armedTicket)
        XCTAssertEqual(tradeViewModel.toast?.message, "Quotes are unavailable for this contract.")
    }

    // MARK: - Quote-readiness backstop (behind the UI gates)

    /// A contract with both sides dead — the synthesized CURR placeholder —
    /// is refused before any ticket, preview, or request exists, for BUY and
    /// SELL alike, whatever pricing mode is selected.
    func testArm_zeroQuoteContract_refusedForBothSides() {
        let dead = OptionContract(
            symbol: Self.contract.symbol,
            underlying: "SPY",
            expiration: Self.contract.expiration,
            strike: Self.contract.strike,
            optionType: .call,
            bid: 0,
            ask: 0,
            last: 1.01 // a stale print is not a market
        )
        for side in [OrderSide.buy, OrderSide.sell] {
            let (tradeViewModel, chainViewModel) = makeViewModels()
            selectContract(tradeViewModel, chainViewModel, contracts: [dead])
            tradeViewModel.setPositionsForTesting([position(2)])
            tradeViewModel.orderType = .market

            tradeViewModel.arm(side: side, underlying: "SPY", chainViewModel: chainViewModel)

            XCTAssertNil(tradeViewModel.armedTicket, "\(side) armed a quoteless contract")
            XCTAssertEqual(tradeViewModel.toast?.message, "Quotes are unavailable for this contract.")
        }
    }

    /// Typing a custom price does not turn an unresolved placeholder into a
    /// tradeable contract — the refusal fires before the custom-price path.
    func testArm_zeroQuoteContract_customPriceDoesNotBypassTheRefusal() {
        let dead = OptionContract(
            symbol: Self.contract.symbol,
            underlying: "SPY",
            expiration: Self.contract.expiration,
            strike: Self.contract.strike,
            optionType: .call,
            bid: 0,
            ask: 0,
            last: 0
        )
        let (tradeViewModel, chainViewModel) = makeViewModels()
        selectContract(tradeViewModel, chainViewModel, contracts: [dead])
        tradeViewModel.orderType = .custom
        tradeViewModel.setCustomLimitPrice(1.25)

        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertNil(tradeViewModel.armedTicket)
        XCTAssertEqual(tradeViewModel.toast?.message, "Quotes are unavailable for this contract.")
    }

    /// Flipped from the old one-sided rule: every order type is priced from
    /// the live book (mid/bid/ask all need both sides), so a lone ask must
    /// refuse to arm exactly like the all-zero placeholder.
    func testArm_oneSidedQuote_isRefused() {
        let askOnly = OptionContract(
            symbol: Self.contract.symbol,
            underlying: "SPY",
            expiration: Self.contract.expiration,
            strike: Self.contract.strike,
            optionType: .call,
            bid: 0,
            ask: 1.05,
            last: 0
        )
        let (tradeViewModel, chainViewModel) = makeViewModels()
        selectContract(tradeViewModel, chainViewModel, contracts: [askOnly])
        tradeViewModel.orderType = .market

        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertNil(tradeViewModel.armedTicket)
        XCTAssertEqual(tradeViewModel.toast?.message, "Quotes are unavailable for this contract.")
    }

    /// Leg-matching would close the highest-P/L leg; CURR must instead sell
    /// exactly the contract the panel has selected.
    func testArm_currSell_bypassesLegMatching() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        let secondCall = OptionContract(
            symbol: "SPY260727C00495000",
            underlying: "SPY",
            expiration: Self.contract.expiration,
            strike: 495,
            optionType: .call,
            bid: 2.0,
            ask: 2.02,
            last: 2.01
        )
        var highPnlLeg = position(3, symbol: secondCall.symbol)
        highPnlLeg.unrealizedPnl = 50
        // CURR preselects the first holding (no openedAt on either) — the
        // 505, whose P/L is lower than the 495's.
        enableCurr(
            tradeViewModel,
            chainViewModel,
            contracts: [Self.contract, secondCall],
            positions: [position(2), highPnlLeg]
        )
        tradeViewModel.setQuantity(2)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertEqual(tradeViewModel.armedTicket?.request.selection.strike, 505)
        XCTAssertEqual(tradeViewModel.armedTicket?.request.quantity, 2)
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

    /// The held-leg close path (a sell matching a held right + expiration
    /// outside CURR mode) used to build its own ticket and return before the
    /// bypass branch, so "Skip order confirmation" was silently ignored on
    /// exactly the path where a fast exit matters most. It must submit
    /// directly like every other branch: no ticket, no preview, one direct
    /// placeOrder.
    func testArm_heldLegCloseWithBypass_submitsDirectlyWithoutArmingTicket() async {
        var placeOrderRequests: [URLRequest] = []
        var previewCalls = 0
        let placed = expectation(description: "placeOrder submitted")
        BypassRecordingURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v1/orders" where request.httpMethod == "POST":
                placeOrderRequests.append(request)
                placed.fulfill()
                return Self.orderResultResponse
            case "/v1/orders/preview":
                previewCalls += 1
                return Self.orderResultResponse
            default:
                // submitOrder's fallback refresh (no socket in tests) lands
                // on GET /v1/positions and /v1/orders after the placement.
                return "[]"
            }
        }
        defer { BypassRecordingURLProtocol.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BypassRecordingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let baseURL = URL(string: "https://example.test")!
        let sessionStore = SessionStore(
            keychainStore: KeychainStore(service: "test.arm.bypass.\(UUID().uuidString)"),
            baseURL: baseURL,
            urlSession: session
        )
        let apiClient = APIClient(baseURL: baseURL, sessionStore: sessionStore, urlSession: session)
        let tradeViewModel = TradeViewModel(apiClient: apiClient)
        let chainViewModel = OptionsChainViewModel(apiClient: apiClient)
        // A held call matching the panel's selected right + expiration — the
        // held-leg matching path (CURR mode stays off).
        selectContract(tradeViewModel, chainViewModel)
        tradeViewModel.setPositionsForTesting([position(2)])
        tradeViewModel.setQuantity(2)

        tradeViewModel.arm(side: .sell, underlying: "SPY", chainViewModel: chainViewModel, bypass: true)

        // Bypass must not open the confirm flow…
        XCTAssertNil(tradeViewModel.armedTicket)
        XCTAssertNil(tradeViewModel.preview)

        // …and the detached submission must reach the broker directly.
        await fulfillment(of: [placed], timeout: 2)
        XCTAssertEqual(placeOrderRequests.count, 1)
        XCTAssertNotNil(placeOrderRequests.first?.value(forHTTPHeaderField: "Idempotency-Key"))
        XCTAssertEqual(previewCalls, 0)
        XCTAssertNil(tradeViewModel.preview)
    }

    private static let orderResultResponse = """
    {"orderId":"o1","status":"submitted","contractSymbol":"SPY260727C00505000",
     "side":"sell","quantity":2,"orderType":"mid","timestamp":"2026-07-27T00:00:00Z"}
    """

    func testSetQuantity_clampsToValidRange() {
        let (tradeViewModel, _) = makeViewModels()
        tradeViewModel.setQuantity(0)
        XCTAssertEqual(tradeViewModel.quantity, 1)
        tradeViewModel.setQuantity(5000)
        XCTAssertEqual(tradeViewModel.quantity, 1000)
    }
}

/// Serves canned responses and records the order placement the bypass path
/// fires from its detached task; the expectation its handler fulfills is what
/// deadline-bounds the wait on that task. Mirrors the refresh tests' protocol.
// swiftlint:disable static_over_final_class
private final class BypassRecordingURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = (URLRequest) -> String
    nonisolated(unsafe) static var handler: Handler?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let client, let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let body = handler(request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client.urlProtocol(self, didLoad: Data(body.utf8))
        client.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
// swiftlint:enable static_over_final_class
