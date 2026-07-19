import Foundation

// MARK: - Render model (twcTypes.ts port, 1:1)
// Everything is in (barIndex, price) space; barIndex may exceed the last
// candle (forward projection — the overlay maps it via the chart transformer).
// Colors are hex/rgba strings resolved by the renderer so the compute layer
// stays UIKit-free and testable.

enum TwcMarkerShape: String, Equatable, Sendable {
    case diamond, triangleUp, triangleDown, labelUp, labelDown
}

enum TwcMarkerPlacement: String, Equatable, Sendable {
    case aboveBar, belowBar
}

struct TwcMarker: Equatable, Sendable {
    let barIndex: Int
    let placement: TwcMarkerPlacement
    let shape: TwcMarkerShape
    let color: String
    let sizeTiny: Bool
    var text: String? = nil
}

struct TwcLine: Equatable, Sendable {
    let id: String
    let values: [Double?] // aligned to candles; nil = line break
    let color: String
    let lineWidth: Double
}

struct TwcAreaFill: Equatable, Sendable {
    let id: String
    let top: [Double?]
    let bottom: [Double?]
    /// Per-bar fill color (CTF highlight flips with direction).
    let colors: [String?]
}

enum TwcSegmentStyle: String, Equatable, Sendable {
    case solid, dashed, dotted
}

struct TwcSegment: Equatable, Sendable {
    let x1: Double
    let y1: Double
    let x2: Double
    let y2: Double
    let color: String
    let width: Double
    let style: TwcSegmentStyle
}

struct TwcBand: Equatable, Sendable {
    let x1: Double
    let x2: Double
    let yTop: Double
    let yBottom: Double
    let fillColor: String
    /// Optional stroked outline (swing order blocks).
    var borderColor: String? = nil
}

enum TwcLabelAlign: String, Equatable, Sendable {
    case left, center, right
}

struct TwcLabel: Equatable, Sendable {
    let barIndex: Double
    let price: Double
    let text: String
    let textColor: String
    var bgColor: String? = nil
    let align: TwcLabelAlign
}

struct TwcBanner: Equatable, Sendable {
    let text: String
    let color: String
    let position: String
    let size: String
}

struct TwcRenderModel: Equatable, Sendable {
    let candleColors: [String?]?
    let markers: [TwcMarker]
    let lines: [TwcLine]
    let fills: [TwcAreaFill]
    let segments: [TwcSegment]
    let bands: [TwcBand]
    let labels: [TwcLabel]
    let banner: TwcBanner?
}

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
        let raw = hex.replacingOccurrences(of: "#", with: "")
        guard raw.count >= 6,
              let r = Int(raw.prefix(2), radix: 16),
              let g = Int(raw.dropFirst(2).prefix(2), radix: 16),
              let b = Int(raw.dropFirst(4).prefix(2), radix: 16)
        else { return hex }
        return "rgba(\(r), \(g), \(b), \(opacity))"
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
