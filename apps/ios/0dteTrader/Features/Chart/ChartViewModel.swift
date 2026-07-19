import Combine
import Foundation

enum ChartInterval: String, CaseIterable, Sendable {
    case m1 = "1m"
    case m5 = "5m"
    case m15 = "15m"
    case h1 = "1h"
    case d1 = "1d"

    var seconds: TimeInterval {
        switch self {
        case .m1: return 60
        case .m5: return 300
        case .m15: return 900
        case .h1: return 3_600
        case .d1: return 86_400
        }
    }
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

/// Owns the chart: candle history via REST, live quotes via QuoteSocketClient,
/// indicator computation, symbol/interval switching, chart annotations.
@MainActor
final class ChartViewModel: ObservableObject {
    @Published private(set) var symbol: String
    @Published private(set) var interval: ChartInterval = .m1
    @Published private(set) var candles: [Candle] = []
    @Published private(set) var quote: Quote?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published private(set) var alertNotice: ChartAlertNotice?
    /// The main chart's visible candle-index window; indicator panes track it.
    @Published var visibleXRange: ClosedRange<Double>?

    /// GEX/DEX level structure from the server (nil while disabled or before
    /// the first successful fetch for the current symbol).
    @Published private(set) var gexLevels: GexLevels?
    /// Fresh GEX fetch failed — showing the last good computation.
    @Published private(set) var gexStale = false
    /// Set only when there is nothing to show (e.g. token not configured).
    @Published private(set) var gexErrorMessage: String?

    /// Drawing tools + price alerts for the current symbol.
    let drawings = ChartDrawingsModel()

    @Published var indicatorSettings: IndicatorSettings {
        didSet { settingsStore.indicatorSettings = indicatorSettings }
    }

    @Published var twcSettings: TwcHeatmapSettings {
        didSet { settingsStore.twcSettings = twcSettings }
    }

    @Published var gexSettings: GexSettings {
        didSet {
            settingsStore.gexSettings = gexSettings
            // Only connectivity-relevant changes restart the poll loop;
            // display toggles apply on the next redraw and must not drop the
            // cached levels (a failed refetch would blank the overlay).
            if gexSettings.enabled != oldValue.enabled
                || gexSettings.refreshSeconds != oldValue.refreshSeconds {
                updateGexPolling()
            }
        }
    }

    private let apiClient: APIClient
    private let socket: QuoteSocketClient
    private let settingsStore: SettingsStore
    private var cancellables: Set<AnyCancellable> = []
    private var gexTask: Task<Void, Never>?

    /// Trade-ticket expiration for the GEX overlay; nil = server default.
    var gexExpiration: String? {
        didSet {
            if gexExpiration != oldValue { updateGexPolling() }
        }
    }

    /// Upper bound on rendered candles so live appends stay cheap.
    private let maxCandles = 600

    init(apiClient: APIClient, socket: QuoteSocketClient, settingsStore: SettingsStore) {
        self.apiClient = apiClient
        self.socket = socket
        self.settingsStore = settingsStore
        self.symbol = settingsStore.lastSymbol ?? "SPY"
        self.indicatorSettings = settingsStore.indicatorSettings
        self.twcSettings = settingsStore.twcSettings
        self.gexSettings = settingsStore.gexSettings
        drawings.setSymbol(self.symbol)

        socket.$lastQuote
            .compactMap { $0 }
            .sink { [weak self] quote in
                self?.handleLiveQuote(quote)
            }
            .store(in: &cancellables)

        updateGexPolling()
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
        do {
            let from = Date().addingTimeInterval(-interval.seconds * 400)
            let dtos = try await apiClient.candles(symbol: symbol, interval: interval.rawValue, from: from)
            candles = dtos.map(Candle.init(dto:))
        } catch let error as APIError {
            errorMessage = error.userMessage
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
        quote = nil
        candles = []
        // Levels are symbol-keyed server-side: drop the old symbol's overlay
        // immediately rather than painting its walls over the new chart.
        socket.subscribe(symbols: [normalized])
        updateGexPolling()
        Task { await loadCandles() }
    }

    func selectInterval(_ newInterval: ChartInterval) {
        guard newInterval != interval else { return }
        interval = newInterval
        Task { await loadCandles() }
    }

    // MARK: - GEX/DEX polling

    /// (Re)starts the GEX poll loop for the current symbol and settings.
    /// The server caches the option chain (OI is static intraday), so each
    /// poll is cheap. On failure the last good levels stay on screen,
    /// flagged stale.
    private func updateGexPolling() {
        gexTask?.cancel()
        gexTask = nil
        gexLevels = nil
        gexStale = false
        gexErrorMessage = nil
        guard gexSettings.enabled else { return }

        gexTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let symbol = self.symbol
                do {
                    let dto = try await self.apiClient.gexLevels(
                        symbol: symbol,
                        expiration: self.gexExpiration
                    )
                    guard !Task.isCancelled else { return }
                    let levels = GexLevels(dto: dto)
                    // A symbol or expiration change during the fetch makes
                    // the result irrelevant to the chart now on screen.
                    if levels.symbol == self.symbol,
                       self.gexExpiration == nil || levels.expiration == self.gexExpiration {
                        self.gexLevels = levels
                        self.gexStale = levels.stale
                        self.gexErrorMessage = nil
                    }
                } catch is CancellationError {
                    return
                } catch {
                    guard !Task.isCancelled else { return }
                    if self.gexLevels != nil {
                        self.gexStale = true
                    } else if let apiError = error as? APIError {
                        self.gexErrorMessage = apiError.userMessage
                    } else {
                        self.gexErrorMessage = error.localizedDescription
                    }
                }
                let seconds = max(self.gexSettings.refreshSeconds, 15)
                try? await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000)
            }
        }
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
        guard !candles.isEmpty else { return }
        // Unparseable timestamps map to epoch 0 (Quote.init(dto:)); keep the
        // quote display, skip candle bucketing.
        guard quote.timestamp.timeIntervalSince1970 > 0 else { return }

        let bucketSeconds = (quote.timestamp.timeIntervalSince1970 / interval.seconds).rounded(.down) * interval.seconds
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
        TwcEngine.compute(
            candles: candles,
            settings: twcSettings,
            intervalSeconds: Int(interval.seconds)
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
