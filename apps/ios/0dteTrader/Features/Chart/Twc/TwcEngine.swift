import Foundation

// MARK: - Fixed colors (twcColors.ts port; Pine defaults, Material palette)

enum TwcColors {
    static let bull = "#4CAF50"
    static let bear = "#FF5252"
    static let chop = "#FFEB3B"
    static let stBull = "rgb(0, 214, 143)"
    static let stBear = "rgb(255, 82, 82)"
    static let macdBull = "#2196F3"
    static let macdBear = "#9C27B0"
    static let amberBand = "rgba(250, 179, 2, 0.25)"
    static let white50 = "rgba(255, 255, 255, 0.5)"
    static let gold50 = "rgba(239, 191, 4, 0.5)"
    static let red50 = "rgba(255, 82, 82, 0.5)"
    static let fibLabel = "rgba(255, 255, 255, 0.75)"
    static let ptPill = "rgba(33, 150, 243, 0.5)"
    static let ptText = "#FFFFFF"
    // Pine color.gray = #787B86
    static let gannFan = "#FFFFFF"
    static let gannBox = "rgba(120, 123, 134, 0.4)"
    static let bbBasis = "rgba(255, 152, 0, 0.6)"
    static let bbSigma2 = "rgba(33, 150, 243, 0.45)"
    static let bbSigma2Fill = "rgba(33, 150, 243, 0.06)"
    static let bbSigma3 = "rgba(156, 39, 176, 0.45)"
    static let bbSigma3Fill = "rgba(156, 39, 176, 0.04)"
    static let bannerLong = "#4CAF50"
    static let bannerShort = "#FF5252"
    static let bannerChop = "#FFEB3B"
    static let internalBullishOB = "rgba(49, 121, 245, 0.2)"
    static let internalBearishOB = "rgba(247, 124, 128, 0.2)"
    static let swingBullishOB = "rgba(24, 72, 204, 0.2)"
    static let swingBearishOB = "rgba(178, 40, 51, 0.2)"
    static let swingBullishOBBorder = "rgba(24, 72, 204, 0.6)"
    static let swingBearishOBBorder = "rgba(178, 40, 51, 0.6)"
    static let premiumZone = "rgba(242, 54, 69, 0.2)"
    static let equilibriumZone = "rgba(135, 139, 148, 0.2)"
    static let discountZone = "rgba(8, 153, 129, 0.2)"
    static let premiumText = "#F23645"
    static let equilibriumText = "#878b94"
    static let discountText = "#089981"
    static let vwapRip = "#FAB302"

    /// rgba() for a hex color at the given opacity (0...1).
    static func withOpacity(_ hex: String, _ opacity: Double) -> String {
        ScriptColor.withOpacity(hex, opacity)
    }
}

// MARK: - Entry point (computeTwc.ts port, 1:1)

enum TwcEngine {
    /// Pure: (candles, settings, interval) -> renderer-agnostic model.
    static func compute(
        candles: [Candle],
        settings: TwcHeatmapSettings,
        intervalSeconds: Int
    ) -> TwcRenderModel? {
        guard settings.enabled, !candles.isEmpty else { return nil }

        let heatmap = TwcHeatmap.compute(
            candles: candles,
            settings: settings,
            intervalSeconds: intervalSeconds
        )
        let fib = TwcFib.compute(candles: candles, settings: settings, atr14: heatmap.atr14)
        let smc = TwcSmc.compute(candles: candles, settings: settings)
        // Pine publishes the RAW zigzag direction (no instant-flip overlay)
        // when fib drawing is disabled; with drawing on, flips apply.
        var fibDirSettings = settings
        if !settings.showFibonacci { fibDirSettings.flipEnable = false }
        let fibDir = TwcFib.fibDirectionSeries(candles: candles, settings: fibDirSettings)
        let confluence = TwcConfluence.compute(
            candles: candles,
            settings: settings,
            input: TwcConfluence.Input(
                msi: heatmap.msi,
                ctfDir: heatmap.ctfDir,
                stackDir: heatmap.stackDir,
                crossUp: heatmap.crossUp,
                crossDn: heatmap.crossDn,
                fibDir: fibDir,
                swingBias: smc.swingBias,
                internalBias: smc.internalBias
            ),
            chartIntervalSeconds: intervalSeconds
        )

        return TwcRenderModel(
            candleColors: heatmap.candleColors,
            markers: heatmap.markers + confluence.markers,
            lines: heatmap.lines,
            fills: heatmap.fills,
            segments: fib.segments,
            // SMC bands (order blocks, zones) render beneath the PT bands
            bands: smc.bands + fib.bands,
            labels: smc.labels + fib.labels,
            banner: heatmap.banner
        )
    }
}
