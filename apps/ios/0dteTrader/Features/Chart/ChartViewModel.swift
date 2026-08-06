import Combine
import Foundation
// The chart's candle, socket, analytics, and indicator state transitions are
// intentionally co-located to keep symbol changes atomic.
// swiftlint:disable file_length

enum ChartInterval: String, CaseIterable, Sendable {
    case m1 = "1m"
    case m5 = "5m"
    case m15 = "15m"
    case m30 = "30m"
    case h1 = "1h"
    case h4 = "4h"
    case d1 = "1d"
    case w1 = "1w"

    var seconds: TimeInterval {
        switch self {
        case .m1: return 60
        case .m5: return 300
        case .m15: return 900
        case .m30: return 1_800
        case .h1: return 3_600
        case .h4: return 14_400
        case .d1: return 86_400
        case .w1: return 604_800
        }
    }

    /// 1970-01-01 is a Thursday; shift 4 days so weekly buckets start Monday 00:00 UTC.
    private static let mondayEpochOffset: TimeInterval = 345_600

    /// Live-quote bucket start — must match the server's candle-aggregation math
    /// so streamed quotes append to the buckets REST history produced.
    func bucketStart(forEpochSeconds epochSeconds: TimeInterval) -> TimeInterval {
        if self == .w1 {
            return ((epochSeconds - Self.mondayEpochOffset) / seconds).rounded(.down) * seconds
                + Self.mondayEpochOffset
        }
        return (epochSeconds / seconds).rounded(.down) * seconds
    }
}

enum TickInterval: String, CaseIterable, Sendable {
    case t10 = "10t"
    case t25 = "25t"
    case t50 = "50t"
    case t100 = "100t"
    case t250 = "250t"

    var tickSize: Int {
        switch self {
        case .t10: return 10
        case .t25: return 25
        case .t50: return 50
        case .t100: return 100
        case .t250: return 250
        }
    }
}

/// Tick intervals only: quotes accumulated toward the next candle.
struct TickProgress: Equatable, Sendable {
    let count: Int
    let size: Int
}

enum AnyChartInterval: Hashable, Sendable {
    case candle(ChartInterval)
    case tick(TickInterval)

    var rawValue: String {
        switch self {
        case .candle(let interval): return interval.rawValue
        case .tick(let interval): return interval.rawValue
        }
    }

    var seconds: TimeInterval {
        switch self {
        case .candle(let interval): return interval.seconds
        case .tick: return 0
        }
    }

    var isTick: Bool {
        if case .tick = self { return true }
        return false
    }

    static let allCases: [AnyChartInterval] =
        ChartInterval.allCases.map { .candle($0) } +
        TickInterval.allCases.map { .tick($0) }
}

/// One computed indicator line, aligned with the candle array (nil = warm-up gap).
struct IndicatorSeries: Equatable, Sendable {
    let id: String
    let name: String
    let values: [Double?]
}

/// A fired price alert, surfaced to the trade screen as a toast.
struct ChartAlertNotice: Equatable, Sendable {
    let id: UUID
    let message: String
}

enum OptionsAnalyticsDisplayState: Equatable, Sendable {
    case empty
    case live
    case retained
    case unavailable
    case expired
}

/// Owns the chart: candle history via REST, live quotes via QuoteSocketClient,
/// indicator computation, symbol/interval switching, chart annotations.
@MainActor
final class ChartViewModel: ObservableObject {
    @Published private(set) var symbol: String
    @Published private(set) var interval: AnyChartInterval = .candle(.m1)
    @Published private(set) var candles: [Candle] = [] {
        didSet { refreshIndicatorRenderSnapshot() }
    }
    @Published private(set) var quote: Quote?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published private(set) var alertNotice: ChartAlertNotice?
    @Published private(set) var tickProgress: TickProgress?

    /// Exact-expiration options structure snapshot for the current chart key.
    @Published private(set) var optionsAnalyticsSnapshot: OptionsAnalyticsSnapshotDTO?
    @Published private(set) var optionsAnalyticsErrorMessage: String?
    @Published private(set) var optionsAnalyticsDisplayState: OptionsAnalyticsDisplayState = .empty

    /// Drawing tools + price alerts for the current symbol.
    let drawings = ChartDrawingsModel()

    let indicatorRegistry: IndicatorRegistry
    let defaultIndicatorSettings: IndicatorSettingsState
    @Published private(set) var indicatorSettings: IndicatorSettingsState
    @Published private(set) var chartDisplayPreferences: ChartDisplayPreferences
    @Published private(set) var indicatorErrorMessage: String?
    @Published private(set) var indicatorRenderSnapshot = IndicatorRenderSnapshot.empty
    @Published private(set) var l2UnavailableReason = "No L2 data"
    private(set) var currentL2Indicators: OrderBookIndicatorsDTO?

    var hasFreshL2Data: Bool { currentL2Indicators != nil }

    private var indicatorRenderRevision: IndicatorRenderRevision?
    private(set) var indicatorRenderComputationCount = 0

    @Published var twcSettings: TwcHeatmapSettings {
        didSet { settingsStore.twcSettings = twcSettings }
    }

    @Published var usrSettings: UsrSettings {
        didSet { settingsStore.usrSettings = usrSettings }
    }

    @Published var optionsAnalyticsSettings: OptionsAnalyticsSettings {
        didSet {
            settingsStore.optionsAnalyticsSettings = optionsAnalyticsSettings
            if optionsAnalyticsSettings.refreshSeconds != oldValue.refreshSeconds {
                updateOptionsAnalyticsPolling(clearSnapshot: false)
            }
        }
    }

    private let apiClient: APIClient
    private let socket: QuoteSocketClient
    private let settingsStore: SettingsStore
    private let optionsAnalyticsLoader: @Sendable (String, String) async throws -> OptionsAnalyticsSnapshotDTO
    private let optionsAnalyticsNow: @Sendable () -> Date
    private var cancellables: Set<AnyCancellable> = []
    private var optionsAnalyticsTask: Task<Void, Never>?
    private var optionsAnalyticsGeneration = 0
    private var isOptionsAnalyticsVisible = false
    private var isOptionsAnalyticsAppActive = false

    /// Trade-ticket expiration. A non-nil value must be returned exactly.
    var optionsAnalyticsExpiration: String? {
        didSet {
            if optionsAnalyticsExpiration != oldValue {
                updateOptionsAnalyticsPolling(clearSnapshot: true)
            }
        }
    }

    /// Upper bound on rendered candles so live appends stay cheap.
    private let maxCandles = 600

    private var tickAccumulator: TickAccumulatorState?

    /// Bumped by every `loadCandles()` call; a load bails after each await
    /// once a newer one has started, so a slow response (e.g. a stale
    /// symbol's request outliving a rapid follow-up switch) can't clobber
    /// state a newer load already set. `selectSymbol`/`selectInterval` fire
    /// `loadCandles()` in an untracked `Task { ... }` with nothing else to
    /// order them, so this is the only thing that does (ChartStore.ts's
    /// `loadGeneration` analog).
    private var loadGeneration = 0

    init(
        apiClient: APIClient,
        socket: QuoteSocketClient,
        settingsStore: SettingsStore,
        indicatorRegistry: IndicatorRegistry? = nil,
        optionsAnalyticsLoader: (@Sendable (String, String) async throws -> OptionsAnalyticsSnapshotDTO)? = nil,
        optionsAnalyticsNow: @escaping @Sendable () -> Date = { Date() }
    ) {
        let registry: IndicatorRegistry
        do {
            registry = try indicatorRegistry ?? IndicatorRegistry.bundled()
        } catch {
            preconditionFailure("The bundled indicator registry is invalid: \(error.localizedDescription)")
        }
        self.indicatorRegistry = registry
        let defaultIndicatorSettings: IndicatorSettingsState
        do {
            defaultIndicatorSettings = try IndicatorSettingsState.defaults(for: registry)
        } catch {
            preconditionFailure("The indicator registry defaults are invalid: \(error.localizedDescription)")
        }
        self.defaultIndicatorSettings = defaultIndicatorSettings
        do {
            self.indicatorSettings = try settingsStore.loadIndicatorSettings(registry: registry)
            self.chartDisplayPreferences = try settingsStore.loadChartDisplayPreferences()
            self.indicatorErrorMessage = nil
        } catch {
            self.indicatorSettings = defaultIndicatorSettings
            self.chartDisplayPreferences = .default
            self.indicatorErrorMessage = error.localizedDescription
        }
        self.apiClient = apiClient
        self.socket = socket
        self.settingsStore = settingsStore
        self.optionsAnalyticsLoader = optionsAnalyticsLoader ?? { symbol, expiration in
            try await apiClient.optionsAnalytics(symbol: symbol, expiration: expiration)
        }
        self.optionsAnalyticsNow = optionsAnalyticsNow
        self.symbol = settingsStore.lastSymbol ?? "SPY"
        self.twcSettings = settingsStore.twcSettings
        self.usrSettings = settingsStore.usrSettings
        self.optionsAnalyticsSettings = settingsStore.optionsAnalyticsSettings
        drawings.setSymbol(self.symbol)

        socket.$lastQuote
            .compactMap { $0 }
            .sink { [weak self] quote in
                self?.handleLiveQuote(quote)
            }
            .store(in: &cancellables)

        socket.$l2Snapshots
            .combineLatest(socket.$l2Statuses)
            .sink { [weak self] snapshots, statuses in
                self?.updateL2State(snapshots: snapshots, statuses: statuses)
            }
            .store(in: &cancellables)

        refreshIndicatorRenderSnapshot(clearExistingError: false)

    }

    deinit {
        optionsAnalyticsTask?.cancel()
    }

    // MARK: - Loading

    /// Initial load + subscription. Called when the trade screen appears.
    func start() async {
        socket.subscribe(symbols: [symbol])
        socket.subscribeL2(symbol: symbol, levels: 50)
        await loadCandles()
    }

    func loadCandles() async {
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        errorMessage = nil
        defer { if generation == loadGeneration { isLoading = false } }

        if case .tick(let tickInterval) = interval {
            tickAccumulator = nil
            tickProgress = nil
            let stored = await TickStorage.shared.load(symbol: symbol, interval: tickInterval)
            guard generation == loadGeneration else { return }
            tickAccumulator = stored.accumulator
            var loaded = stored.candles
            if loaded.isEmpty {
                // Never show a blank chart while ticks accumulate (a 250t candle
                // takes ~4 min of 1/sec quotes): seed with recent 1m history.
                let from = Date().addingTimeInterval(-3_600)
                if let dtos = try? await apiClient.candles(
                    symbol: symbol, interval: "1m", from: from
                ) {
                    guard generation == loadGeneration else { return }
                    loaded = dtos.map(Candle.init(dto:))
                }
            }
            guard generation == loadGeneration else { return }
            candles = loaded
            tickProgress = TickProgress(
                count: stored.accumulator?.count ?? 0,
                size: tickInterval.tickSize
            )
            return
        }

        do {
            let from = Date().addingTimeInterval(-interval.seconds * 400)
            let dtos = try await apiClient.candles(symbol: symbol, interval: interval.rawValue, from: from)
            guard generation == loadGeneration else { return }
            candles = dtos.map(Candle.init(dto:))
        } catch let error as APIError {
            guard generation == loadGeneration else { return }
            if case let .server(_, message, _) = error,
               message.lowercased().contains("credentials") {
                alertNotice = ChartAlertNotice(id: UUID(), message: message)
            } else {
                errorMessage = error.userMessage
            }
            Haptics.error()
        } catch {
            guard generation == loadGeneration else { return }
            errorMessage = error.localizedDescription
            Haptics.error()
        }
    }

    func selectSymbol(_ newSymbol: String) {
        let normalized = newSymbol.uppercased().trimmingCharacters(in: .whitespaces)
        guard !normalized.isEmpty, normalized != symbol else { return }
        socket.unsubscribe(symbols: [symbol])
        socket.unsubscribeL2(symbol: symbol)
        symbol = normalized
        settingsStore.lastSymbol = normalized
        drawings.setSymbol(normalized)
        tickAccumulator = nil
        tickProgress = nil
        quote = nil
        candles = []
        socket.subscribe(symbols: [normalized])
        socket.subscribeL2(symbol: normalized, levels: 50)
        // Never pair the new symbol with the previous chain's expiration.
        // Shadow capture resumes after the new chain selects an exact date.
        optionsAnalyticsExpiration = nil
        updateOptionsAnalyticsPolling(clearSnapshot: true)
        Task { await loadCandles() }
    }

    func selectInterval(_ newInterval: AnyChartInterval) {
        guard newInterval != interval else { return }
        tickAccumulator = nil
        tickProgress = nil
        interval = newInterval
        Task { await loadCandles() }
    }

    // MARK: - Options Analytics polling

    func setOptionsAnalyticsVisible(_ visible: Bool) {
        guard visible != isOptionsAnalyticsVisible else { return }
        isOptionsAnalyticsVisible = visible
        updateOptionsAnalyticsPolling(clearSnapshot: false)
    }

    func setOptionsAnalyticsAppActive(_ active: Bool) {
        guard active != isOptionsAnalyticsAppActive else { return }
        isOptionsAnalyticsAppActive = active
        updateOptionsAnalyticsPolling(clearSnapshot: false)
    }

    private func updateOptionsAnalyticsPolling(clearSnapshot: Bool) {
        optionsAnalyticsTask?.cancel()
        optionsAnalyticsTask = nil
        optionsAnalyticsGeneration &+= 1
        if clearSnapshot {
            optionsAnalyticsSnapshot = nil
            optionsAnalyticsDisplayState = .empty
        } else if let snapshot = optionsAnalyticsSnapshot {
            if let expiration = optionsAnalyticsExpiration,
               Self.isRetainableOptionsAnalyticsSnapshot(
                   snapshot,
                   symbol: symbol,
                   expiration: expiration,
                   refreshSeconds: optionsAnalyticsSettings.refreshSeconds,
                   now: optionsAnalyticsNow()
               ) {
                // Keep the exact fresh snapshot visible while the replacement request runs.
            } else {
                optionsAnalyticsSnapshot = nil
                optionsAnalyticsDisplayState = Self.evictionState(
                    for: snapshot,
                    now: optionsAnalyticsNow()
                )
            }
        }
        optionsAnalyticsErrorMessage = nil
        guard isOptionsAnalyticsVisible,
              isOptionsAnalyticsAppActive,
              let requestExpiration = optionsAnalyticsExpiration
        else { return }

        let generation = optionsAnalyticsGeneration
        let requestSymbol = symbol
        let refreshSeconds = optionsAnalyticsSettings.refreshSeconds
        let loader = optionsAnalyticsLoader
        let now = optionsAnalyticsNow
        optionsAnalyticsTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let snapshot = try await loader(
                        requestSymbol,
                        requestExpiration
                    )
                    guard !Task.isCancelled else { return }
                    let accepted = { [weak self] in
                        guard let self,
                              generation == self.optionsAnalyticsGeneration,
                              requestSymbol == self.symbol,
                              self.optionsAnalyticsExpiration == requestExpiration
                        else { return false }
                        do {
                            self.optionsAnalyticsSnapshot = try snapshot.validated(
                                expectedSymbol: requestSymbol,
                                expectedExpiration: requestExpiration
                            )
                            self.optionsAnalyticsErrorMessage = nil
                            self.optionsAnalyticsDisplayState = .live
                        } catch {
                            self.handleOptionsAnalyticsFailure(
                                error,
                                symbol: requestSymbol,
                                expiration: requestExpiration,
                                refreshSeconds: refreshSeconds,
                                now: now()
                            )
                        }
                        return true
                    }()
                    guard accepted else { return }
                } catch is CancellationError {
                    return
                } catch {
                    guard !Task.isCancelled else { return }
                    let accepted = { [weak self] in
                        guard let self,
                              generation == self.optionsAnalyticsGeneration,
                              requestSymbol == self.symbol,
                              self.optionsAnalyticsExpiration == requestExpiration
                        else { return false }
                        self.handleOptionsAnalyticsFailure(
                            error,
                            symbol: requestSymbol,
                            expiration: requestExpiration,
                            refreshSeconds: refreshSeconds,
                            now: now()
                        )
                        return true
                    }()
                    guard accepted else { return }
                }
                do {
                    try await Task.sleep(for: .seconds(refreshSeconds))
                } catch {
                    return
                }
            }
        }
    }

    private func handleOptionsAnalyticsFailure(
        _ error: Error,
        symbol: String,
        expiration: String,
        refreshSeconds: Int,
        now: Date
    ) {
        if let apiError = error as? APIError {
            optionsAnalyticsErrorMessage = apiError.userMessage
        } else {
            optionsAnalyticsErrorMessage = error.localizedDescription
        }
        if let snapshot = optionsAnalyticsSnapshot,
           Self.isRetainableOptionsAnalyticsSnapshot(
               snapshot,
               symbol: symbol,
               expiration: expiration,
               refreshSeconds: refreshSeconds,
               now: now
           ) {
            optionsAnalyticsDisplayState = .retained
        } else {
            let previous = optionsAnalyticsSnapshot
            optionsAnalyticsSnapshot = nil
            optionsAnalyticsDisplayState = previous.map {
                Self.evictionState(for: $0, now: now)
            } ?? .unavailable
        }
    }

    nonisolated private static func evictionState(
        for snapshot: OptionsAnalyticsSnapshotDTO,
        now: Date
    ) -> OptionsAnalyticsDisplayState {
        guard let settlementAt = DateParsing.dateTime(snapshot.scope.settlementAt) else {
            return .unavailable
        }
        return now >= settlementAt ? .expired : .unavailable
    }

    nonisolated static func isRetainableOptionsAnalyticsSnapshot(
        _ snapshot: OptionsAnalyticsSnapshotDTO,
        symbol: String,
        expiration: String,
        refreshSeconds: Int,
        now: Date
    ) -> Bool {
        let normalizedSymbol = symbol.uppercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard snapshot.scope.symbol == normalizedSymbol,
              snapshot.scope.expiration == expiration,
              let observedAt = DateParsing.dateTime(snapshot.scope.observedAt),
              let settlementAt = DateParsing.dateTime(snapshot.scope.settlementAt),
              observedAt <= now,
              now < settlementAt
        else { return false }
        let maximumAge = TimeInterval(max(15, refreshSeconds) * 2)
        return now.timeIntervalSince(observedAt) <= maximumAge
    }

    // MARK: - Live updates (FR-8)

    private func handleLiveQuote(_ quote: Quote) {
        guard quote.symbol == symbol else { return }
        let previousLast = self.quote?.last
        self.quote = quote
        if let previousLast {
            for alert in drawings.checkAlerts(previousLast: previousLast, last: quote.last) {
                alertNotice = ChartAlertNotice(
                    id: UUID(),
                    message: "Alert: \(symbol) crossed \(Format.price(alert.price))"
                )
                Haptics.success()
            }
        }

        if case .tick(let tickInterval) = interval {
            handleTickQuote(quote, tickInterval: tickInterval)
            return
        }

        guard !candles.isEmpty else { return }
        guard quote.timestamp.timeIntervalSince1970 > 0 else { return }
        guard case .candle(let candleInterval) = interval else { return }

        let bucketSeconds = candleInterval.bucketStart(
            forEpochSeconds: quote.timestamp.timeIntervalSince1970
        )
        let bucketStart = Date(timeIntervalSince1970: bucketSeconds)
        var last = candles[candles.count - 1]

        if bucketStart.timeIntervalSince1970 == last.time.timeIntervalSince1970 {
            last.close = quote.last
            last.high = max(last.high, quote.last)
            last.low = min(last.low, quote.last)
            candles[candles.count - 1] = last
        } else if bucketStart > last.time {
            candles.append(
                Candle(
                    time: bucketStart,
                    open: last.close,
                    high: max(last.close, quote.last),
                    low: min(last.close, quote.last),
                    close: quote.last,
                    volume: 0
                )
            )
            if candles.count > maxCandles {
                candles.removeFirst(candles.count - maxCandles)
            }
        }
    }

    private func handleTickQuote(_ quote: Quote, tickInterval: TickInterval) {
        let price = quote.last
        guard quote.timestamp.timeIntervalSince1970 > 0 else { return }
        let size = tickInterval.tickSize

        if var accumulator = tickAccumulator {
            accumulator.count += 1
            accumulator.close = price
            accumulator.high = max(accumulator.high, price)
            accumulator.low = min(accumulator.low, price)
            tickAccumulator = accumulator
        } else {
            tickAccumulator = TickAccumulatorState(
                count: 1, open: price, high: price, low: price, close: price,
                firstTimestamp: quote.timestamp.timeIntervalSince1970
            )
        }

        if let accumulator = tickAccumulator, accumulator.count >= size {
            // The chart requires strictly ascending times; a 1m seed candle can
            // share the same second as the first live tick candle.
            var candleTime = Date(timeIntervalSince1970: accumulator.firstTimestamp)
            if let previous = candles.last, candleTime <= previous.time {
                candleTime = previous.time.addingTimeInterval(1)
            }
            let candle = Candle(
                time: candleTime,
                open: accumulator.open,
                high: accumulator.high,
                low: accumulator.low,
                close: accumulator.close,
                volume: 0
            )
            candles.append(candle)
            if candles.count > maxCandles {
                candles.removeFirst(candles.count - maxCandles)
            }
            tickAccumulator = nil
            tickProgress = TickProgress(count: 0, size: size)
        } else {
            tickProgress = TickProgress(count: tickAccumulator?.count ?? 0, size: size)
        }
        // Persist candles and the in-progress accumulator on every quote
        // (≤1/sec) so a restart resumes the partial candle instead of losing
        // it. Fire-and-forget onto the TickStorage actor: the encode + atomic
        // file write is blocking I/O that must not run on this (@MainActor)
        // thread, and the actor serializes it against any write still in
        // flight from a previous tick.
        let snapshot = StoredTickState(candles: candles, accumulator: tickAccumulator)
        Task { await TickStorage.shared.save(symbol: symbol, interval: tickInterval, state: snapshot) }
    }

    // MARK: - Indicator settings and rendering

    func setIndicatorEnabled(id: String, enabled: Bool) {
        guard indicatorRegistry.descriptor(id: id) != nil else {
            indicatorErrorMessage = "Unknown indicator \(id)."
            return
        }
        var candidate = indicatorSettings
        candidate.indicators[id]?.enabled = enabled
        applyIndicatorSettings(candidate)
    }

    func setIndicatorParameter(id: String, parameterId: String, value: Double) {
        guard indicatorRegistry.descriptor(id: id)?.parameters[parameterId] != nil else {
            indicatorErrorMessage = "Unknown parameter \(id).\(parameterId)."
            return
        }
        var candidate = indicatorSettings
        candidate.indicators[id]?.parameters[parameterId] = value
        applyIndicatorSettings(candidate)
    }

    func resetIndicatorSettings() {
        applyIndicatorSettings(defaultIndicatorSettings)
    }

    func setVolumeEnabled(_ enabled: Bool) {
        var candidate = chartDisplayPreferences
        candidate.volumeEnabled = enabled
        do {
            try settingsStore.updateChartDisplayPreferences(candidate)
            chartDisplayPreferences = candidate
        } catch {
            indicatorErrorMessage = error.localizedDescription
        }
    }

    func setVolumeWeightedCandleWidth(_ enabled: Bool) {
        var candidate = chartDisplayPreferences
        candidate.volumeWeightedCandleWidth = enabled
        do {
            try settingsStore.updateChartDisplayPreferences(candidate)
            chartDisplayPreferences = candidate
        } catch {
            indicatorErrorMessage = error.localizedDescription
        }
    }

    private func applyIndicatorSettings(_ candidate: IndicatorSettingsState) {
        do {
            let candidateSnapshot = try IndicatorRenderSnapshot.make(
                registry: indicatorRegistry,
                settings: candidate,
                candles: candles,
                l2Indicators: currentL2Indicators,
                l2UnavailableReason: l2UnavailableReason
            )
            try settingsStore.updateIndicatorSettings(candidate, registry: indicatorRegistry)
            indicatorSettings = candidate
            indicatorRenderRevision = IndicatorRenderRevision(
                settings: candidate,
                candles: candles,
                l2Indicators: currentL2Indicators,
                l2UnavailableReason: l2UnavailableReason
            )
            indicatorRenderComputationCount += 1
            indicatorRenderSnapshot = candidateSnapshot
            indicatorErrorMessage = nil
        } catch {
            indicatorErrorMessage = error.localizedDescription
        }
    }

    private func refreshIndicatorRenderSnapshot(clearExistingError: Bool = true) {
        let revision = IndicatorRenderRevision(
            settings: indicatorSettings,
            candles: candles,
            l2Indicators: currentL2Indicators,
            l2UnavailableReason: l2UnavailableReason
        )
        guard revision != indicatorRenderRevision else { return }
        indicatorRenderRevision = revision
        indicatorRenderComputationCount += 1
        do {
            indicatorRenderSnapshot = try IndicatorRenderSnapshot.make(
                registry: indicatorRegistry,
                settings: indicatorSettings,
                candles: candles,
                l2Indicators: currentL2Indicators,
                l2UnavailableReason: l2UnavailableReason
            )
            if clearExistingError {
                indicatorErrorMessage = nil
            }
        } catch {
            indicatorErrorMessage = error.localizedDescription
        }
    }

    private func updateL2State(
        snapshots: [String: L2SnapshotPayloadDTO],
        statuses: [String: OrderBookStatusDTO]
    ) {
        let key = symbol.uppercased()
        let status = statuses[key]
        let payload = snapshots[key]
        let nextIndicators: OrderBookIndicatorsDTO?
        let nextReason: String
        if status?.isAvailable == true, payload?.snapshot.freshness == .fresh {
            nextIndicators = payload?.indicators
            nextReason = ""
        } else {
            nextIndicators = nil
            if let message = status?.unavailableMessage, !message.isEmpty {
                nextReason = "No L2 data — \(message)"
            } else {
                nextReason = "No L2 data"
            }
        }
        guard nextIndicators != currentL2Indicators || nextReason != l2UnavailableReason else { return }
        currentL2Indicators = nextIndicators
        l2UnavailableReason = nextReason
        refreshIndicatorRenderSnapshot()
    }

}
