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

    // swiftlint:disable:next function_body_length
    static func buildPrompt(from snap: AIAnalysisSnapshot) -> String {
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

        let recentCandles = snap.candles.suffix(50)
        if !recentCandles.isEmpty {
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd HH:mm"
            formatter.timeZone = TimeZone(identifier: "America/New_York")
            parts.append("")
            parts.append("RECENT PRICE ACTION (last \(recentCandles.count) candles, newest last):")
            parts.append("Time | Open | High | Low | Close | Volume")
            for c in recentCandles {
                parts.append("\(formatter.string(from: c.time)) | \(f(c.open)) | \(f(c.high)) | \(f(c.low)) | \(f(c.close)) | \(c.volume)")
            }
        }

        if let ind = snap.indicators {
            var lines: [String] = []
            for overlay in ind.overlays {
                appendIndicator(overlay.name, values: overlay.values, to: &lines)
            }
            if let rsi = ind.rsi { appendIndicator("RSI", values: rsi, to: &lines) }
            if let v = ind.macdLine { appendIndicator("MACD Line", values: v, to: &lines) }
            if let v = ind.macdSignal { appendIndicator("MACD Signal", values: v, to: &lines) }
            if let v = ind.macdHistogram { appendIndicator("MACD Histogram", values: v, to: &lines) }
            if let v = ind.stochK { appendIndicator("Stochastic %K", values: v, to: &lines) }
            if let v = ind.stochD { appendIndicator("Stochastic %D", values: v, to: &lines) }
            if let v = ind.atr { appendIndicator("ATR", values: v, to: &lines) }
            if !lines.isEmpty {
                parts.append("")
                parts.append("TECHNICAL INDICATORS (latest readings):")
                parts.append(contentsOf: lines)
            }
        }

        if let bias = snap.twcBias {
            parts.append("")
            parts.append("TWC REGIME: \(bias)")
        }

        if let options = snap.optionsAnalytics {
            parts.append("")
            parts.append("OPTIONS STRUCTURE (modeled from observed quotes and open interest):")
            parts.append(
                "Expiration: \(options.scope.expiration) | Product: \(options.scope.rootSymbol) " +
                "\(options.scope.settlementStyle.rawValue.uppercased()) | Status: " +
                "\(options.quality.status.rawValue) | Coverage: " +
                "\(options.quality.coverage.contractsIncluded)/\(options.quality.coverage.contractsTotal)"
            )
            parts.append(
                "Gamma per 1% move — Calls: \(optionalDollarText(options.structure.callGammaExposure)) | " +
                "Puts: \(optionalDollarText(options.structure.putGammaExposure)) | " +
                "Gross: \(optionalDollarText(options.structure.grossGammaExposure))"
            )
            var levels: [String] = []
            if let cw = options.structure.callWall { levels.append("Call Wall: \(f(cw))") }
            if let pw = options.structure.putWall { levels.append("Put Wall: \(f(pw))") }
            if let oi = options.structure.maxOpenInterestStrike {
                levels.append("Max OI Strike: \(f(oi))")
            }
            if !levels.isEmpty { parts.append(levels.joined(separator: " | ")) }
            if let range = options.impliedRange {
                parts.append(
                    "Model-implied 68% range: \(f(range.lower)) to \(f(range.upper)) | " +
                    "Straddle breakevens: \(f(range.straddleLower)) to \(f(range.straddleUpper))"
                )
            }
            if let proxy = options.scenarios.callPutDealerProxy {
                let roots = proxy.gammaRoots.map(f).joined(separator: ", ")
                parts.append(
                    "OPTIONAL DEALER POSITIONING SCENARIO — Gamma: \(dollarText(proxy.gammaExposure)) | " +
                    "Primary root: \(proxy.primaryGammaRoot.map(f) ?? "Unavailable") | " +
                    "All roots: \(roots.isEmpty ? "None" : roots)"
                )
                parts.append("Scenario assumption: \(proxy.assumption)")
            }
            if !options.quality.warnings.isEmpty {
                parts.append("Data quality warnings: \(options.quality.warnings.joined(separator: "; "))")
            }
        }

        if let chain = snap.chain {
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
