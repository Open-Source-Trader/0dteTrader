import Combine
import Foundation

enum ChartInterval: String, CaseIterable, Sendable {
    case m1 = "1m"
    case m5 = "5m"
    case m15 = "15m"
    case m30 = "30m"
    case h1 = "1h"
    case h4 = "4h"
    case d1 = "1d"

    var seconds: TimeInterval {
        switch self {
        case .m1: return 60
        case .m5: return 300
        case .m15: return 900
        case .m30: return 1_800
        case .h1: return 3_600
        case .h4: return 14_400
        case .d1: return 86_400
        }
    }
}

enum TickInterval: String, CaseIterable, Sendable {
    case t500 = "500t"
    case t1000 = "1000t"
    case t2500 = "2500t"
    case t5000 = "5000t"
    case t10000 = "10000t"

    var tickSize: Int {
        switch self {
        case .t500: return 500
        case .t1000: return 1_000
        case .t2500: return 2_500
        case .t5000: return 5_000
        case .t10000: return 10_000
        }
    }
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
    @Published private(set) var candles: [Candle] = []
    @Published private(set) var quote: Quote?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published private(set) var alertNotice: ChartAlertNotice?
    /// The main chart's visible candle-index window; indicator panes track it.
    @Published var visibleXRange: ClosedRange<Double>?

    /// Exact-expiration options structure snapshot for the current chart key.
    @Published private(set) var optionsAnalyticsSnapshot: OptionsAnalyticsSnapshotDTO?
    @Published private(set) var optionsAnalyticsErrorMessage: String?
    @Published private(set) var optionsAnalyticsDisplayState: OptionsAnalyticsDisplayState = .empty

    /// Drawing tools + price alerts for the current symbol.
    let drawings = ChartDrawingsModel()

    @Published var indicatorSettings: IndicatorSettings {
        didSet { settingsStore.indicatorSettings = indicatorSettings }
    }

    @Published var twcSettings: TwcHeatmapSettings {
        didSet { settingsStore.twcSettings = twcSettings }
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

    private struct TickAccumulator {
        var count: Int
        var open: Double
        var high: Double
        var low: Double
        var close: Double
        var firstTimestamp: Date
    }

    private var tickAccumulator: TickAccumulator?

    init(
        apiClient: APIClient,
        socket: QuoteSocketClient,
        settingsStore: SettingsStore,
        optionsAnalyticsLoader: (@Sendable (String, String) async throws -> OptionsAnalyticsSnapshotDTO)? = nil,
        optionsAnalyticsNow: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.apiClient = apiClient
        self.socket = socket
        self.settingsStore = settingsStore
        self.optionsAnalyticsLoader = optionsAnalyticsLoader ?? { symbol, expiration in
            try await apiClient.optionsAnalytics(symbol: symbol, expiration: expiration)
        }
        self.optionsAnalyticsNow = optionsAnalyticsNow
        self.symbol = settingsStore.lastSymbol ?? "SPY"
        self.indicatorSettings = settingsStore.indicatorSettings
        self.twcSettings = settingsStore.twcSettings
        self.optionsAnalyticsSettings = settingsStore.optionsAnalyticsSettings
        drawings.setSymbol(self.symbol)

        socket.$lastQuote
            .compactMap { $0 }
            .sink { [weak self] quote in
                self?.handleLiveQuote(quote)
            }
            .store(in: &cancellables)

    }

    deinit {
        optionsAnalyticsTask?.cancel()
    }

    // MARK: - Loading

    /// Initial load + subscription. Called when the trade screen appears.
    func start() async {
        socket.subscribe(symbols: [symbol])
        await loadCandles()
    }

    func loadCandles() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        if case .tick(let tickInterval) = interval {
            tickAccumulator = nil
            candles = TickStorage.load(symbol: symbol, interval: tickInterval)
            return
        }

        do {
            let from = Date().addingTimeInterval(-interval.seconds * 400)
            let dtos = try await apiClient.candles(symbol: symbol, interval: interval.rawValue, from: from)
            candles = dtos.map(Candle.init(dto:))
        } catch let error as APIError {
            if case let .server(_, message, _) = error,
               message.lowercased().contains("credentials") {
                alertNotice = ChartAlertNotice(id: UUID(), message: message)
            } else {
                errorMessage = error.userMessage
            }
            Haptics.error()
        } catch {
            errorMessage = error.localizedDescription
            Haptics.error()
        }
    }

    func selectSymbol(_ newSymbol: String) {
        let normalized = newSymbol.uppercased().trimmingCharacters(in: .whitespaces)
        guard !normalized.isEmpty, normalized != symbol else { return }
        socket.unsubscribe(symbols: [symbol])
        symbol = normalized
        settingsStore.lastSymbol = normalized
        drawings.setSymbol(normalized)
        tickAccumulator = nil
        quote = nil
        candles = []
        socket.subscribe(symbols: [normalized])
        // Never pair the new symbol with the previous chain's expiration.
        // Shadow capture resumes after the new chain selects an exact date.
        optionsAnalyticsExpiration = nil
        updateOptionsAnalyticsPolling(clearSnapshot: true)
        Task { await loadCandles() }
    }

    func selectInterval(_ newInterval: AnyChartInterval) {
        guard newInterval != interval else { return }
        tickAccumulator = nil
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

        let seconds = interval.seconds
        let bucketSeconds = (quote.timestamp.timeIntervalSince1970 / seconds).rounded(.down) * seconds
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

        if tickAccumulator == nil {
            tickAccumulator = TickAccumulator(
                count: 1, open: price, high: price, low: price,
                close: price, firstTimestamp: quote.timestamp
            )
            return
        }

        tickAccumulator!.count += 1
        tickAccumulator!.close = price
        tickAccumulator!.high = max(tickAccumulator!.high, price)
        tickAccumulator!.low = min(tickAccumulator!.low, price)

        if tickAccumulator!.count >= tickInterval.tickSize {
            let candle = Candle(
                time: tickAccumulator!.firstTimestamp,
                open: tickAccumulator!.open,
                high: tickAccumulator!.high,
                low: tickAccumulator!.low,
                close: tickAccumulator!.close,
                volume: 0
            )
            candles.append(candle)
            if candles.count > maxCandles {
                candles.removeFirst(candles.count - maxCandles)
            }
            tickAccumulator = nil
            TickStorage.save(symbol: symbol, interval: tickInterval, candles: candles)
        }
    }

    // MARK: - Indicator series for rendering

    /// Change vs the open of the first candle of the current session — a
    /// client-side prev-close proxy (Quote carries no previous close).
    var dayChange: (change: Double, percent: Double)? {
        guard let last = candles.last else { return nil }
        let calendar = Calendar.current
        guard let sessionOpen = candles.first(where: {
            calendar.isDate($0.time, inSameDayAs: last.time)
        })?.open, sessionOpen > 0 else { return nil }
        let current = quote?.last ?? last.close
        let change = current - sessionOpen
        return (change, change / sessionOpen * 100)
    }

    /// Overlays drawn on top of the candles (SMA, EMA, VWAP, Bollinger).
    /// TWC Heatmap render model, recomputed from the current candles and
    /// settings on every SwiftUI body evaluation (same lifecycle as the
    /// indicator series below; ~2 ms at 600 candles).
    var twcRenderModel: TwcRenderModel? {
        let seconds: Int
        if case .tick(let t) = interval {
            seconds = t.tickSize
        } else {
            seconds = Int(interval.seconds)
        }
        return TwcEngine.compute(
            candles: candles,
            settings: twcSettings,
            intervalSeconds: seconds
        )
    }

    var priceOverlays: [IndicatorSeries] {
        var series: [IndicatorSeries] = []
        if indicatorSettings.smaEnabled {
            series.append(
                IndicatorSeries(
                    id: "sma",
                    name: "SMA \(indicatorSettings.smaPeriod)",
                    values: IndicatorEngine.sma(candles: candles, period: indicatorSettings.smaPeriod)
                )
            )
        }
        if indicatorSettings.emaEnabled {
            series.append(
                IndicatorSeries(
                    id: "ema",
                    name: "EMA \(indicatorSettings.emaPeriod)",
                    values: IndicatorEngine.ema(candles: candles, period: indicatorSettings.emaPeriod)
                )
            )
        }
        if indicatorSettings.vwapEnabled {
            series.append(
                IndicatorSeries(id: "vwap", name: "VWAP", values: IndicatorEngine.vwap(candles: candles))
            )
        }
        if indicatorSettings.bollingerEnabled {
            let bands = IndicatorEngine.bollingerBands(
                candles: candles,
                period: indicatorSettings.bollingerPeriod,
                multiplier: indicatorSettings.bollingerMultiplier
            )
            series.append(IndicatorSeries(id: "bollingerUpper", name: "BB Upper", values: bands.upper))
            series.append(IndicatorSeries(id: "bollingerMiddle", name: "BB Mid", values: bands.middle))
            series.append(IndicatorSeries(id: "bollingerLower", name: "BB Lower", values: bands.lower))
        }
        return series
    }

    var rsiSeries: IndicatorSeries? {
        guard indicatorSettings.rsiEnabled else { return nil }
        return IndicatorSeries(
            id: "rsi",
            name: "RSI \(indicatorSettings.rsiPeriod)",
            values: IndicatorEngine.rsi(candles: candles, period: indicatorSettings.rsiPeriod)
        )
    }

    // swiftlint:disable:next large_tuple
    var macdSeries: (macd: IndicatorSeries, signal: IndicatorSeries, histogram: IndicatorSeries)? {
        guard indicatorSettings.macdEnabled else { return nil }
        let values = IndicatorEngine.macd(candles: candles)
        return (
            IndicatorSeries(id: "macd", name: "MACD", values: values.macdLine),
            IndicatorSeries(id: "macdSignal", name: "Signal", values: values.signalLine),
            IndicatorSeries(id: "macdHistogram", name: "Histogram", values: values.histogram)
        )
    }

    var stochSeries: (k: IndicatorSeries, d: IndicatorSeries)? {
        guard indicatorSettings.stochEnabled else { return nil }
        let values = IndicatorEngine.stochastic(
            candles: candles,
            kPeriod: indicatorSettings.stochKPeriod,
            kSmooth: indicatorSettings.stochKSmooth,
            dPeriod: indicatorSettings.stochDPeriod
        )
        return (
            IndicatorSeries(id: "stochK", name: "%K", values: values.k),
            IndicatorSeries(id: "stochD", name: "%D", values: values.d)
        )
    }

    var atrSeries: IndicatorSeries? {
        guard indicatorSettings.atrEnabled else { return nil }
        return IndicatorSeries(
            id: "atr",
            name: "ATR \(indicatorSettings.atrPeriod)",
            values: IndicatorEngine.atr(candles: candles, period: indicatorSettings.atrPeriod)
        )
    }
}
