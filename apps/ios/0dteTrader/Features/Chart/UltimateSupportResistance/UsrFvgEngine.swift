import Foundation

/// Pure event simulator mirroring computeUsr.ts and the confirmed-bar Pine
/// state machine. No UIKit/SwiftUI dependencies belong in this layer.
extension UsrEngine {
    static func detectFvg(_ runtime: Runtime) {
        let index = runtime.analysisBarId
        guard index >= 2 else { return }
        let first = runtime.analysis[index - 2]
        let displacement = runtime.analysis[index - 1]
        let third = runtime.analysis[index]
        let bodies = runtime.analysis.map { abs($0.close - $0.open) }
        let averages = UsrMath.rollingLaggedMean(bodies, length: runtime.settings.fvgLookback)
        guard let average = averages[index - 1] else { return }
        let body = bodies[index - 1]
        let wick = body * runtime.settings.fvgWickPercent
        let displacementAtr = runtime.timeframeTag == "chart"
            ? activeAtr(runtime, displacement)
            : displacement.atr
        let enough = body >= average * runtime.settings.fvgBodyPercent
            && displacementAtr != nil
            && body >= (displacementAtr ?? 0) * runtime.settings.fvgMinBodyAtr
        let up = enough && displacement.close > displacement.open
            && displacement.high - displacement.close <= wick
            && displacement.open - displacement.low <= wick
        let down = enough && displacement.close < displacement.open
            && displacement.close - displacement.low <= wick
            && displacement.high - displacement.open <= wick
        if up && third.low > first.high {
            createFvg(runtime, direction: .bullish, top: third.low, bottom: first.high, start: first.chartStart)
        }
        if down && third.high < first.low {
            createFvg(runtime, direction: .bearish, top: first.low, bottom: third.high, start: first.chartStart)
        }
    }

    static func createFvg(
        _ runtime: Runtime,
        direction: UsrFvgDirection,
        top: Double,
        bottom: Double,
        start: Int
    ) {
        let atr = activeAtr(runtime, runtime.analysis[runtime.analysisBarId])
        let minimum = max(runtime.settings.minimumTick * 2, atr * runtime.settings.fvgMinGapAtr)
        guard top >= bottom, top - bottom >= minimum else { return }
        let tick = runtime.settings.minimumTick
        let topKey = UsrMath.quantizedPriceKey(top, minimumTick: tick)
        let bottomKey = UsrMath.quantizedPriceKey(bottom, minimumTick: tick)
        let id = "\(direction == .bullish ? "FB" : "FR"):\(runtime.timeframeTag):\(start):\(topKey):\(bottomKey)"
        if direction == .bullish {
            guard !runtime.bullishFvgs.contains(where: { $0.id == id }) else { return }
            runtime.bullishFvgs.insert(UsrFvg(id: id, top: top, bottom: bottom,
                ce: (top + bottom) / 2, startBar: start, analysisBirth: runtime.analysisBarId,
                direction: direction), at: 0)
            if runtime.bullishFvgs.count > Constants.maximumStoredFvgs { runtime.bullishFvgs.removeLast() }
        } else {
            guard !runtime.bearishFvgs.contains(where: { $0.id == id }) else { return }
            runtime.bearishFvgs.insert(UsrFvg(id: id, top: top, bottom: bottom,
                ce: (top + bottom) / 2, startBar: start, analysisBirth: runtime.analysisBarId,
                direction: direction), at: 0)
            if runtime.bearishFvgs.count > Constants.maximumStoredFvgs { runtime.bearishFvgs.removeLast() }
        }
    }

    static func processFvgSide(_ runtime: Runtime, source: [UsrFvg], bullish: Bool) -> [UsrFvg] {
        var fvgs = source
        let candle = runtime.analysis[runtime.analysisBarId]
        let epsilon = runtime.settings.minimumTick * Double(runtime.settings.breakBufferTicks)
        for index in fvgs.indices {
            if fvgs[index].ifvgActive {
                let broken = bullish
                    ? above(runtime, candle.close, fvgs[index].top)
                    : below(runtime, candle.close, fvgs[index].bottom)
                let expired = runtime.analysisBarId - fvgs[index].ifvgAnalysisBirth > runtime.settings.fvgMaxBarsActive
                if broken || expired {
                    fvgs[index].ifvgActive = false
                    fvgs[index].ifvgEndBar = candle.chartEnd
                    fvgs[index].lifecycle = expired ? .expired : .invalidated
                }
                continue
            }
            guard fvgs[index].isActive, runtime.analysisBarId > fvgs[index].analysisBirth else { continue }
            if runtime.analysisBarId - fvgs[index].analysisBirth > runtime.settings.fvgMaxBarsActive {
                fvgs[index].isActive = false
                fvgs[index].endBar = candle.chartEnd
                fvgs[index].lifecycle = .expired
                continue
            }
            let size = fvgs[index].top - fvgs[index].bottom
            let penetration = UsrMath.clamp(
                bullish ? (fvgs[index].top - candle.low) / size : (candle.high - fvgs[index].bottom) / size,
                0, 1
            )
            let farWick = bullish ? candle.low <= fvgs[index].bottom : candle.high >= fvgs[index].top
            let farClose = bullish
                ? below(runtime, candle.close, fvgs[index].bottom)
                : above(runtime, candle.close, fvgs[index].top)
            let touched = bullish
                ? candle.low <= fvgs[index].top + epsilon
                : candle.high >= fvgs[index].bottom - epsilon
            let closedInside = bullish
                ? candle.close <= fvgs[index].top + epsilon
                : candle.close >= fvgs[index].bottom - epsilon
            let milestone: Bool
            switch runtime.settings.fvgFillMode {
            case "touch": milestone = touched
            case "close": milestone = closedInside
            case "percent": milestone = penetration >= runtime.settings.fvgFillPercent / 100
            default: milestone = penetration >= 0.5
            }
            if milestone { fvgs[index].milestoneReached = true }
            if farClose {
                fvgs[index].isActive = false
                fvgs[index].endBar = candle.chartEnd
                if runtime.settings.showIfvg {
                    fvgs[index].ifvgActive = true
                    fvgs[index].ifvgAnalysisBirth = runtime.analysisBarId
                    fvgs[index].lifecycle = .inverted
                    fvgs[index].bounceSignalCount = 0
                    fvgs[index].sweepSignalCount = 0
                    fvgs[index].lastBounceSignalAnalysisBar = 0
                    fvgs[index].lastSweepSignalAnalysisBar = 0
                } else {
                    fvgs[index].lifecycle = .invalidated
                }
            } else if farWick {
                fvgs[index].lifecycle = .wickFilled
            } else if penetration >= 0.5,
                      fvgs[index].lifecycle == .untouched || fvgs[index].lifecycle == .partial {
                fvgs[index].lifecycle = .ce
            } else if penetration > 0, fvgs[index].lifecycle == .untouched {
                fvgs[index].lifecycle = .partial
            }
        }
        return fvgs
    }

    static func processFvgs(_ runtime: Runtime) {
        guard runtime.settings.showFvg else {
            runtime.bullishFvgs = []
            runtime.bearishFvgs = []
            return
        }
        detectFvg(runtime)
        runtime.bullishFvgs = processFvgSide(runtime, source: runtime.bullishFvgs, bullish: true)
        runtime.bearishFvgs = processFvgSide(runtime, source: runtime.bearishFvgs, bullish: false)
    }
}
