import Foundation
import UIKit

struct OptionsAnalyticsProfileNormalization: Equatable, Sendable {
    let gammaExposure: Double
    let markedOiValue: Double
}

struct OptionsAnalyticsLegDetail: Equatable, Sendable {
    let label: String
    let value: String
}

enum OptionsAnalyticsPresentation {
    static let callColor = UIColor(red: 34 / 255, green: 224 / 255, blue: 106 / 255, alpha: 1)
    static let putColor = UIColor(red: 1, green: 89 / 255, blue: 105 / 255, alpha: 1)
    static let rangeColor = UIColor(red: 100 / 255, green: 210 / 255, blue: 1, alpha: 1)
    static let markedOiCallColor = UIColor(red: 1, green: 159 / 255, blue: 10 / 255, alpha: 1)
    static let markedOiPutColor = UIColor(red: 1, green: 214 / 255, blue: 10 / 255, alpha: 1)
    static let proxyColor = UIColor(red: 190 / 255, green: 130 / 255, blue: 1, alpha: 1)

    static func notionalText(_ value: Double) -> String {
        guard value != 0 else { return "$0" }
        let magnitude = abs(value)
        let sign = value < 0 ? "-" : "+"
        switch magnitude {
        case 1_000_000_000...:
            return String(format: "%@$%.1fB", sign, rounded(magnitude / 1_000_000_000, digits: 1))
        case 1_000_000...:
            return String(format: "%@$%.1fM", sign, rounded(magnitude / 1_000_000, digits: 1))
        case 1_000...:
            return String(format: "%@$%.0fK", sign, rounded(magnitude / 1_000, digits: 0))
        default:
            return String(format: "%@$%.0f", sign, magnitude)
        }
    }

    private static func optionalNotionalText(_ value: Double?) -> String {
        value.map(notionalText) ?? "unavailable"
    }

    private static func rounded(_ value: Double, digits: Int) -> Double {
        let factor = pow(10, Double(digits))
        return (value * factor).rounded(.toNearestOrAwayFromZero) / factor
    }

    static func magnitudeFraction(value: Double, maximum: Double) -> Double {
        guard maximum > 0, maximum.isFinite, value.isFinite else { return 0 }
        return min(1, sqrt(abs(value) / maximum))
    }

    static func profileNormalization(
        for strikes: [OptionsAnalyticsStrikeDTO]
    ) -> OptionsAnalyticsProfileNormalization {
        let legs = strikes.flatMap { [$0.call, $0.put].compactMap({ $0 }) }
        return OptionsAnalyticsProfileNormalization(
            gammaExposure: legs.lazy.compactMap(\.gammaExposure).map(abs).max() ?? 0,
            markedOiValue: legs.lazy.compactMap(\.markedOiValue).max() ?? 0
        )
    }

    static func selectedProfileStrikes(
        strikes: [OptionsAnalyticsStrikeDTO],
        spot: Double,
        settings: OptionsAnalyticsSettings,
        isVisible: (OptionsAnalyticsStrikeDTO) -> Bool = { _ in true }
    ) -> [OptionsAnalyticsStrikeDTO] {
        let gammaValues = strikes.compactMap(\.grossGammaExposure)
        let markedOiValues = strikes.map(markedOiScore)
        let maximumGamma = gammaValues.max() ?? 0
        let maximumMarkedOi = markedOiValues.max() ?? 0
        let liquidityMetrics: [(OptionsAnalyticsStrikeDTO) -> Double] = [
            quoteSizeScore,
            openInterestScore,
            volumeScore,
            relativeSpreadScore,
            roundTripScore,
        ]
        let liquidityMetricRanges = liquidityMetrics.map { metric in
            let values = strikes.lazy.map(metric)
            return (minimum: values.min() ?? 0, maximum: values.max() ?? 0)
        }

        func normalizedScore(_ strike: OptionsAnalyticsStrikeDTO) -> Double {
            var scores: [Double] = []
            if settings.showGammaProfile {
                scores.append(maximumGamma > 0 ? (strike.grossGammaExposure ?? 0) / maximumGamma : 0)
            }
            if settings.showMarkedOi {
                scores.append(maximumMarkedOi > 0 ? markedOiScore(strike) / maximumMarkedOi : 0)
            }
            if settings.showLiquidity {
                let liquidityScores = liquidityMetrics.enumerated().map { index, metric in
                    let range = liquidityMetricRanges[index]
                    let width = range.maximum - range.minimum
                    return width > 0 ? (metric(strike) - range.minimum) / width : 0
                }
                scores.append(liquidityScores.max() ?? 0)
            }
            return scores.max() ?? 0
        }

        let candidates = strikes.filter(isVisible)
        return Array(
            candidates.sorted { left, right in
                let leftScore = normalizedScore(left)
                let rightScore = normalizedScore(right)
                if leftScore != rightScore { return leftScore > rightScore }
                let leftDistance = abs(left.strike - spot)
                let rightDistance = abs(right.strike - spot)
                if leftDistance != rightDistance { return leftDistance < rightDistance }
                return left.strike < right.strike
            }.prefix(settings.profileStrikeCount)
        ).sorted { $0.strike < $1.strike }
    }

    static func legDetails(
        side: String,
        leg: OptionsAnalyticsLegDTO
    ) -> [OptionsAnalyticsLegDetail] {
        [
            OptionsAnalyticsLegDetail(label: "\(side) open interest", value: "\(leg.openInterest)"),
            OptionsAnalyticsLegDetail(label: "\(side) volume", value: "\(leg.volume)"),
            OptionsAnalyticsLegDetail(
                label: "\(side) implied volatility",
                value: leg.impliedVolatility.map { String(format: "%.1f%%", $0 * 100) }
                    ?? "Unavailable"
            ),
            OptionsAnalyticsLegDetail(
                label: "\(side) delta",
                value: leg.delta.map { String(format: "%.4f", $0) } ?? "Unavailable"
            ),
            OptionsAnalyticsLegDetail(
                label: "\(side) gamma per $1 move",
                value: leg.gamma.map { String(format: "%.6f", $0) } ?? "Unavailable"
            ),
            OptionsAnalyticsLegDetail(
                label: "\(side) gamma exposure per 1% move",
                value: leg.gammaExposure.map(notionalText) ?? "Unavailable"
            ),
            OptionsAnalyticsLegDetail(
                label: "\(side) delta notional",
                value: leg.deltaNotional.map(notionalText) ?? "Unavailable"
            ),
            OptionsAnalyticsLegDetail(
                label: "\(side) quote sizes",
                value: "\(leg.bidSize) bid / \(leg.askSize) ask"
            ),
            OptionsAnalyticsLegDetail(
                label: "\(side) relative spread",
                value: leg.relativeSpread.map { String(format: "%.1f%%", $0 * 100) } ?? "Unavailable"
            ),
            OptionsAnalyticsLegDetail(
                label: "\(side) per-contract round trip",
                value: leg.roundTripCost.map { String(format: "$%.2f", $0) } ?? "Unavailable"
            ),
            OptionsAnalyticsLegDetail(
                label: "\(side) marked OI value",
                value: leg.markedOiValue.map(notionalText) ?? "Unavailable"
            ),
        ]
    }

    private static func markedOiScore(_ strike: OptionsAnalyticsStrikeDTO) -> Double {
        (strike.call?.markedOiValue ?? 0) + (strike.put?.markedOiValue ?? 0)
    }

    private static func quoteSizeScore(_ strike: OptionsAnalyticsStrikeDTO) -> Double {
        let callSize = (strike.call?.bidSize ?? 0) + (strike.call?.askSize ?? 0)
        let putSize = (strike.put?.bidSize ?? 0) + (strike.put?.askSize ?? 0)
        return Double(callSize + putSize)
    }

    private static func openInterestScore(_ strike: OptionsAnalyticsStrikeDTO) -> Double {
        Double((strike.call?.openInterest ?? 0) + (strike.put?.openInterest ?? 0))
    }

    private static func volumeScore(_ strike: OptionsAnalyticsStrikeDTO) -> Double {
        Double((strike.call?.volume ?? 0) + (strike.put?.volume ?? 0))
    }

    private static func relativeSpreadScore(_ strike: OptionsAnalyticsStrikeDTO) -> Double {
        max(strike.call?.relativeSpread ?? 0, strike.put?.relativeSpread ?? 0)
    }

    private static func roundTripScore(_ strike: OptionsAnalyticsStrikeDTO) -> Double {
        max(strike.call?.roundTripCost ?? 0, strike.put?.roundTripCost ?? 0)
    }

    static func railWidth(for paneWidth: Double) -> Double {
        min(112, max(56, paneWidth / 100 * 28))
    }

    static func accessibilitySummary(
        snapshot: OptionsAnalyticsSnapshotDTO,
        settings: OptionsAnalyticsSettings,
        now: Date = Date()
    ) -> String {
        let quality = snapshot.quality
        var parts = [
            "Options Structure \(snapshot.scope.symbol) expiration \(snapshot.scope.expiration)",
            "Root \(snapshot.scope.rootSymbol), \(snapshot.scope.settlementStyle.rawValue.uppercased()) settlement",
            "Spot \(priceText(snapshot.scope.spot)), forward \(priceText(snapshot.scope.forward))",
            "Call gamma \(optionalNotionalText(snapshot.structure.callGammaExposure))",
            "Put gamma \(optionalNotionalText(snapshot.structure.putGammaExposure))",
            "Gross gamma \(optionalNotionalText(snapshot.structure.grossGammaExposure))",
            "Call delta notional \(optionalNotionalText(snapshot.structure.callDeltaNotional))",
            "Put delta notional \(optionalNotionalText(snapshot.structure.putDeltaNotional))",
            snapshot.exposureUnit,
            "\(quality.status.rawValue) status",
            "Coverage \(quality.coverage.contractsIncluded) of \(quality.coverage.contractsTotal) contracts, "
                + "\(Int((quality.coverage.ratio * 100).rounded()))%",
            "\(quality.feedMode.rawValue) feed",
            "Cache \(quality.cacheStatus.rawValue)",
            "calculation \(quality.calculationVersion)",
            "OI effective \(quality.oiEffectiveDate ?? "unavailable")",
        ]
        appendAge(named: "observed", timestamp: snapshot.scope.observedAt, now: now, to: &parts)
        appendAge(named: "quote", timestamp: quality.quoteAsOf, now: now, to: &parts)
        appendAge(named: "Greeks", timestamp: quality.greeksAsOf, now: now, to: &parts)
        appendSettlement(snapshot.scope.settlementAt, now: now, to: &parts)
        if let range = snapshot.impliedRange, settings.showImpliedRange {
            parts.append(
                "\(range.label) \(priceText(range.lower)) to \(priceText(range.upper))"
            )
            parts.append(
                "straddle breakevens \(priceText(range.straddleLower)) to \(priceText(range.straddleUpper))"
            )
        }
        if let wall = snapshot.structure.callWall {
            parts.append("Call wall \(priceText(wall))")
        }
        if let wall = snapshot.structure.putWall {
            parts.append("Put wall \(priceText(wall))")
        }
        if let strike = snapshot.structure.maxOpenInterestStrike {
            parts.append("Max OI strike \(priceText(strike))")
        }
        if let concentration = snapshot.structure.grossGammaConcentration {
            parts.append("Gross gamma concentration \(Int((concentration * 100).rounded()))%")
        }
        let legs = snapshot.strikes.flatMap { [$0.call, $0.put].compactMap({ $0 }) }
        if settings.showGammaProfile {
            let callLegs = snapshot.strikes.lazy.filter { $0.call != nil }.count
            let putLegs = snapshot.strikes.lazy.filter { $0.put != nil }.count
            parts.append("Gamma profile, \(callLegs) call legs and \(putLegs) put legs")
        }
        if settings.showMarkedOi {
            let markedCount = legs.lazy.filter { $0.markedOiValue != nil }.count
            parts.append("Marked open interest layer, \(markedCount) contracts")
        }
        if settings.showLiquidity {
            let liquidityCount = legs.lazy.filter {
                $0.relativeSpread != nil || $0.roundTripCost != nil
            }.count
            parts.append("Liquidity layer, \(liquidityCount) contracts")
        }
        if settings.showDealerProxy, let proxy = snapshot.scenarios.callPutDealerProxy {
            parts.append("Assumption: \(proxy.assumption)")
            let roots = proxy.gammaRoots.isEmpty
                ? "unavailable"
                : proxy.gammaRoots.map(priceText).joined(separator: ", ")
            parts.append("Proxy roots \(roots)")
        }
        parts.append(contentsOf: quality.warnings.map { "Warning: \($0)" })
        return parts.joined(separator: ". ")
    }

    private static func appendAge(
        named name: String,
        timestamp: String?,
        now: Date,
        to parts: inout [String]
    ) {
        guard let timestamp,
              let date = DateParsing.dateTime(timestamp)
        else { return }
        let seconds = max(0, Int(now.timeIntervalSince(date).rounded()))
        parts.append("\(name) source \(timestamp), current age \(seconds) seconds")
        if name == "quote" {
            parts.append("quote age \(seconds) seconds")
        } else if name == "Greeks" {
            parts.append("Greek age \(seconds) seconds")
        }
    }

    private static func appendSettlement(
        _ timestamp: String,
        now: Date,
        to parts: inout [String]
    ) {
        guard let settlement = DateParsing.dateTime(timestamp) else { return }
        let interval = Int(settlement.timeIntervalSince(now).rounded())
        if interval >= 0 {
            parts.append("Settlement \(timestamp), in \(interval) seconds")
        } else {
            parts.append("Settlement \(timestamp), passed \(-interval) seconds ago")
        }
    }

    private static func priceText(_ value: Double) -> String {
        String(format: "%.2f", value)
    }
}
