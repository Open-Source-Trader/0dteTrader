// swiftlint:disable line_length static_over_final_class
import XCTest
@testable import ZeroDTETrader

final class OptionsAnalyticsAPITests: XCTestCase {
    override func tearDown() {
        AnalyticsURLProtocol.handler = nil
        super.tearDown()
    }

    func testOptionsAnalyticsUsesNewEndpointAndExactExpirationQuery() async throws {
        let expectation = expectation(description: "request received")
        AnalyticsURLProtocol.handler = { request, protocolClient, urlProtocol in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/v1/market/options-analytics")
            guard let url = request.url else {
                XCTFail("Request URL missing")
                return
            }
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value) })
            XCTAssertEqual(Set(query.keys), Set(["symbol", "expiration"]))
            XCTAssertEqual(query["symbol"]!, "SPY")
            XCTAssertEqual(query["expiration"]!, "2026-07-19")
            expectation.fulfill()
            AnalyticsURLProtocol.finish(data: Data(Self.snapshotJSON.utf8), client: protocolClient, urlProtocol: urlProtocol)
        }

        let snapshot = try await makeClient().optionsAnalytics(symbol: "SPY", expiration: "2026-07-19")

        await fulfillment(of: [expectation], timeout: 1)
        XCTAssertEqual(snapshot.scope.expiration, "2026-07-19")
    }

    func testOptionsAnalyticsRequiresExpirationAtTypeBoundary() {
        let client = makeClient()
        let methodType = String(reflecting: type(of: client.optionsAnalytics(symbol:expiration:)))
        let exactRequest: (String, String) async throws -> OptionsAnalyticsSnapshotDTO =
            client.optionsAnalytics(symbol:expiration:)

        _ = exactRequest
        XCTAssertFalse(methodType.contains("Optional<Swift.String>"), methodType)
    }

    func testOptionsAnalyticsPreservesCancellationError() async {
        let started = expectation(description: "request started")
        AnalyticsURLProtocol.handler = { _, _, _ in started.fulfill() }
        let client = makeClient()
        let task = Task {
            try await client.optionsAnalytics(symbol: "SPY", expiration: "2026-07-19")
        }

        await fulfillment(of: [started], timeout: 1)
        task.cancel()

        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch is CancellationError {
            // Required: callers must be able to distinguish cancellation from an API failure.
        } catch {
            XCTFail("Expected CancellationError, got \(error)")
        }
    }

    private func makeClient() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AnalyticsURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let baseURL = URL(string: "https://example.test")!
        let sessionStore = SessionStore(
            keychainStore: KeychainStore(service: "test.options-analytics-api.\(UUID().uuidString)"),
            baseURL: baseURL,
            urlSession: session
        )
        return APIClient(baseURL: baseURL, sessionStore: sessionStore, urlSession: session)
    }

    private static let snapshotJSON = """
    {"scope":{"symbol":"SPY","rootSymbol":"SPY","expiration":"2026-07-19","settlementStyle":"pm","observedAt":"2026-07-19T14:30:05Z","settlementAt":"2026-07-19T20:00:00Z","spot":584,"forward":584.2},"exposureUnit":"$ delta change per 1% underlying move","quality":{"quoteAsOf":null,"greeksAsOf":null,"oiEffectiveDate":null,"feedMode":"unknown","coverage":{"contractsTotal":0,"contractsIncluded":0,"ratio":0},"status":"partial","warnings":["no valid contracts"],"calculationVersion":"options-analytics-v1","cacheStatus":"fresh"},"structure":{"callGammaExposure":0,"putGammaExposure":0,"grossGammaExposure":0,"callDeltaNotional":0,"putDeltaNotional":0,"callWall":null,"putWall":null,"grossGammaConcentration":null,"maxOpenInterestStrike":null},"scenarios":{"callPutDealerProxy":null},"impliedRange":null,"strikes":[]}
    """
}

private final class AnalyticsURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = (URLRequest, URLProtocolClient, URLProtocol) -> Void
    nonisolated(unsafe) static var handler: Handler?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let client, let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        handler(request, client, self)
    }

    override func stopLoading() {}

    static func finish(data: Data, client: URLProtocolClient, urlProtocol: URLProtocol) {
        let response = HTTPURLResponse(
            url: urlProtocol.request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client.urlProtocol(urlProtocol, didReceive: response, cacheStoragePolicy: .notAllowed)
        client.urlProtocol(urlProtocol, didLoad: data)
        client.urlProtocolDidFinishLoading(urlProtocol)
    }
}
