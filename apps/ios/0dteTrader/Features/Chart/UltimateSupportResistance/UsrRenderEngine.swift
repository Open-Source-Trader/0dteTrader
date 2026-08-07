import Foundation

/// Pure event simulator mirroring computeUsr.ts and the confirmed-bar Pine
/// state machine. No UIKit/SwiftUI dependencies belong in this layer.
extension UsrEngine {
    struct ConfluencePartition {
        let groups: [UsrConfluence]
        let fill: String
        let border: String
        let cumulativeBudget: Int
    }

    static func proximity(_ runtime: Runtime, top: Double, bottom: Double, reference: Double) -> Bool {
        guard runtime.settings.enableProximityFilter, reference != 0 else { return true }
        let percent = runtime.settings.proximityPercent / 100
        let low = min(reference * (1 - percent), reference * (1 + percent))
        let high = max(reference * (1 - percent), reference * (1 + percent))
        return !(bottom > high || top < low)
    }

    static func signalColor(_ signal: UsrSignal) -> String {
        if signal.bullish {
            return signal.kind == .sweep ? Constants.bullishSweep : Constants.bullishBounce
        }
        return signal.kind == .sweep ? Constants.bearishSweep : Constants.bearishBounce
    }

    static func fvgLabel(_ runtime: Runtime, _ fvg: UsrFvg) -> TwcLabel {
        let inverse = fvg.ifvgAnalysisBirth > 0
        let active = inverse ? fvg.ifvgActive : fvg.isActive
        let sign = inverse
            ? (fvg.direction == .bullish ? "-" : "+")
            : (fvg.direction == .bullish ? "+" : "-")
        var text = "\(inverse ? "IFVG" : "FVG")\(sign)"
        if !inverse && active && fvg.milestoneReached { text += " M" }
        if !active {
            text += fvg.lifecycle == .expired ? " EXPIRED" : inverse ? " INVALID" : " FILLED"
        }
        let start = inverse
            ? runtime.analysis[fvg.ifvgAnalysisBirth].eventChartIndex
            : fvg.startBar
        return TwcLabel(barIndex: Double(start), price: fvg.ce, text: text,
                        textColor: "rgba(255, 255, 255, 0.65)", align: .left)
    }

    static func visibleFvgs(_ records: [UsrFvg], maximum: Int) -> [UsrFvg] {
        Array(records.filter(\.visualVisible).prefix(maximum))
    }

    static func render(_ runtime: Runtime, lastBar: Int, reference: Double) -> ScriptRenderModel {
        let flippedOrigins = runtime.settings.showFlippedOrigins && runtime.settings.enableSrFlip
        let allBroken = runtime.settings.showAllBrokenLevels && !flippedOrigins
        let eligibleZones = (runtime.support + runtime.resistance).filter { zone in
            let mature = zone.isFlipped || runtime.analysisBarId - zone.analysisBirth >= Constants.minimumAge
            let invalid = !zone.isActive && (allBroken || (flippedOrigins && zone.hasActiveFlippedChild))
            let pooled = runtime.settings.showLiquidityPools && runtime.settings.hidePooledLines
                && zone.inPool && !zone.isFlipped
            return mature && !pooled && (zone.isActive || invalid)
                && proximity(runtime, top: zone.top, bottom: zone.bottom, reference: reference)
        }
        let zones = stablePriorityPrefix(
            eligibleZones, maximum: Constants.maximumZoneLines, rankOnlyWhenCapped: false
        ) {
            ($0.isActive ? 2.0 : 0.0) + recencyAdjustedPriority(
                strength($0, runtime.analysisBarId),
                start: $0.activationBar > 0 ? $0.activationBar : $0.startBar,
                currentChartBar: lastBar
            )
        }
        var segments = zones.map { zone in
            TwcSegment(
                x1: Double(max(0, zone.activationBar)),
                y1: zone.isSupport ? zone.top : zone.bottom,
                x2: Double(zone.isActive ? lastBar + 20 : max(zone.endBar, zone.activationBar)),
                y2: zone.isSupport ? zone.top : zone.bottom,
                color: zone.isSupport
                    ? (zone.isFlipped ? Constants.flippedSupport : Constants.support)
                    : (zone.isFlipped ? Constants.flippedResistance : Constants.resistance),
                width: 2,
                style: zone.isActive ? .solid : .dashed
            )
        }
        var bands: [TwcBand] = []
        if runtime.settings.showConfluence {
            let partitions = [
                ConfluencePartition(groups: runtime.supportConfluence,
                    fill: Constants.confluenceSupport,
                    border: Constants.confluenceSupportBorder, cumulativeBudget: 20),
                ConfluencePartition(groups: runtime.resistanceConfluence,
                    fill: Constants.confluenceResistance,
                    border: Constants.confluenceResistanceBorder, cumulativeBudget: 40),
                ConfluencePartition(groups: runtime.mixedConfluence,
                    fill: Constants.confluenceMixed,
                    border: Constants.confluenceMixedBorder, cumulativeBudget: 60)
            ]
            for partition in partitions {
                let remaining = max(0, partition.cumulativeBudget - bands.count)
                bands += partition.groups.filter {
                    proximity(runtime, top: $0.top, bottom: $0.bottom, reference: reference)
                }
                    .prefix(remaining)
                    .map { TwcBand(x1: Double($0.startBar), x2: Double(lastBar + 20),
                                   yTop: $0.top, yBottom: $0.bottom,
                                   fillColor: partition.fill, borderColor: partition.border,
                                   borderWidth: $0.isMixed ? 2 : 1, borderStyle: .dotted) }
            }
        }
        if runtime.settings.showLiquidityPools {
            bands += (runtime.supportPools + runtime.resistancePools)
                .filter { proximity(runtime, top: $0.top, bottom: $0.bottom, reference: reference) }
                .map { pool in
                    let base = pool.isSupport ? Constants.supportBase : Constants.resistanceBase
                    let opacity = pool.state == .anticipated ? 0.15 : pool.state == .validated ? 0.3 : 0.35
                    let border = pool.state == .swept
                        ? Constants.poolSweptBorder
                        : ScriptColor.withOpacity(base, 0.5)
                    return TwcBand(x1: Double(pool.startBar), x2: Double(lastBar + 20),
                        yTop: pool.top, yBottom: pool.bottom,
                        fillColor: ScriptColor.withOpacity(base, opacity), borderColor: border)
                }
        }
        var labels: [TwcLabel] = []
        if runtime.settings.showFvg {
            let visible = visibleFvgs(runtime.bullishFvgs, maximum: runtime.settings.maxVisibleFvgs)
                + visibleFvgs(runtime.bearishFvgs, maximum: runtime.settings.maxVisibleFvgs)
            for fvg in visible {
                let inverse = fvg.ifvgAnalysisBirth > 0
                let start = inverse
                    ? runtime.analysis[fvg.ifvgAnalysisBirth].eventChartIndex : fvg.startBar
                let active = inverse ? fvg.ifvgActive : fvg.isActive
                let end = active ? lastBar
                    : inverse ? (fvg.ifvgEndBar == 0 ? lastBar : fvg.ifvgEndBar)
                    : (fvg.endBar == 0 ? lastBar : fvg.endBar)
                let color = inverse
                    ? (fvg.direction == .bullish ? runtime.settings.ifvgBearishColor : runtime.settings.ifvgBullishColor)
                    : (fvg.direction == .bullish ? runtime.settings.fvgBullishColor : runtime.settings.fvgBearishColor)
                let border: String
                if active && !inverse && fvg.milestoneReached {
                    border = ScriptColor.withOpacity(runtime.settings.fvgCeColor, 0.75)
                } else if active {
                    border = ScriptColor.withOpacity(color, 0.5)
                } else {
                    border = ScriptColor.withOpacity(color, 0.25)
                }
                bands.append(TwcBand(x1: Double(start), x2: Double(end),
                    yTop: fvg.top, yBottom: fvg.bottom,
                    fillColor: active ? color : ScriptColor.withOpacity(color, 0.08),
                    borderColor: border,
                    borderWidth: !inverse && active && fvg.milestoneReached ? 2 : 1,
                    borderStyle: active ? .solid : .dotted))
                if runtime.settings.showFvgCe {
                    segments.append(TwcSegment(x1: Double(start), y1: fvg.ce,
                        x2: Double(end), y2: fvg.ce,
                        color: active ? runtime.settings.fvgCeColor
                            : ScriptColor.withOpacity(runtime.settings.fvgCeColor, 0.15),
                        width: 1, style: .dotted))
                }
                if runtime.settings.showFvgLabels {
                    labels.append(fvgLabel(runtime, fvg))
                }
            }
        }
        let both = runtime.settings.showBounceSignals && runtime.settings.showSweepSignals
        let bounceLimit = both ? Int(ceil(Double(runtime.settings.maxRecentSignalsTotal) / 2))
            : runtime.settings.showBounceSignals ? runtime.settings.maxRecentSignalsTotal : 0
        let sweepLimit = both ? runtime.settings.maxRecentSignalsTotal - bounceLimit
            : runtime.settings.showSweepSignals ? runtime.settings.maxRecentSignalsTotal : 0
        let selectedSignals = Array(runtime.signals.filter { $0.kind == .bounce }.suffix(bounceLimit))
            + Array(runtime.signals.filter { $0.kind == .sweep }.suffix(sweepLimit))
        let markers = selectedSignals.sorted { $0.chartBarIndex < $1.chartBarIndex }.map { signal in
            let color = signalColor(signal)
            return TwcMarker(
                barIndex: signal.chartBarIndex,
                placement: signal.bullish ? .belowBar : .aboveBar,
                shape: signal.bullish ? .labelUp : .labelDown,
                color: ScriptColor.withOpacity(color, 0.2),
                sizeTiny: true,
                text: signal.kind == .sweep ? "S" : "B",
                textColor: color
            )
        }
        return ScriptRenderModel(candleColors: nil, markers: markers, lines: [], fills: [],
                              segments: segments, bands: bands, labels: labels, banner: nil)
    }
}
