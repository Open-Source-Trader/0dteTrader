import Foundation

/// TWC Heatmap V5 — Unified Confluence Engine (twcConfluence.ts port, 1:1).
/// Blends every subsystem into one 0–100 score per bar and derives the CL/CS
/// entry markers. The six MTF votes run the direction-only zigzag over
/// candles RESAMPLED from the loaded chart history (the API serves no extra
/// timeframes); largest timeframes without two pivots simply vote 0.
enum TwcConfluence {
    // component weights (sum = 1.0, straight from the Pine script)
    private static let wMsi = 0.15
    private static let wCtf = 0.2
    private static let wStack = 0.15
    private static let wFib = 0.15
    private static let wMtf = 0.2
    private static let wSwing = 0.1
    private static let wInt = 0.05

    struct Input {
        let msi: [Double?]
        let ctfDir: [Int]
        let stackDir: [Int]
        let crossUp: [Bool]
        let crossDn: [Bool]
        let fibDir: [Int]
        let swingBias: [Int]
        let internalBias: [Int]
    }

    struct Result {
        /// 0–100 score per bar; nil while MSI is warming up.
        let score: [Double?]
        let markers: [TwcMarker]
    }

    /// Per-bar direction vote of one resampled timeframe, mapped to chart bars.
    private static func mtfVote(
        candles: [Candle],
        tf: String,
        settings: TwcHeatmapSettings,
        chartIntervalSeconds: Int
    ) -> [Int] {
        let resample = TwcMath.resampleTo(
            candles,
            targetSeconds: TwcMath.timeframeSeconds(tf),
            chartIntervalSeconds: chartIntervalSeconds
        )
        let dir = TwcFib.fibDirectionSeries(candles: resample.htfCandles, settings: settings)
        // lookahead_off with no [1] offset: chart bars read the developing bucket
        return resample.chartToHtf.map { dir[$0] }
    }

    static func compute(
        candles: [Candle],
        settings: TwcHeatmapSettings,
        input: Input,
        chartIntervalSeconds: Int
    ) -> Result {
        let n = candles.count
        let tfs = [settings.mtfTf1, settings.mtfTf2, settings.mtfTf3, settings.mtfTf4, settings.mtfTf5, settings.mtfTf6]
        let votes = tfs.map { mtfVote(candles: candles, tf: $0, settings: settings, chartIntervalSeconds: chartIntervalSeconds) }

        var score = [Double?](repeating: nil, count: n)
        var markers: [TwcMarker] = []

        for i in 0..<n {
            guard let m = input.msi[i] else { continue } // score na until MSI warms up

            var bullVotes = 0
            var bearVotes = 0
            for vote in votes {
                if vote[i] == 1 { bullVotes += 1 } else if vote[i] == -1 { bearVotes += 1 }
            }
            let mtfNet = Double(bullVotes - bearVotes) / 6

            let s = 50 + 50 * (
                wMsi * ((m - 50) / 50)
                    + wCtf * Double(input.ctfDir[i])
                    + wStack * Double(input.stackDir[i])
                    + wFib * Double(input.fibDir[i])
                    + wMtf * mtfNet
                    + wSwing * Double(input.swingBias[i])
                    + wInt * Double(input.internalBias[i])
            )
            score[i] = s

            guard settings.showConfMarkers else { continue }
            let confluenceLong = input.crossUp[i] && (!settings.useConfluenceGate || s >= settings.confBullThr)
            let confluenceShort = input.crossDn[i] && (!settings.useConfluenceGate || s <= settings.confBearThr)
            if confluenceLong {
                markers.append(TwcMarker(barIndex: i, placement: .belowBar, shape: .labelUp, color: TwcColors.bull, sizeTiny: false, text: "CL"))
            }
            if confluenceShort {
                markers.append(TwcMarker(barIndex: i, placement: .aboveBar, shape: .labelDown, color: TwcColors.bear, sizeTiny: false, text: "CS"))
            }
        }

        return Result(score: score, markers: markers)
    }
}
