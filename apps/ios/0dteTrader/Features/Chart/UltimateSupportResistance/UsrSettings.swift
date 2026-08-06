import Foundation

/// Pine input contract for Ultimate Support & Resistance. Flat/Codable by
/// design: persisted settings can add fields while old payloads fall back to
/// the canonical defaults through SettingsStore.
struct UsrSettings: Codable, Equatable, Sendable {
    var enabled = false
    var enableProximityFilter = true
    var proximityPercent = 5.0
    var maxSupportLevels = 125
    var maxResistanceLevels = 125
    var showLiquidityPools = true
    var showFvg = true
    var analysisTimeframe = "chart"
    var customTimeframe = "60"
    var showConfluence = false
    var enableSrFlip = true
    var showBounceSignals = false
    var showSweepSignals = false
    var signalRequireQualification = true
    var requireConfirmationCandleDirection = true
    var cancelOpposingSignal = true
    var maxRecentSignalsTotal = 20
    var volumeLookback = 30
    var minimumRelativeVolume = 1.2
    var minimumVolumeZScore = 0.5
    var sessionAwareVolume = true
    var maxSequenceLength = 12
    var displacementBodyPercent = 60.0
    var displacementAtrMultiplier = 0.6
    var structureLookback = 5
    var pivotLeftBars = 3
    var pivotRightBars = 1
    var orderBlockUseWicks = false
    var gapAtrMultiplier = 0.3
    var requirePriceVoidGaps = true
    var breakBufferTicks = 1
    var zoneMitigationPercent = 0.95
    var minimumTick = 0.01
    var showFlippedOrigins = true
    var showAllBrokenLevels = false
    var hidePooledLines = true
    var poolClusterThreshold = 3
    var poolAtrFactor = 2.5
    var maxSupportPools = 30
    var maxResistancePools = 30
    var showIfvg = true
    var showFvgCe = true
    var showFvgLabels = false
    var fvgFillMode = "ce"
    var fvgFillPercent = 50.0
    var fvgLookback = 10
    var fvgBodyPercent = 0.36
    var fvgWickPercent = 0.5
    var maxVisibleFvgs = 5
    var fvgMaxBarsActive = 200
    var fvgMinGapAtr = 0.05
    var fvgMinBodyAtr = 0.5
    var fvgBullishColor = "rgba(1, 199, 31, 0.15)"
    var fvgBearishColor = "rgba(216, 0, 0, 0.15)"
    var fvgCeColor = "rgba(255, 235, 59, 0.30)"
    var ifvgBullishColor = "rgba(255, 152, 0, 0.15)"
    var ifvgBearishColor = "rgba(156, 39, 176, 0.15)"

    static let `default` = UsrSettings()

    var isValid: Bool {
        let colors = [fvgBullishColor, fvgBearishColor, fvgCeColor, ifvgBullishColor, ifvgBearishColor]
        return ["chart", "auto", "4h", "1d", "3d", "1w", "2w", "1m", "custom"].contains(analysisTimeframe)
            && ["touch", "close", "ce", "percent"].contains(fvgFillMode)
            && (1...50).contains(proximityPercent)
            && (1...500).contains(maxSupportLevels)
            && (1...500).contains(maxResistanceLevels)
            && UsrTimeframe.parse(customTimeframe) != nil
            && (5...100).contains(maxRecentSignalsTotal)
            && (10...200).contains(volumeLookback)
            && minimumRelativeVolume >= 1 && minimumRelativeVolume <= 5
            && minimumVolumeZScore >= 0 && minimumVolumeZScore <= 5
            && (2...50).contains(maxSequenceLength)
            && displacementBodyPercent >= 40 && displacementBodyPercent <= 95
            && displacementAtrMultiplier >= 0.2 && displacementAtrMultiplier <= 3
            && (2...20).contains(structureLookback)
            && (1...10).contains(pivotLeftBars)
            && (1...5).contains(pivotRightBars)
            && gapAtrMultiplier >= 0.05 && gapAtrMultiplier <= 3
            && minimumTick >= 0.000_001 && minimumTick <= 100
            && breakBufferTicks >= 1 && breakBufferTicks <= 20
            && zoneMitigationPercent >= 0.5 && zoneMitigationPercent <= 1
            && (2...10).contains(poolClusterThreshold)
            && poolAtrFactor >= 1 && poolAtrFactor <= 5
            && (1...60).contains(maxSupportPools)
            && (1...60).contains(maxResistancePools)
            && fvgFillPercent >= 10 && fvgFillPercent <= 100
            && fvgLookback >= 3 && fvgLookback <= 50
            && fvgBodyPercent >= 0.05 && fvgBodyPercent <= 3
            && fvgWickPercent >= 0 && fvgWickPercent <= 2
            && (1...15).contains(maxVisibleFvgs)
            && fvgMaxBarsActive >= 10 && fvgMaxBarsActive <= 500
            && fvgMinGapAtr >= 0 && fvgMinGapAtr <= 1
            && fvgMinBodyAtr >= 0 && fvgMinBodyAtr <= 3
            && colors.allSatisfy(ScriptColor.isValid)
    }
}
