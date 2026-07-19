import Foundation

/// Settings for the "TWC Heatmap V5" script indicator (twcSettings.ts port,
/// 1:1). Flat struct so `decodeIfPresent` migration mirrors IndicatorSettings;
/// the settings screen groups fields into sections matching the Pine input
/// groups. Defaults mirror TWC_Heat_Map_Indicator.pine.
struct TwcHeatmapSettings: Codable, Equatable, Sendable {
    /// Master toggle shown in the indicator list.
    var enabled: Bool

    // Core Models
    var source: String
    var lenLR: Int
    var hwAlpha: Double
    var hwBeta: Double
    var lenCoG: Int

    // Hidden Markov Model
    var hmmLook: Int
    var hmmStay: Double

    // VWAP Z-Score
    var vwapLook: Int
    var vwapWarn: Double
    var showVwapRip: Bool

    // MSI / Signal Logic
    var msiBullThr: Double
    var msiBearThr: Double

    // Visuals
    var colorBars: Bool
    var showMarkers: Bool
    var hideUnalignedCandles: Bool

    // SD: Fibonacci Levels
    var showFibonacci: Bool
    var fibPeriod: Int
    var fibMethod: String
    var fibLabelPosition: String
    var showFibRatioLabels: Bool
    var showFibPriceLabels: Bool
    var fibPivotSource: String
    var useStandardRatios: Bool

    // SD: Fib Flip / Reject
    var flipEnable: Bool
    var flipTrigger: String
    var flipLevel: String

    // SD: Profit Target Zones
    var shadeBands: Bool
    var showPTLabels: Bool
    var ptExtensionsOnly: Bool
    var ptPrefix: String
    var ptAlwaysShowFirst: Bool

    // SD: Gann
    var showGannFan: Bool
    var showGannBox: Bool
    var gannScaleMethod: String
    var gannManualScale: Double
    var gannATRMultiplier: Double
    var gann1x1: Bool
    var gann2x1: Bool
    var gann1x2: Bool
    var gann3x1: Bool
    var gann1x3: Bool
    var gann4x1: Bool
    var gann1x4: Bool
    var gann8x1: Bool
    var gann1x8: Bool

    // CTF Core
    var ctfAtrLength: Int
    var ctfMultiplier: Double
    var showCTFLine: Bool
    var showBuySellSignals: Bool

    // Highlight
    var showTransparentHighlight: Bool
    var highlightTransparency: Int

    // HTF Stack (6x chart timeframe)
    var showHTF3: Bool
    var showHTF4: Bool
    var useCustomHTFAtrLength: Bool
    var htfAtrLength: Int

    // Bollinger Bands (length fixed at 20, like the Pine script)
    var showBB2: Bool
    var showBB3: Bool
    var showEnvelopeRejection: Bool
    var rejectionEnvelope: String

    // SuperTrend Gate / MACD Alignment
    var showMacdAlign: Bool
    var macdFast: Int
    var macdSlow: Int
    var macdSignal: Int

    // Order Blocks (SMC)
    var showSwingOrderBlocks: Bool
    var swingOrderBlocksSize: Int
    var showInternalOrderBlocks: Bool
    var internalOrderBlocksSize: Int
    var orderBlockFilter: String
    var orderBlockMitigation: String
    var swingsLength: Int

    // Premium & Discount Zones (SMC)
    var showPremiumDiscountZones: Bool

    // Unified Confluence Engine
    var useConfluenceGate: Bool
    var confBullThr: Double
    var confBearThr: Double
    var showConfMarkers: Bool
    var mtfTf1: String
    var mtfTf2: String
    var mtfTf3: String
    var mtfTf4: String
    var mtfTf5: String
    var mtfTf6: String

    // Bias Banner
    var showBiasBanner: Bool
    var biasBannerPosition: String
    var biasBannerSize: String
    var biasLongText: String
    var biasShortText: String
    var biasChopText: String

    static let `default` = TwcHeatmapSettings(
        enabled: false,
        source: "close",
        lenLR: 20,
        hwAlpha: 0.2,
        hwBeta: 0.1,
        lenCoG: 10,
        hmmLook: 50,
        hmmStay: 0.88,
        vwapLook: 34,
        vwapWarn: 1.5,
        showVwapRip: true,
        msiBullThr: 75,
        msiBearThr: 25,
        colorBars: false,
        showMarkers: true,
        hideUnalignedCandles: false,
        showFibonacci: true,
        fibPeriod: 10,
        fibMethod: "Simple Pivots",
        fibLabelPosition: "Right",
        showFibRatioLabels: false,
        showFibPriceLabels: false,
        fibPivotSource: "Body",
        useStandardRatios: true,
        flipEnable: true,
        flipTrigger: "Close",
        flipLevel: "0.000",
        shadeBands: true,
        showPTLabels: true,
        ptExtensionsOnly: true,
        ptPrefix: "Profit Target #",
        ptAlwaysShowFirst: true,
        showGannFan: false,
        showGannBox: false,
        gannScaleMethod: "Swing-Relative (Original)",
        gannManualScale: 1.0,
        gannATRMultiplier: 0.1,
        gann1x1: false,
        gann2x1: false,
        gann1x2: false,
        gann3x1: false,
        gann1x3: false,
        gann4x1: false,
        gann1x4: false,
        gann8x1: false,
        gann1x8: false,
        ctfAtrLength: 14,
        ctfMultiplier: 3.5,
        showCTFLine: true,
        showBuySellSignals: false,
        showTransparentHighlight: true,
        highlightTransparency: 92,
        showHTF3: true,
        showHTF4: false,
        useCustomHTFAtrLength: true,
        htfAtrLength: 7,
        showBB2: false,
        showBB3: false,
        showEnvelopeRejection: false,
        rejectionEnvelope: "2 Std",
        showMacdAlign: true,
        macdFast: 12,
        macdSlow: 26,
        macdSignal: 9,
        showSwingOrderBlocks: true,
        swingOrderBlocksSize: 4,
        showInternalOrderBlocks: false,
        internalOrderBlocksSize: 3,
        orderBlockFilter: "Atr",
        orderBlockMitigation: "High/Low",
        swingsLength: 34,
        showPremiumDiscountZones: true,
        useConfluenceGate: false,
        confBullThr: 65,
        confBearThr: 35,
        showConfMarkers: false,
        mtfTf1: "5",
        mtfTf2: "15",
        mtfTf3: "60",
        mtfTf4: "240",
        mtfTf5: "D",
        mtfTf6: "W",
        showBiasBanner: true,
        biasBannerPosition: "Bottom Center",
        biasBannerSize: "Tiny",
        biasLongText: "Long Bias — Look for a Bullish Trade 🍀",
        biasShortText: "Shorts Bias — Look for a Bearish Trade 🩸",
        biasChopText: "Chop Bias ⚠️ — Avoid Trading or Size down"
    )
}

/// Option lists owned by the model so views don't carry magic strings.
extension TwcHeatmapSettings {
    static let sourceOptions = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"]
    static let fibMethodOptions = ["Simple Pivots", "Volume Filtered"]
    static let labelPositionOptions = ["Left", "Right"]
    static let pivotSourceOptions = ["Wick", "Body"]
    static let flipTriggerOptions = ["Wick", "Close"]
    static let flipLevelOptions = ["0.000", "±0.618", "±1.618"]
    static let gannScaleOptions = ["Swing-Relative (Original)", "Auto (ATR-based)", "Manual"]
    static let envelopeOptions = ["2 Std", "3 Std"]
    static let bannerPositionOptions = [
        "Top Left", "Top Center", "Top Right",
        "Middle Left", "Middle Center", "Middle Right",
        "Bottom Left", "Bottom Center", "Bottom Right",
    ]
    static let bannerSizeOptions = ["Tiny", "Small", "Normal", "Large"]
    static let orderBlockFilterOptions = ["Atr", "Cumulative Mean Range"]
    static let orderBlockMitigationOptions = ["Close", "High/Low"]
    static let mtfTimeframeOptions = ["1", "5", "15", "30", "60", "240", "D", "W"]
}

// Decoding lives in an extension so the memberwise initializer stays available.
// decodeIfPresent keeps settings saved by older app versions valid.
extension TwcHeatmapSettings {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = TwcHeatmapSettings.default
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? d.enabled
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? d.source
        lenLR = try c.decodeIfPresent(Int.self, forKey: .lenLR) ?? d.lenLR
        hwAlpha = try c.decodeIfPresent(Double.self, forKey: .hwAlpha) ?? d.hwAlpha
        hwBeta = try c.decodeIfPresent(Double.self, forKey: .hwBeta) ?? d.hwBeta
        lenCoG = try c.decodeIfPresent(Int.self, forKey: .lenCoG) ?? d.lenCoG
        hmmLook = try c.decodeIfPresent(Int.self, forKey: .hmmLook) ?? d.hmmLook
        hmmStay = try c.decodeIfPresent(Double.self, forKey: .hmmStay) ?? d.hmmStay
        vwapLook = try c.decodeIfPresent(Int.self, forKey: .vwapLook) ?? d.vwapLook
        vwapWarn = try c.decodeIfPresent(Double.self, forKey: .vwapWarn) ?? d.vwapWarn
        showVwapRip = try c.decodeIfPresent(Bool.self, forKey: .showVwapRip) ?? d.showVwapRip
        msiBullThr = try c.decodeIfPresent(Double.self, forKey: .msiBullThr) ?? d.msiBullThr
        msiBearThr = try c.decodeIfPresent(Double.self, forKey: .msiBearThr) ?? d.msiBearThr
        colorBars = try c.decodeIfPresent(Bool.self, forKey: .colorBars) ?? d.colorBars
        showMarkers = try c.decodeIfPresent(Bool.self, forKey: .showMarkers) ?? d.showMarkers
        hideUnalignedCandles = try c.decodeIfPresent(Bool.self, forKey: .hideUnalignedCandles) ?? d.hideUnalignedCandles
        showFibonacci = try c.decodeIfPresent(Bool.self, forKey: .showFibonacci) ?? d.showFibonacci
        fibPeriod = try c.decodeIfPresent(Int.self, forKey: .fibPeriod) ?? d.fibPeriod
        fibMethod = try c.decodeIfPresent(String.self, forKey: .fibMethod) ?? d.fibMethod
        fibLabelPosition = try c.decodeIfPresent(String.self, forKey: .fibLabelPosition) ?? d.fibLabelPosition
        showFibRatioLabels = try c.decodeIfPresent(Bool.self, forKey: .showFibRatioLabels) ?? d.showFibRatioLabels
        showFibPriceLabels = try c.decodeIfPresent(Bool.self, forKey: .showFibPriceLabels) ?? d.showFibPriceLabels
        fibPivotSource = try c.decodeIfPresent(String.self, forKey: .fibPivotSource) ?? d.fibPivotSource
        useStandardRatios = try c.decodeIfPresent(Bool.self, forKey: .useStandardRatios) ?? d.useStandardRatios
        flipEnable = try c.decodeIfPresent(Bool.self, forKey: .flipEnable) ?? d.flipEnable
        flipTrigger = try c.decodeIfPresent(String.self, forKey: .flipTrigger) ?? d.flipTrigger
        flipLevel = try c.decodeIfPresent(String.self, forKey: .flipLevel) ?? d.flipLevel
        shadeBands = try c.decodeIfPresent(Bool.self, forKey: .shadeBands) ?? d.shadeBands
        showPTLabels = try c.decodeIfPresent(Bool.self, forKey: .showPTLabels) ?? d.showPTLabels
        ptExtensionsOnly = try c.decodeIfPresent(Bool.self, forKey: .ptExtensionsOnly) ?? d.ptExtensionsOnly
        ptPrefix = try c.decodeIfPresent(String.self, forKey: .ptPrefix) ?? d.ptPrefix
        ptAlwaysShowFirst = try c.decodeIfPresent(Bool.self, forKey: .ptAlwaysShowFirst) ?? d.ptAlwaysShowFirst
        showGannFan = try c.decodeIfPresent(Bool.self, forKey: .showGannFan) ?? d.showGannFan
        showGannBox = try c.decodeIfPresent(Bool.self, forKey: .showGannBox) ?? d.showGannBox
        gannScaleMethod = try c.decodeIfPresent(String.self, forKey: .gannScaleMethod) ?? d.gannScaleMethod
        gannManualScale = try c.decodeIfPresent(Double.self, forKey: .gannManualScale) ?? d.gannManualScale
        gannATRMultiplier = try c.decodeIfPresent(Double.self, forKey: .gannATRMultiplier) ?? d.gannATRMultiplier
        gann1x1 = try c.decodeIfPresent(Bool.self, forKey: .gann1x1) ?? d.gann1x1
        gann2x1 = try c.decodeIfPresent(Bool.self, forKey: .gann2x1) ?? d.gann2x1
        gann1x2 = try c.decodeIfPresent(Bool.self, forKey: .gann1x2) ?? d.gann1x2
        gann3x1 = try c.decodeIfPresent(Bool.self, forKey: .gann3x1) ?? d.gann3x1
        gann1x3 = try c.decodeIfPresent(Bool.self, forKey: .gann1x3) ?? d.gann1x3
        gann4x1 = try c.decodeIfPresent(Bool.self, forKey: .gann4x1) ?? d.gann4x1
        gann1x4 = try c.decodeIfPresent(Bool.self, forKey: .gann1x4) ?? d.gann1x4
        gann8x1 = try c.decodeIfPresent(Bool.self, forKey: .gann8x1) ?? d.gann8x1
        gann1x8 = try c.decodeIfPresent(Bool.self, forKey: .gann1x8) ?? d.gann1x8
        ctfAtrLength = try c.decodeIfPresent(Int.self, forKey: .ctfAtrLength) ?? d.ctfAtrLength
        ctfMultiplier = try c.decodeIfPresent(Double.self, forKey: .ctfMultiplier) ?? d.ctfMultiplier
        showCTFLine = try c.decodeIfPresent(Bool.self, forKey: .showCTFLine) ?? d.showCTFLine
        showBuySellSignals = try c.decodeIfPresent(Bool.self, forKey: .showBuySellSignals) ?? d.showBuySellSignals
        showTransparentHighlight = try c.decodeIfPresent(Bool.self, forKey: .showTransparentHighlight) ?? d.showTransparentHighlight
        highlightTransparency = try c.decodeIfPresent(Int.self, forKey: .highlightTransparency) ?? d.highlightTransparency
        showHTF3 = try c.decodeIfPresent(Bool.self, forKey: .showHTF3) ?? d.showHTF3
        showHTF4 = try c.decodeIfPresent(Bool.self, forKey: .showHTF4) ?? d.showHTF4
        useCustomHTFAtrLength = try c.decodeIfPresent(Bool.self, forKey: .useCustomHTFAtrLength) ?? d.useCustomHTFAtrLength
        htfAtrLength = try c.decodeIfPresent(Int.self, forKey: .htfAtrLength) ?? d.htfAtrLength
        showBB2 = try c.decodeIfPresent(Bool.self, forKey: .showBB2) ?? d.showBB2
        showBB3 = try c.decodeIfPresent(Bool.self, forKey: .showBB3) ?? d.showBB3
        showEnvelopeRejection = try c.decodeIfPresent(Bool.self, forKey: .showEnvelopeRejection) ?? d.showEnvelopeRejection
        rejectionEnvelope = try c.decodeIfPresent(String.self, forKey: .rejectionEnvelope) ?? d.rejectionEnvelope
        showMacdAlign = try c.decodeIfPresent(Bool.self, forKey: .showMacdAlign) ?? d.showMacdAlign
        macdFast = try c.decodeIfPresent(Int.self, forKey: .macdFast) ?? d.macdFast
        macdSlow = try c.decodeIfPresent(Int.self, forKey: .macdSlow) ?? d.macdSlow
        macdSignal = try c.decodeIfPresent(Int.self, forKey: .macdSignal) ?? d.macdSignal
        showSwingOrderBlocks = try c.decodeIfPresent(Bool.self, forKey: .showSwingOrderBlocks) ?? d.showSwingOrderBlocks
        swingOrderBlocksSize = try c.decodeIfPresent(Int.self, forKey: .swingOrderBlocksSize) ?? d.swingOrderBlocksSize
        showInternalOrderBlocks = try c.decodeIfPresent(Bool.self, forKey: .showInternalOrderBlocks) ?? d.showInternalOrderBlocks
        internalOrderBlocksSize = try c.decodeIfPresent(Int.self, forKey: .internalOrderBlocksSize) ?? d.internalOrderBlocksSize
        orderBlockFilter = try c.decodeIfPresent(String.self, forKey: .orderBlockFilter) ?? d.orderBlockFilter
        orderBlockMitigation = try c.decodeIfPresent(String.self, forKey: .orderBlockMitigation) ?? d.orderBlockMitigation
        swingsLength = try c.decodeIfPresent(Int.self, forKey: .swingsLength) ?? d.swingsLength
        showPremiumDiscountZones = try c.decodeIfPresent(Bool.self, forKey: .showPremiumDiscountZones) ?? d.showPremiumDiscountZones
        useConfluenceGate = try c.decodeIfPresent(Bool.self, forKey: .useConfluenceGate) ?? d.useConfluenceGate
        confBullThr = try c.decodeIfPresent(Double.self, forKey: .confBullThr) ?? d.confBullThr
        confBearThr = try c.decodeIfPresent(Double.self, forKey: .confBearThr) ?? d.confBearThr
        showConfMarkers = try c.decodeIfPresent(Bool.self, forKey: .showConfMarkers) ?? d.showConfMarkers
        mtfTf1 = try c.decodeIfPresent(String.self, forKey: .mtfTf1) ?? d.mtfTf1
        mtfTf2 = try c.decodeIfPresent(String.self, forKey: .mtfTf2) ?? d.mtfTf2
        mtfTf3 = try c.decodeIfPresent(String.self, forKey: .mtfTf3) ?? d.mtfTf3
        mtfTf4 = try c.decodeIfPresent(String.self, forKey: .mtfTf4) ?? d.mtfTf4
        mtfTf5 = try c.decodeIfPresent(String.self, forKey: .mtfTf5) ?? d.mtfTf5
        mtfTf6 = try c.decodeIfPresent(String.self, forKey: .mtfTf6) ?? d.mtfTf6
        showBiasBanner = try c.decodeIfPresent(Bool.self, forKey: .showBiasBanner) ?? d.showBiasBanner
        biasBannerPosition = try c.decodeIfPresent(String.self, forKey: .biasBannerPosition) ?? d.biasBannerPosition
        biasBannerSize = try c.decodeIfPresent(String.self, forKey: .biasBannerSize) ?? d.biasBannerSize
        biasLongText = try c.decodeIfPresent(String.self, forKey: .biasLongText) ?? d.biasLongText
        biasShortText = try c.decodeIfPresent(String.self, forKey: .biasShortText) ?? d.biasShortText
        biasChopText = try c.decodeIfPresent(String.self, forKey: .biasChopText) ?? d.biasChopText
    }
}
