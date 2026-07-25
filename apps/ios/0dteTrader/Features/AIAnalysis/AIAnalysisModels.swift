#if canImport(FoundationModels)
import Foundation
import FoundationModels

@available(iOS 26, *)
@Generable
enum MarketSentiment: String, Sendable {
    case bullish
    case neutral
    case bearish
}

@available(iOS 26, *)
@Generable
struct MarketAnalysis: Sendable {
    @Guide(description: "Overall market sentiment: bullish, neutral, or bearish")
    var sentiment: MarketSentiment

    @Guide(description: "Confidence level from 0 to 100")
    var confidence: Int

    @Guide(description: "3 to 5 key technical observations referencing specific values from the data")
    var observations: [String]

    @Guide(description: "One paragraph analysis summary explaining the sentiment verdict")
    var summary: String
}

// MARK: - Snapshot

struct AIAnalysisSnapshot {
    let symbol: String
    let interval: String
    let candles: [Candle]
    let quote: Quote?
    let dayChange: DayChange?
    let indicators: Indicators?
    let optionsAnalytics: OptionsAnalyticsSnapshotDTO?
    let twcBias: String?
    let chain: ChainSummary?

    struct DayChange {
        let change: Double
        let percent: Double
    }

    struct Indicators {
        var overlays: [OverlaySeries] = []
        var rsi: [Double?]?
        var macdLine: [Double?]?
        var macdSignal: [Double?]?
        var macdHistogram: [Double?]?
        var stochK: [Double?]?
        var stochD: [Double?]?
        var atr: [Double?]?
    }

    struct OverlaySeries {
        let name: String
        let values: [Double?]
    }

    struct ChainSummary {
        let underlying: String
        let underlyingPrice: Double
        let nearestExpiration: String?
        let callCount: Int
        let putCount: Int
    }
}

// MARK: - Prompt Builder

enum AIAnalysisPromptBuilder {

    static let systemInstructions = """
        You are a technical market analyst. Analyze the provided market data for a \
        given ticker symbol. Consider price action, technical indicators, options structure, \
        and market structure. Be concise and specific. Reference actual values from the \
        data in your observations. Do not provide financial advice or trading \
        recommendations — only analysis of the data.
        """

    private static let maxPromptCharacters = 6_000

    // swiftlint:disable:next function_body_length
    static func buildPrompt(from snap: AIAnalysisSnapshot) -> String {
        var configuration = PromptConfiguration(
            candleLimit: min(50, snap.candles.count),
            includeScenario: true,
            includeChain: true,
            includeExtendedIndicators: true
        )

        var prompt = composePrompt(from: snap, configuration: configuration)
        while prompt.count > maxPromptCharacters {
            if configuration.includeScenario {
                configuration.includeScenario = false
            } else if configuration.includeChain {
                configuration.includeChain = false
            } else if configuration.candleLimit > 1 {
                configuration.candleLimit = max(1, configuration.candleLimit / 2)
            } else if configuration.includeExtendedIndicators {
                configuration.includeExtendedIndicators = false
            } else {
                break
            }
            prompt = composePrompt(from: snap, configuration: configuration)
        }

        return prompt
    }

    private struct PromptConfiguration {
        var candleLimit: Int
        var includeScenario: Bool
        var includeChain: Bool
        var includeExtendedIndicators: Bool
    }

    private static func composePrompt(
        from snap: AIAnalysisSnapshot,
        configuration: PromptConfiguration
    ) -> String {
        var parts: [String] = []

        parts.append("MARKET DATA SNAPSHOT FOR \(snap.symbol)")
        parts.append("Interval: \(snap.interval)")

        if let q = snap.quote {
            var line = "Current: Last \(f(q.last)) | Bid \(f(q.bid)) | Ask \(f(q.ask))"
            if let dc = snap.dayChange {
                line += " | Day Change: \(sf(dc.change)) (\(String(format: "%+.2f", dc.percent))%)"
            }
            parts.append(line)
        }

        let recentCandles = Array(snap.candles.suffix(configuration.candleLimit))
        if !recentCandles.isEmpty {
            parts.append("")
            parts.append(buildCandleTable(recentCandles, interval: snap.interval))
        }

        if let ind = snap.indicators,
           let indicatorsSection = buildIndicatorsSection(ind, includeExtended: configuration.includeExtendedIndicators) {
            parts.append("")
            parts.append(indicatorsSection)
        }

        if let bias = snap.twcBias {
            parts.append("")
            parts.append("TWC REGIME: \(bias)")
        }

        if let options = snap.optionsAnalytics {
            parts.append("")
            parts.append(buildOptionsAnalyticsSection(options, includeScenario: configuration.includeScenario))
        }

        if configuration.includeChain, let chain = snap.chain {
            parts.append("")
            parts.append("OPTIONS CHAIN SUMMARY:")
            var line = "Underlying: \(chain.underlying) at \(f(chain.underlyingPrice))"
            if let exp = chain.nearestExpiration { line += " | Nearest Expiration: \(exp)" }
            parts.append(line)
            parts.append("Calls: \(chain.callCount) contracts | Puts: \(chain.putCount) contracts")
        }

        parts.append("")
        parts.append("Analyze this data and provide your market assessment.")

        return parts.joined(separator: "\n")
    }

    // MARK: - Helpers

    static func buildCandleTable(_ candles: [Candle], interval: String) -> String {
        guard let first = candles.first else { return "" }

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        formatter.timeZone = TimeZone(identifier: "America/New_York")

        var lines: [String] = []
        lines.append("RECENT PRICE ACTION (last \(candles.count) candles, newest last):")
        lines.append(
            "CANDLES \(interval) start=\(formatter.string(from: first.time)) tz=NY " +
            "columns=open,high,low,close,volume encoding=b1-absolute-bars2plus-delta-from-previous-close"
        )

        var previousClose: Double?
        for (index, candle) in candles.enumerated() {
            if index == 0 {
                lines.append(
                    "B1: \(f(candle.open)),\(f(candle.high)),\(f(candle.low)),\(f(candle.close)),\(candle.volume)"
                )
            } else {
                let base = previousClose ?? candle.close
                lines.append(
                    "B\(index + 1): \(sf(candle.open - base)),\(sf(candle.high - base))," +
                    "\(sf(candle.low - base)),\(sf(candle.close - base)),\(candle.volume)"
                )
            }
            previousClose = candle.close
        }

        return lines.joined(separator: "\n")
    }

    private static func buildIndicatorsSection(
        _ indicators: AIAnalysisSnapshot.Indicators,
        includeExtended: Bool
    ) -> String? {
        var lines: [String] = []
        for overlay in indicators.overlays {
            appendIndicator(overlay.name, values: overlay.values, to: &lines)
        }
        if let rsi = indicators.rsi { appendIndicator("RSI", values: rsi, to: &lines) }
        if let v = indicators.macdLine { appendIndicator("MACD Line", values: v, to: &lines) }
        if let v = indicators.macdSignal { appendIndicator("MACD Signal", values: v, to: &lines) }
        if let v = indicators.macdHistogram { appendIndicator("MACD Histogram", values: v, to: &lines) }
        if includeExtended {
            if let v = indicators.stochK { appendIndicator("Stochastic %K", values: v, to: &lines) }
            if let v = indicators.stochD { appendIndicator("Stochastic %D", values: v, to: &lines) }
            if let v = indicators.atr { appendIndicator("ATR", values: v, to: &lines) }
        }
        guard !lines.isEmpty else { return nil }
        return (["TECHNICAL INDICATORS (latest readings):"] + lines).joined(separator: "\n")
    }

    static func buildOptionsAnalyticsSection(
        _ options: OptionsAnalyticsSnapshotDTO,
        includeScenario: Bool = true
    ) -> String {
        let coverageRatio = String(format: "%.2f", options.quality.coverage.ratio)
        let grossConcentration = options.structure.grossGammaConcentration.map { String(format: "%.2f", $0) } ?? "n/a"
        let rangeConfidence = options.impliedRange.map { String(format: "%.2f", $0.confidence) }
        let atmIv = options.impliedRange.map { String(format: "%.3f", $0.atmIv) }
        let warnings = options.quality.warnings.isEmpty ? "none" : options.quality.warnings.joined(separator: " | ")

        var lines: [String] = []
        lines.append("OPTIONS")
        lines.append(
            "s sym=\(options.scope.symbol) root=\(options.scope.rootSymbol) exp=\(options.scope.expiration) " +
            "set=\(options.scope.settlementStyle.rawValue.uppercased()) obs=\(options.scope.observedAt) " +
            "stl=\(options.scope.settlementAt) spot=\(f(options.scope.spot)) fwd=\(f(options.scope.forward))"
        )
        lines.append(
            "q=\(options.quality.status.rawValue)/\(options.quality.feedMode.rawValue) cov=\(options.quality.coverage.contractsIncluded)/\(options.quality.coverage.contractsTotal) " +
            "r=\(coverageRatio) qa=\(options.quality.quoteAsOf ?? "n/a") ga=\(options.quality.greeksAsOf ?? "n/a") " +
            "oi=\(options.quality.oiEffectiveDate ?? "n/a") c=\(options.quality.cacheStatus.rawValue) " +
            "v=\(options.quality.calculationVersion) w=\(warnings)"
        )
        lines.append(
            "x cg=\(optionalDollarText(options.structure.callGammaExposure)) pg=\(optionalDollarText(options.structure.putGammaExposure)) " +
            "gg=\(optionalDollarText(options.structure.grossGammaExposure)) cd=\(optionalDollarText(options.structure.callDeltaNotional)) " +
            "pd=\(optionalDollarText(options.structure.putDeltaNotional)) cw=\(options.structure.callWall.map(f) ?? "n/a") " +
            "pw=\(options.structure.putWall.map(f) ?? "n/a") oi=\(options.structure.maxOpenInterestStrike.map(f) ?? "n/a") " +
            "gc=\(grossConcentration)"
        )
        if let range = options.impliedRange {
            lines.append(
                "r label=\(range.label) lo=\(f(range.lower)) hi=\(f(range.upper)) c=\(rangeConfidence ?? "n/a") " +
                "atm=\(atmIv ?? "n/a") sl=\(f(range.straddleLower)) sh=\(f(range.straddleUpper))"
            )
        }
        if includeScenario, options.quality.status == .complete, let proxy = options.scenarios.callPutDealerProxy {
            let roots = proxy.gammaRoots.map(f).joined(separator: ",")
            lines.append(
                "d assumption=\(proxy.assumption) g=\(dollarText(proxy.gammaExposure)) " +
                "d=\(dollarText(proxy.deltaNotional)) root=\(proxy.primaryGammaRoot.map(f) ?? "n/a") roots=\(roots.isEmpty ? "none" : roots)"
            )
        }

        return lines.joined(separator: "\n")
    }

    private static func f(_ value: Double) -> String {
        String(format: "%.2f", value)
    }

    private static func sf(_ value: Double) -> String {
        String(format: "%+.2f", value)
    }

    private static func dollarText(_ value: Double) -> String {
        let abs = Swift.abs(value)
        let sign = value >= 0 ? "+" : "-"
        if abs >= 1_000_000_000 {
            return "\(sign)$\(String(format: "%.1f", abs / 1_000_000_000))B"
        } else if abs >= 1_000_000 {
            return "\(sign)$\(String(format: "%.1f", abs / 1_000_000))M"
        } else if abs >= 1_000 {
            return "\(sign)$\(String(format: "%.0f", abs / 1_000))K"
        } else {
            return "\(sign)$\(String(format: "%.0f", abs))"
        }
    }

    private static func optionalDollarText(_ value: Double?) -> String {
        value.map(dollarText) ?? "Unavailable"
    }

    private static func appendIndicator(_ name: String, values: [Double?], to lines: inout [String]) {
        let recent = values.suffix(10).compactMap { $0 }
        guard let last = recent.last else { return }
        if recent.count <= 1 {
            lines.append("\(name): \(f(last))")
        } else {
            let formatted = recent.suffix(5).map { f($0) }.joined(separator: ", ")
            lines.append("\(name): \(formatted)")
        }
    }
}
#endif
