import Foundation

/// Pure event simulator mirroring computeUsr.ts and the confirmed-bar Pine
/// state machine. No UIKit/SwiftUI dependencies belong in this layer.
extension UsrEngine {
    enum SignalReference {
        case supportZone(Int), resistanceZone(Int)
        case supportPool(Int), resistancePool(Int)
        case bullishFvg(Int), bearishFvg(Int)
    }

    struct Candidate {
        let bullish: Bool
        let kind: UsrSignalKind
        let score: Double
        let price: Double
        let stop: Double
        let source: UsrSignalSource
        let sourceKey: String
        let reference: SignalReference
    }

    struct CandidateDraft {
        let bullish: Bool
        let kind: UsrSignalKind
        let baseScore: Double
        let price: Double
        let stop: Double
        let source: UsrSignalSource
        let key: String
        let reference: SignalReference
    }

    static func confluenceCount(_ runtime: Runtime, zone: UsrZone) -> Int {
        let groups = zone.isSupport ? runtime.supportConfluence : runtime.resistanceConfluence
        return groups.filter { $0.memberIds.contains(zone.id) }.map(\.memberIds.count).max() ?? 1
    }

    static func fvgStrength(_ runtime: Runtime, fvg: UsrFvg, inverse: Bool) -> Double {
        let birth = inverse ? fvg.ifvgAnalysisBirth : fvg.analysisBirth
        let age = 1 / (1 + Double(max(runtime.analysisBarId - birth, 0)) / 500)
        let lifecycle: Double = inverse ? 1
            : fvg.lifecycle == .partial ? 0.9
            : fvg.lifecycle == .ce ? 0.78
            : fvg.lifecycle == .wickFilled ? 0.65 : 1
        return (inverse ? 0.8 : 0.75) * lifecycle * age
    }

    static func eligible(_ runtime: Runtime, reference: SignalReference, kind: UsrSignalKind) -> Bool {
        func check(_ bounce: Int, _ sweep: Int, _ lastBounce: Int, _ lastSweep: Int) -> Bool {
            (kind == .bounce ? bounce : sweep) < Constants.maximumSignals
                && (kind == .bounce ? lastBounce : lastSweep) != runtime.analysisBarId
        }
        switch reference {
        case .supportZone(let index):
            if runtime.support[index].lastBounceSignalBar > 0,
               runtime.analysisBarId - runtime.support[index].lastBounceSignalBar > Constants.signalCooldown {
                runtime.support[index].bounceSignalCount = 0
            }
            if runtime.support[index].lastSweepSignalBar > 0,
               runtime.analysisBarId - runtime.support[index].lastSweepSignalBar > Constants.signalCooldown {
                runtime.support[index].sweepSignalCount = 0
            }
            let value = runtime.support[index]
            return check(value.bounceSignalCount, value.sweepSignalCount,
                         value.lastBounceSignalBar, value.lastSweepSignalBar)
        case .resistanceZone(let index):
            if runtime.resistance[index].lastBounceSignalBar > 0,
               runtime.analysisBarId - runtime.resistance[index].lastBounceSignalBar > Constants.signalCooldown {
                runtime.resistance[index].bounceSignalCount = 0
            }
            if runtime.resistance[index].lastSweepSignalBar > 0,
               runtime.analysisBarId - runtime.resistance[index].lastSweepSignalBar > Constants.signalCooldown {
                runtime.resistance[index].sweepSignalCount = 0
            }
            let value = runtime.resistance[index]
            return check(value.bounceSignalCount, value.sweepSignalCount,
                         value.lastBounceSignalBar, value.lastSweepSignalBar)
        case .supportPool(let index):
            return poolEligible(runtime, support: true, index: index, kind: kind)
        case .resistancePool(let index):
            return poolEligible(runtime, support: false, index: index, kind: kind)
        case .bullishFvg(let index):
            return fvgEligible(runtime, bullish: true, index: index, kind: kind)
        case .bearishFvg(let index):
            return fvgEligible(runtime, bullish: false, index: index, kind: kind)
        }
    }

    static func poolEligible(_ runtime: Runtime, support: Bool, index: Int, kind: UsrSignalKind) -> Bool {
        if support {
            if runtime.supportPools[index].lastBounceSignalAnalysisBar > 0,
               runtime.analysisBarId - runtime.supportPools[index].lastBounceSignalAnalysisBar > Constants.signalCooldown {
                runtime.supportPools[index].bounceSignalCount = 0
            }
            if runtime.supportPools[index].lastSweepSignalAnalysisBar > 0,
               runtime.analysisBarId - runtime.supportPools[index].lastSweepSignalAnalysisBar > Constants.signalCooldown {
                runtime.supportPools[index].sweepSignalCount = 0
            }
            let value = runtime.supportPools[index]
            return (kind == .bounce ? value.bounceSignalCount : value.sweepSignalCount) < Constants.maximumSignals
                && (kind == .bounce ? value.lastBounceSignalAnalysisBar : value.lastSweepSignalAnalysisBar) != runtime.analysisBarId
        }
        if runtime.resistancePools[index].lastBounceSignalAnalysisBar > 0,
           runtime.analysisBarId - runtime.resistancePools[index].lastBounceSignalAnalysisBar > Constants.signalCooldown {
            runtime.resistancePools[index].bounceSignalCount = 0
        }
        if runtime.resistancePools[index].lastSweepSignalAnalysisBar > 0,
           runtime.analysisBarId - runtime.resistancePools[index].lastSweepSignalAnalysisBar > Constants.signalCooldown {
            runtime.resistancePools[index].sweepSignalCount = 0
        }
        let value = runtime.resistancePools[index]
        return (kind == .bounce ? value.bounceSignalCount : value.sweepSignalCount) < Constants.maximumSignals
            && (kind == .bounce ? value.lastBounceSignalAnalysisBar : value.lastSweepSignalAnalysisBar) != runtime.analysisBarId
    }

    static func fvgEligible(_ runtime: Runtime, bullish: Bool, index: Int, kind: UsrSignalKind) -> Bool {
        if bullish {
            if runtime.bullishFvgs[index].lastBounceSignalAnalysisBar > 0,
               runtime.analysisBarId - runtime.bullishFvgs[index].lastBounceSignalAnalysisBar > Constants.signalCooldown {
                runtime.bullishFvgs[index].bounceSignalCount = 0
            }
            if runtime.bullishFvgs[index].lastSweepSignalAnalysisBar > 0,
               runtime.analysisBarId - runtime.bullishFvgs[index].lastSweepSignalAnalysisBar > Constants.signalCooldown {
                runtime.bullishFvgs[index].sweepSignalCount = 0
            }
            let value = runtime.bullishFvgs[index]
            return (kind == .bounce ? value.bounceSignalCount : value.sweepSignalCount) < Constants.maximumSignals
                && (kind == .bounce ? value.lastBounceSignalAnalysisBar : value.lastSweepSignalAnalysisBar) != runtime.analysisBarId
        }
        if runtime.bearishFvgs[index].lastBounceSignalAnalysisBar > 0,
           runtime.analysisBarId - runtime.bearishFvgs[index].lastBounceSignalAnalysisBar > Constants.signalCooldown {
            runtime.bearishFvgs[index].bounceSignalCount = 0
        }
        if runtime.bearishFvgs[index].lastSweepSignalAnalysisBar > 0,
           runtime.analysisBarId - runtime.bearishFvgs[index].lastSweepSignalAnalysisBar > Constants.signalCooldown {
            runtime.bearishFvgs[index].sweepSignalCount = 0
        }
        let value = runtime.bearishFvgs[index]
        return (kind == .bounce ? value.bounceSignalCount : value.sweepSignalCount) < Constants.maximumSignals
            && (kind == .bounce ? value.lastBounceSignalAnalysisBar : value.lastSweepSignalAnalysisBar) != runtime.analysisBarId
    }

    static func candidate(_ draft: CandidateDraft) -> Candidate {
        Candidate(bullish: draft.bullish, kind: draft.kind,
                  score: draft.baseScore + (draft.kind == .sweep ? 0.1 : 0),
                  price: draft.price, stop: draft.stop, source: draft.source,
                  sourceKey: draft.key, reference: draft.reference)
    }

    static func best(_ current: Candidate?, _ next: Candidate) -> Candidate {
        guard let current else { return next }
        return next.score > current.score ? next : current
    }

    static func preferred(_ sweep: Candidate?, _ bounce: Candidate?) -> Candidate? {
        guard let sweep else { return bounce }
        guard let bounce else { return sweep }
        return sweep.score >= bounce.score ? sweep : bounce
    }

    static func collectZones(
        _ runtime: Runtime,
        bullish: Bool,
        setup: Candle,
        tolerance: Double,
        epsilon: Double,
        bounce: inout Candidate?,
        sweep: inout Candidate?
    ) {
        let zones = bullish ? runtime.support : runtime.resistance
        for index in zones.indices {
            let zone = zones[index]
            let age = runtime.analysisBarId - zone.analysisBirth
            guard zone.isActive, age >= Constants.minimumAge, !zone.isFlipped || age >= Constants.minimumAge else { continue }
            let reference: SignalReference = bullish ? .supportZone(index) : .resistanceZone(index)
            let swept = bullish
                ? below(runtime, setup.low, zone.bottom) && above(runtime, setup.close, zone.top)
                : above(runtime, setup.high, zone.top) && below(runtime, setup.close, zone.bottom)
            let bounced = bullish
                ? !swept && setup.low <= zone.top + tolerance && setup.low >= zone.bottom - tolerance
                    && setup.close >= zone.top - epsilon
                : !swept && setup.high >= zone.bottom - tolerance && setup.high <= zone.top + tolerance
                    && setup.close <= zone.bottom + epsilon
            let score = strength(zone, runtime.analysisBarId)
                * (1 + 0.2 * Double(confluenceCount(runtime, zone: zone) - 1))
            if runtime.settings.showSweepSignals && swept && eligible(runtime, reference: reference, kind: .sweep) {
                sweep = best(sweep, candidate(CandidateDraft(
                    bullish: bullish, kind: .sweep, baseScore: score,
                    price: bullish ? zone.bottom : zone.top, stop: bullish ? setup.low : setup.high,
                    source: .zone, key: String(zone.id), reference: reference
                )))
            } else if runtime.settings.showBounceSignals && bounced
                        && eligible(runtime, reference: reference, kind: .bounce) {
                bounce = best(bounce, candidate(CandidateDraft(
                    bullish: bullish, kind: .bounce, baseScore: score,
                    price: bullish ? zone.top : zone.bottom, stop: bullish ? setup.low : setup.high,
                    source: .zone, key: String(zone.id), reference: reference
                )))
            }
        }
    }

    static func collectPools(
        _ runtime: Runtime,
        bullish: Bool,
        setup: Candle,
        epsilon: Double,
        bounce: inout Candidate?,
        sweep: inout Candidate?
    ) {
        guard runtime.settings.showLiquidityPools else { return }
        let pools = bullish ? runtime.supportPools : runtime.resistancePools
        for index in pools.indices {
            let pool = pools[index]
            guard runtime.analysisBarId - pool.analysisBirth >= Constants.minimumAge else { continue }
            let reference: SignalReference = bullish ? .supportPool(index) : .resistancePool(index)
            let swept = bullish
                ? below(runtime, setup.low, pool.bottom) && above(runtime, setup.close, pool.top)
                : above(runtime, setup.high, pool.top) && below(runtime, setup.close, pool.bottom)
            let bounced = bullish
                ? !swept && setup.low <= pool.top + epsilon && setup.low >= pool.bottom - epsilon
                    && setup.close >= pool.top - epsilon
                : !swept && setup.high >= pool.bottom - epsilon && setup.high <= pool.top + epsilon
                    && setup.close <= pool.bottom + epsilon
            if runtime.settings.showSweepSignals && swept && eligible(runtime, reference: reference, kind: .sweep) {
                sweep = best(sweep, candidate(CandidateDraft(
                    bullish: bullish, kind: .sweep, baseScore: pool.strength,
                    price: bullish ? pool.bottom : pool.top, stop: bullish ? setup.low : setup.high,
                    source: .pool, key: pool.id, reference: reference
                )))
            } else if runtime.settings.showBounceSignals && bounced
                        && eligible(runtime, reference: reference, kind: .bounce) {
                bounce = best(bounce, candidate(CandidateDraft(
                    bullish: bullish, kind: .bounce, baseScore: pool.strength,
                    price: bullish ? pool.top : pool.bottom, stop: bullish ? setup.low : setup.high,
                    source: .pool, key: pool.id, reference: reference
                )))
            }
        }
    }

    static func collectFvgs(
        _ runtime: Runtime,
        bullish: Bool,
        setup: Candle,
        epsilon: Double,
        bounce: inout Candidate?,
        sweep: inout Candidate?
    ) {
        guard runtime.settings.showFvg else { return }
        func collect(
            _ fvg: UsrFvg,
            index: Int,
            ownerBullish: Bool,
            inverse: Bool,
            bounce localBounce: inout Candidate?,
            sweep localSweep: inout Candidate?
        ) {
            let birth = inverse ? fvg.ifvgAnalysisBirth : fvg.analysisBirth
            guard runtime.analysisBarId - birth >= Constants.minimumAge else { return }
            let reference: SignalReference = ownerBullish ? .bullishFvg(index) : .bearishFvg(index)
            let swept = bullish
                ? below(runtime, setup.low, fvg.bottom) && above(runtime, setup.close, fvg.top)
                : above(runtime, setup.high, fvg.top) && below(runtime, setup.close, fvg.bottom)
            let bounced = bullish
                ? !swept && setup.low <= fvg.top + epsilon && setup.low >= fvg.bottom - epsilon
                    && setup.close >= fvg.top - epsilon
                : !swept && setup.high >= fvg.bottom - epsilon && setup.high <= fvg.top + epsilon
                    && setup.close <= fvg.bottom + epsilon
            let source: UsrSignalSource = inverse ? .ifvg : .fvg
            let score = fvgStrength(runtime, fvg: fvg, inverse: inverse)
            if runtime.settings.showSweepSignals && swept && eligible(runtime, reference: reference, kind: .sweep) {
                localSweep = best(localSweep, candidate(CandidateDraft(
                    bullish: bullish, kind: .sweep, baseScore: score,
                    price: bullish ? fvg.bottom : fvg.top, stop: bullish ? setup.low : setup.high,
                    source: source, key: fvg.id, reference: reference
                )))
            } else if runtime.settings.showBounceSignals && bounced
                        && eligible(runtime, reference: reference, kind: .bounce) {
                localBounce = best(localBounce, candidate(CandidateDraft(
                    bullish: bullish, kind: .bounce, baseScore: score,
                    price: bullish ? fvg.top : fvg.bottom, stop: bullish ? setup.low : setup.high,
                    source: source, key: fvg.id, reference: reference
                )))
            }
        }
        if bullish {
            for index in runtime.bullishFvgs.indices where runtime.bullishFvgs[index].isActive {
                collect(runtime.bullishFvgs[index], index: index, ownerBullish: true, inverse: false,
                        bounce: &bounce, sweep: &sweep)
            }
            for index in runtime.bearishFvgs.indices where runtime.bearishFvgs[index].ifvgActive {
                collect(runtime.bearishFvgs[index], index: index, ownerBullish: false, inverse: true,
                        bounce: &bounce, sweep: &sweep)
            }
        } else {
            for index in runtime.bearishFvgs.indices where runtime.bearishFvgs[index].isActive {
                collect(runtime.bearishFvgs[index], index: index, ownerBullish: false, inverse: false,
                        bounce: &bounce, sweep: &sweep)
            }
            for index in runtime.bullishFvgs.indices where runtime.bullishFvgs[index].ifvgActive {
                collect(runtime.bullishFvgs[index], index: index, ownerBullish: true, inverse: true,
                        bounce: &bounce, sweep: &sweep)
            }
        }
    }

    static func commit(_ runtime: Runtime, _ candidate: Candidate, chartIndex: Int) -> UsrSignal {
        switch candidate.reference {
        case .supportZone(let index):
            if candidate.kind == .sweep {
                runtime.support[index].sweepSignalCount += 1
                runtime.support[index].lastSweepSignalBar = runtime.analysisBarId
            } else {
                runtime.support[index].bounceSignalCount += 1
                runtime.support[index].lastBounceSignalBar = runtime.analysisBarId
            }
        case .resistanceZone(let index):
            if candidate.kind == .sweep {
                runtime.resistance[index].sweepSignalCount += 1
                runtime.resistance[index].lastSweepSignalBar = runtime.analysisBarId
            } else {
                runtime.resistance[index].bounceSignalCount += 1
                runtime.resistance[index].lastBounceSignalBar = runtime.analysisBarId
            }
        case .supportPool(let index):
            if candidate.kind == .sweep {
                runtime.supportPools[index].sweepSignalCount += 1
                runtime.supportPools[index].lastSweepSignalAnalysisBar = runtime.analysisBarId
            } else {
                runtime.supportPools[index].bounceSignalCount += 1
                runtime.supportPools[index].lastBounceSignalAnalysisBar = runtime.analysisBarId
            }
        case .resistancePool(let index):
            if candidate.kind == .sweep {
                runtime.resistancePools[index].sweepSignalCount += 1
                runtime.resistancePools[index].lastSweepSignalAnalysisBar = runtime.analysisBarId
            } else {
                runtime.resistancePools[index].bounceSignalCount += 1
                runtime.resistancePools[index].lastBounceSignalAnalysisBar = runtime.analysisBarId
            }
        case .bullishFvg(let index):
            if candidate.kind == .sweep {
                runtime.bullishFvgs[index].sweepSignalCount += 1
                runtime.bullishFvgs[index].lastSweepSignalAnalysisBar = runtime.analysisBarId
            } else {
                runtime.bullishFvgs[index].bounceSignalCount += 1
                runtime.bullishFvgs[index].lastBounceSignalAnalysisBar = runtime.analysisBarId
            }
        case .bearishFvg(let index):
            if candidate.kind == .sweep {
                runtime.bearishFvgs[index].sweepSignalCount += 1
                runtime.bearishFvgs[index].lastSweepSignalAnalysisBar = runtime.analysisBarId
            } else {
                runtime.bearishFvgs[index].bounceSignalCount += 1
                runtime.bearishFvgs[index].lastBounceSignalAnalysisBar = runtime.analysisBarId
            }
        }
        let signal = UsrSignal(
            bullish: candidate.bullish, kind: candidate.kind, source: candidate.source,
            chartBarIndex: chartIndex, analysisBarId: runtime.analysisBarId,
            price: candidate.price, stop: candidate.stop, score: candidate.score,
            sourceKey: candidate.sourceKey
        )
        runtime.signals.append(signal)
        return signal
    }

    static func processSignals(
        _ runtime: Runtime,
        candles: [Candle],
        chartIndex: Int,
        chartAtr: Double
    ) {
        guard (runtime.settings.showBounceSignals || runtime.settings.showSweepSignals),
              chartIndex >= 1, runtime.analysisBarId >= 0 else { return }
        let setup = candles[chartIndex - 1]
        let confirmation = candles[chartIndex]
        let range = setup.high - setup.low
        let bodyTop = max(setup.open, setup.close)
        let bodyBottom = min(setup.open, setup.close)
        let lowerWick = range > 0 ? (bodyBottom - setup.low) / range * 100 : 0
        let upperWick = range > 0 ? (setup.high - bodyTop) / range * 100 : 0
        let baselineStart = max(0, chartIndex - 22)
        let baselineEnd = max(0, chartIndex - 1)
        let baselineSlice = candles[baselineStart..<baselineEnd]
        let baseline = baselineSlice.count == 21
            ? baselineSlice.map(\.volume).reduce(0, +) / 21
            : max(setup.volume, 1)
        let highVolume = setup.volume > baseline
        let bullQualified = !runtime.settings.signalRequireQualification || lowerWick >= 60 || highVolume
        let bearQualified = !runtime.settings.signalRequireQualification || upperWick >= 60 || highVolume
        let bullConfirmed = confirmation.low > setup.low && confirmation.close > bodyTop
            && (!runtime.settings.requireConfirmationCandleDirection || confirmation.close > confirmation.open)
        let bearConfirmed = confirmation.high < setup.high && confirmation.close < bodyBottom
            && (!runtime.settings.requireConfirmationCandleDirection || confirmation.close < confirmation.open)
        let tolerance = chartAtr * 0.1
        let epsilon = runtime.settings.minimumTick * Double(runtime.settings.breakBufferTicks)
        var bullBounce: Candidate?
        var bullSweep: Candidate?
        var bearBounce: Candidate?
        var bearSweep: Candidate?
        if bullQualified && bullConfirmed {
            collectZones(runtime, bullish: true, setup: setup, tolerance: tolerance,
                         epsilon: epsilon, bounce: &bullBounce, sweep: &bullSweep)
            collectPools(runtime, bullish: true, setup: setup, epsilon: epsilon,
                         bounce: &bullBounce, sweep: &bullSweep)
            collectFvgs(runtime, bullish: true, setup: setup, epsilon: epsilon,
                        bounce: &bullBounce, sweep: &bullSweep)
        }
        if bearQualified && bearConfirmed {
            collectZones(runtime, bullish: false, setup: setup, tolerance: tolerance,
                         epsilon: epsilon, bounce: &bearBounce, sweep: &bearSweep)
            collectPools(runtime, bullish: false, setup: setup, epsilon: epsilon,
                         bounce: &bearBounce, sweep: &bearSweep)
            collectFvgs(runtime, bullish: false, setup: setup, epsilon: epsilon,
                        bounce: &bearBounce, sweep: &bearSweep)
        }
        var bull = preferred(bullSweep, bullBounce)
        var bear = preferred(bearSweep, bearBounce)
        let conflict = max(chartAtr * 2, abs(confirmation.close) * 0.0015)
        if runtime.settings.cancelOpposingSignal, let candidate = bull, let previous = runtime.previousBear,
           abs(candidate.price - previous.price) <= conflict { bull = nil }
        if runtime.settings.cancelOpposingSignal, let candidate = bear, let previous = runtime.previousBull,
           abs(candidate.price - previous.price) <= conflict { bear = nil }
        if let bullish = bull, let bearish = bear {
            if bullish.score > bearish.score { bear = nil }
            else if bearish.score > bullish.score { bull = nil }
            else { bull = nil; bear = nil }
        }
        runtime.previousBull = bull.map { commit(runtime, $0, chartIndex: chartIndex) }
        runtime.previousBear = bear.map { commit(runtime, $0, chartIndex: chartIndex) }
    }
}
