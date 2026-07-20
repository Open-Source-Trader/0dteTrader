// swiftlint:disable line_length
import XCTest
@testable import ZeroDTETrader

@MainActor
final class OptionsAnalyticsPollingTests: XCTestCase {
    func testPollingWaitsForSelectedExactExpiration() async throws {
        let calls = AnalyticsCallCounter()
        let viewModel = makeViewModel { symbol, expiration in
            await calls.record(symbol: symbol, expiration: expiration)
            return try Self.snapshot(symbol: symbol, expiration: expiration)
        }

        viewModel.setOptionsAnalyticsVisible(true)
        viewModel.setOptionsAnalyticsAppActive(true)
        try await Task.sleep(for: .milliseconds(30))
        let countWithoutExpiration = await calls.count
        XCTAssertEqual(countWithoutExpiration, 0)

        viewModel.optionsAnalyticsExpiration = "2026-07-19"
        try await eventually { await calls.count == 1 }
        let requests = await calls.requests
        XCTAssertEqual(requests.last?.expiration, "2026-07-19")
    }

    func testSymbolSwitchPausesUntilNewExactExpirationArrives() async throws {
        let calls = AnalyticsCallCounter()
        let viewModel = makeViewModel { symbol, expiration in
            await calls.record(symbol: symbol, expiration: expiration)
            return try Self.snapshot(symbol: symbol, expiration: expiration)
        }
        viewModel.optionsAnalyticsExpiration = "2026-07-19"
        viewModel.setOptionsAnalyticsVisible(true)
        viewModel.setOptionsAnalyticsAppActive(true)
        try await eventually { await calls.count == 1 }

        viewModel.selectSymbol("QQQ")
        try await Task.sleep(for: .milliseconds(40))

        XCTAssertNil(viewModel.optionsAnalyticsExpiration)
        let pausedRequests = await calls.requests
        XCTAssertEqual(pausedRequests.map(\.symbol), ["SPY"])
        XCTAssertEqual(pausedRequests.map(\.expiration), ["2026-07-19"])

        viewModel.optionsAnalyticsExpiration = "2026-07-20"
        try await eventually { await calls.count == 2 }
        let resumedRequests = await calls.requests
        XCTAssertEqual(resumedRequests.last?.symbol, "QQQ")
        XCTAssertEqual(resumedRequests.last?.expiration, "2026-07-20")
    }

    func testDisabledOverlayStillShadowFetchesExactSelection() async throws {
        let calls = AnalyticsCallCounter()
        let viewModel = makeViewModel(enabled: false) { symbol, expiration in
            await calls.record(symbol: symbol, expiration: expiration)
            return try Self.snapshot(symbol: symbol, expiration: expiration)
        }
        viewModel.optionsAnalyticsExpiration = "2026-07-19"

        viewModel.setOptionsAnalyticsVisible(true)
        viewModel.setOptionsAnalyticsAppActive(true)

        try await eventually { await calls.count == 1 }
        XCTAssertFalse(viewModel.optionsAnalyticsSettings.enabled)
    }

    func testPollingRequiresVisibleAndActive() async throws {
        let calls = AnalyticsCallCounter()
        let viewModel = makeViewModel { symbol, expiration in
            await calls.record(symbol: symbol, expiration: expiration)
            return try Self.snapshot(symbol: symbol, expiration: expiration)
        }
        viewModel.optionsAnalyticsExpiration = "2026-07-19"

        viewModel.setOptionsAnalyticsVisible(true)
        try await Task.sleep(for: .milliseconds(30))
        let countWhileInactive = await calls.count
        XCTAssertEqual(countWhileInactive, 0)

        viewModel.setOptionsAnalyticsAppActive(true)
        try await eventually { await calls.count == 1 }

        viewModel.setOptionsAnalyticsVisible(false)
        try await Task.sleep(for: .milliseconds(30))
        let countAfterDisappear = await calls.count
        XCTAssertEqual(countAfterDisappear, 1)
    }

    func testLateResponseFromOldExpirationCannotOverwriteCurrentSnapshot() async throws {
        let loader = DeferredAnalyticsLoader()
        let viewModel = makeViewModel { symbol, expiration in
            try await loader.load(symbol: symbol, expiration: expiration)
        }
        viewModel.optionsAnalyticsExpiration = "2026-07-19"
        viewModel.setOptionsAnalyticsVisible(true)
        viewModel.setOptionsAnalyticsAppActive(true)
        try await loader.waitForRequest(expiration: "2026-07-19")

        viewModel.optionsAnalyticsExpiration = "2026-07-20"
        try await loader.waitForRequest(expiration: "2026-07-20")
        await loader.resume(expiration: "2026-07-19", with: try Self.snapshot(symbol: "SPY", expiration: "2026-07-19"))
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertNil(viewModel.optionsAnalyticsSnapshot)
        XCTAssertNil(viewModel.optionsAnalyticsErrorMessage)

        await loader.resume(expiration: "2026-07-20", with: try Self.snapshot(symbol: "SPY", expiration: "2026-07-20"))
        try await eventually { viewModel.optionsAnalyticsSnapshot?.scope.expiration == "2026-07-20" }
        XCTAssertEqual(viewModel.optionsAnalyticsDisplayState, .live)
    }

    func testCancellationNeverSurfacesAsAnalyticsError() async throws {
        let started = AnalyticsCallCounter()
        let viewModel = makeViewModel { symbol, expiration in
            await started.record(symbol: symbol, expiration: expiration)
            try await Task.sleep(for: .seconds(60))
            return try Self.snapshot(symbol: symbol, expiration: expiration)
        }
        viewModel.optionsAnalyticsExpiration = "2026-07-19"
        viewModel.setOptionsAnalyticsVisible(true)
        viewModel.setOptionsAnalyticsAppActive(true)
        try await eventually { await started.count == 1 }

        viewModel.setOptionsAnalyticsAppActive(false)
        try await Task.sleep(for: .milliseconds(30))

        XCTAssertNil(viewModel.optionsAnalyticsErrorMessage)
        XCTAssertNil(viewModel.optionsAnalyticsSnapshot)
        XCTAssertEqual(viewModel.optionsAnalyticsDisplayState, .empty)
    }

    func testInitialFailureIsUnavailableRatherThanExpired() async throws {
        let viewModel = makeViewModel { _, _ in
            throw APIError.network(underlying: "offline")
        }
        viewModel.optionsAnalyticsExpiration = "2026-07-19"
        viewModel.setOptionsAnalyticsVisible(true)
        viewModel.setOptionsAnalyticsAppActive(true)

        try await eventually { viewModel.optionsAnalyticsErrorMessage != nil }

        XCTAssertEqual(String(describing: viewModel.optionsAnalyticsDisplayState), "unavailable")
    }

    func testRetentionAgeEvictionIsUnavailableBeforeSettlement() async throws {
        let snapshot = try Self.snapshot(symbol: "SPY", expiration: "2026-07-19")
        let loader = SequencedAnalyticsLoader(snapshot: snapshot)
        let now = DateParsing.dateTime("2026-07-19T14:32:00Z")!
        let viewModel = makeViewModel(
            loader: { _, _ in try await loader.load() },
            now: { now }
        )
        viewModel.optionsAnalyticsExpiration = "2026-07-19"
        viewModel.setOptionsAnalyticsVisible(true)
        viewModel.setOptionsAnalyticsAppActive(true)
        try await eventually { viewModel.optionsAnalyticsDisplayState == .live }

        viewModel.setOptionsAnalyticsVisible(false)

        XCTAssertNil(viewModel.optionsAnalyticsSnapshot)
        XCTAssertEqual(String(describing: viewModel.optionsAnalyticsDisplayState), "unavailable")
    }

    func testRetentionEvictionIsExpiredAtSettlement() async throws {
        let snapshot = try Self.snapshot(symbol: "SPY", expiration: "2026-07-19")
        let loader = SequencedAnalyticsLoader(snapshot: snapshot)
        let now = DateParsing.dateTime("2026-07-19T20:00:00Z")!
        let viewModel = makeViewModel(
            loader: { _, _ in try await loader.load() },
            now: { now }
        )
        viewModel.optionsAnalyticsExpiration = "2026-07-19"
        viewModel.setOptionsAnalyticsVisible(true)
        viewModel.setOptionsAnalyticsAppActive(true)
        try await eventually { viewModel.optionsAnalyticsDisplayState == .live }

        viewModel.setOptionsAnalyticsVisible(false)

        XCTAssertNil(viewModel.optionsAnalyticsSnapshot)
        XCTAssertEqual(viewModel.optionsAnalyticsDisplayState, .expired)
    }

    func testRetentionExpiresAtTwoRefreshWindowsAndSettlement() throws {
        let snapshot = try Self.snapshot(symbol: "SPY", expiration: "2026-07-19")
        let withinWindow = DateParsing.dateTime("2026-07-19T14:31:00Z")!
        let outsideWindow = DateParsing.dateTime("2026-07-19T14:32:00Z")!
        let afterSettlement = DateParsing.dateTime("2026-07-19T20:00:01Z")!

        XCTAssertTrue(
            ChartViewModel.isRetainableOptionsAnalyticsSnapshot(
                snapshot,
                symbol: "SPY",
                expiration: "2026-07-19",
                refreshSeconds: 45,
                now: withinWindow
            )
        )
        XCTAssertFalse(
            ChartViewModel.isRetainableOptionsAnalyticsSnapshot(
                snapshot,
                symbol: "SPY",
                expiration: "2026-07-19",
                refreshSeconds: 45,
                now: outsideWindow
            )
        )
        XCTAssertFalse(
            ChartViewModel.isRetainableOptionsAnalyticsSnapshot(
                snapshot,
                symbol: "SPY",
                expiration: "2026-07-19",
                refreshSeconds: 45,
                now: afterSettlement
            )
        )
    }

    func testTransientFailureRetainsExactFreshSnapshotWithVisibleState() async throws {
        let snapshot = try Self.snapshot(symbol: "SPY", expiration: "2026-07-19")
        let loader = SequencedAnalyticsLoader(snapshot: snapshot)
        let now = DateParsing.dateTime("2026-07-19T14:31:00Z")!
        let viewModel = makeViewModel(
            loader: { _, _ in try await loader.load() },
            now: { now }
        )
        viewModel.optionsAnalyticsExpiration = "2026-07-19"
        viewModel.setOptionsAnalyticsVisible(true)
        viewModel.setOptionsAnalyticsAppActive(true)
        try await eventually { viewModel.optionsAnalyticsDisplayState == .live }

        viewModel.setOptionsAnalyticsVisible(false)
        viewModel.setOptionsAnalyticsVisible(true)

        try await eventually { viewModel.optionsAnalyticsDisplayState == .retained }
        XCTAssertEqual(viewModel.optionsAnalyticsSnapshot, snapshot)
        XCTAssertNotNil(viewModel.optionsAnalyticsErrorMessage)
    }

    func testInFlightRequestDoesNotRetainViewModel() async throws {
        weak var weakViewModel: ChartViewModel?
        var viewModel: ChartViewModel? = makeViewModel { _, _ in
            try await Task.sleep(for: .seconds(60))
            throw CancellationError()
        }
        weakViewModel = viewModel
        viewModel?.optionsAnalyticsExpiration = "2026-07-19"
        viewModel?.setOptionsAnalyticsVisible(true)
        viewModel?.setOptionsAnalyticsAppActive(true)
        viewModel = nil

        try await eventually { weakViewModel == nil }
    }

    private func makeViewModel(
        enabled: Bool = true,
        loader: @escaping @Sendable (String, String) async throws -> OptionsAnalyticsSnapshotDTO,
        now: @escaping @Sendable () -> Date = { Date() }
    ) -> ChartViewModel {
        let suite = "OptionsAnalyticsPollingTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        var settings = OptionsAnalyticsSettings.default
        settings.enabled = enabled
        let store = SettingsStore(defaults: defaults)
        store.optionsAnalyticsSettings = settings
        let baseURL = URL(string: "https://example.test")!
        let sessionStore = SessionStore(
            keychainStore: KeychainStore(service: suite),
            baseURL: baseURL
        )
        let apiClient = APIClient(baseURL: baseURL, sessionStore: sessionStore)
        let socket = QuoteSocketClient(streamURL: URL(string: "wss://example.test/v1/stream")!) { "token" }
        return ChartViewModel(
            apiClient: apiClient,
            socket: socket,
            settingsStore: store,
            optionsAnalyticsLoader: loader,
            optionsAnalyticsNow: now
        )
    }

    private func eventually(
        timeout: Duration = .seconds(1),
        condition: @escaping () async -> Bool
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Condition was not met before timeout")
    }

    nonisolated private static func snapshot(
        symbol: String,
        expiration: String
    ) throws -> OptionsAnalyticsSnapshotDTO {
        let json = OptionsAnalyticsAPITests.snapshotJSONForPolling
            .replacingOccurrences(of: "\"SPY\"", with: "\"\(symbol)\"")
            .replacingOccurrences(of: "\"2026-07-19\"", with: "\"\(expiration)\"")
        return try JSONDecoder().decode(OptionsAnalyticsSnapshotDTO.self, from: Data(json.utf8))
    }
}

private actor SequencedAnalyticsLoader {
    private let snapshot: OptionsAnalyticsSnapshotDTO
    private var callCount = 0

    init(snapshot: OptionsAnalyticsSnapshotDTO) {
        self.snapshot = snapshot
    }

    func load() throws -> OptionsAnalyticsSnapshotDTO {
        callCount += 1
        if callCount == 1 { return snapshot }
        throw APIError.network(underlying: "transient failure")
    }
}

private actor AnalyticsCallCounter {
    private(set) var requests: [(symbol: String, expiration: String)] = []
    var count: Int { requests.count }

    func record(symbol: String, expiration: String) {
        requests.append((symbol, expiration))
    }
}

private actor DeferredAnalyticsLoader {
    private var continuations: [String: CheckedContinuation<OptionsAnalyticsSnapshotDTO, Error>] = [:]

    func load(symbol: String, expiration: String) async throws -> OptionsAnalyticsSnapshotDTO {
        return try await withCheckedThrowingContinuation { continuation in
            continuations[expiration] = continuation
        }
    }

    func waitForRequest(expiration: String) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(1))
        while clock.now < deadline {
            if continuations[expiration] != nil { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw APIError.network(underlying: "request did not start")
    }

    func resume(expiration: String, with snapshot: OptionsAnalyticsSnapshotDTO) {
        continuations.removeValue(forKey: expiration)?.resume(returning: snapshot)
    }
}

private extension OptionsAnalyticsAPITests {
    static let snapshotJSONForPolling = """
    {"scope":{"symbol":"SPY","rootSymbol":"SPY","expiration":"2026-07-19","settlementStyle":"pm","observedAt":"2026-07-19T14:30:05Z","settlementAt":"2026-07-19T20:00:00Z","spot":584,"forward":584.2},"exposureUnit":"$ delta change per 1% underlying move","quality":{"quoteAsOf":null,"greeksAsOf":null,"oiEffectiveDate":null,"feedMode":"unknown","coverage":{"contractsTotal":0,"contractsIncluded":0,"ratio":0},"status":"partial","warnings":[],"calculationVersion":"options-analytics-v1","cacheStatus":"fresh"},"structure":{"callGammaExposure":0,"putGammaExposure":0,"grossGammaExposure":0,"callDeltaNotional":0,"putDeltaNotional":0,"callWall":null,"putWall":null,"grossGammaConcentration":null,"maxOpenInterestStrike":null},"scenarios":{"callPutDealerProxy":null},"impliedRange":null,"strikes":[]}
    """
}
