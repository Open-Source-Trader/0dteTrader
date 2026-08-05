// swiftlint:disable line_length static_over_final_class
import XCTest
@testable import ZeroDTETrader

/// Mutations refresh directly because socket connectivity is not delivery
/// proof. The coalescer still keeps overlapping direct/push-driven refreshes
/// to one in-flight run plus at most one follow-up.
@MainActor
final class TradeViewModelRefreshTests: XCTestCase {
    override func tearDown() {
        RefreshCountingURLProtocol.handler = nil
        super.tearDown()
    }

    func testSubmitOrderRefreshesWithoutAssumingSocketDelivery() async {
        var positionsCalls = 0
        var openOrdersCalls = 0
        RefreshCountingURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v1/orders/preview":
                // armedTicket's own loadPreview fires as a fire-and-forget
                // Task alongside confirmArmedOrder; its result is unused here.
                return Self.orderResultResponse
            case "/v1/orders" where request.httpMethod == "POST":
                return Self.orderResultResponse
            case "/v1/positions":
                positionsCalls += 1
                return Self.emptyArrayResponse
            case "/v1/orders":
                openOrdersCalls += 1
                return Self.emptyArrayResponse
            default:
                XCTFail("unexpected request: \(request.url?.path ?? "?")")
                return Self.emptyArrayResponse
            }
        }
        let (tradeViewModel, chainViewModel) = await makeViewModels()
        chainViewModel.isAutoMode = true

        // bypass: false + confirmArmedOrder exercises the same submitOrder
        // path as the bypass flow, but is directly awaitable (bypass fires
        // placement in a detached Task with no handle to await).
        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel, bypass: false)
        await tradeViewModel.confirmArmedOrder()

        XCTAssertEqual(positionsCalls, 1)
        XCTAssertEqual(openOrdersCalls, 1)
    }

    func testSubmitOrderRefreshesWhenNoPushArrives() async {
        var positionsCalls = 0
        var openOrdersCalls = 0
        RefreshCountingURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v1/orders/preview":
                // armedTicket's own loadPreview fires as a fire-and-forget
                // Task alongside confirmArmedOrder; its result is unused here.
                return Self.orderResultResponse
            case "/v1/orders" where request.httpMethod == "POST":
                return Self.orderResultResponse
            case "/v1/positions":
                positionsCalls += 1
                return Self.emptyArrayResponse
            case "/v1/orders":
                openOrdersCalls += 1
                return Self.emptyArrayResponse
            default:
                XCTFail("unexpected request: \(request.url?.path ?? "?")")
                return Self.emptyArrayResponse
            }
        }
        let (tradeViewModel, chainViewModel) = await makeViewModels()
        chainViewModel.isAutoMode = true

        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel, bypass: false)
        await tradeViewModel.confirmArmedOrder()

        XCTAssertEqual(positionsCalls, 1)
        XCTAssertEqual(openOrdersCalls, 1)
    }

    func testConcurrentRefreshesCoalesceIntoOneRunPlusOneQueued() async {
        let requestStarted = expectation(description: "first positions request started")
        let releaseFirstRequest = XCTestExpectation(description: "release first request")
        var positionsCalls = 0
        RefreshCountingURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v1/positions":
                positionsCalls += 1
                if positionsCalls == 1 {
                    requestStarted.fulfill()
                    _ = XCTWaiter.wait(for: [releaseFirstRequest], timeout: 2)
                }
                return Self.emptyArrayResponse
            case "/v1/orders":
                return Self.emptyArrayResponse
            default:
                XCTFail("unexpected request: \(request.url?.path ?? "?")")
                return Self.emptyArrayResponse
            }
        }
        let (tradeViewModel, _) = await makeViewModels()

        // Simulates the submitted + terminal-status WS pushes both landing
        // while the first refresh they triggered is still in flight.
        let first = Task { await tradeViewModel.refreshTradingData() }
        await fulfillment(of: [requestStarted], timeout: 2)
        let second = Task { await tradeViewModel.refreshTradingData() }
        let third = Task { await tradeViewModel.refreshTradingData() }

        releaseFirstRequest.fulfill()
        _ = await (first.value, second.value, third.value)

        // One run for the first call, one more to pick up what the queued
        // callers might have missed — never three.
        XCTAssertEqual(positionsCalls, 2)
    }

    // MARK: - Helpers

    private func makeViewModels() async -> (TradeViewModel, OptionsChainViewModel) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RefreshCountingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let baseURL = URL(string: "https://example.test")!
        let sessionStore = SessionStore(
            keychainStore: KeychainStore(service: "test.trade-refresh.\(UUID().uuidString)"),
            baseURL: baseURL,
            urlSession: session
        )
        try? await sessionStore.signIn(with: AuthTokensDTO(accessToken: "tok", refreshToken: "ref", expiresIn: 3600))
        let apiClient = APIClient(baseURL: baseURL, sessionStore: sessionStore, urlSession: session)
        return (TradeViewModel(apiClient: apiClient), OptionsChainViewModel(apiClient: apiClient))
    }

    private static let orderResultResponse = """
    {"orderId":"o1","status":"submitted","contractSymbol":"SPY260728C00500000","side":"buy","quantity":1,"orderType":"mid","timestamp":"2026-07-28T00:00:00Z"}
    """
    private static let emptyArrayResponse = "[]"
}

private final class RefreshCountingURLProtocol: URLProtocol, @unchecked Sendable {
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
