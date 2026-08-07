import Foundation

/// Single source of truth for every numeric Pine input bound. The settings
/// validator and SwiftUI controls both consume these ranges so a UI change
/// cannot admit a value that persistence later rejects (or vice versa).
enum UsrSettingsBounds {
    static let proximityPercent: ClosedRange<Double> = 1...50
    static let maxSupportLevels = 1...500
    static let maxResistanceLevels = 1...500
    static let maxRecentSignalsTotal = 5...100
    static let volumeLookback = 10...200
    static let minimumRelativeVolume: ClosedRange<Double> = 1...5
    static let minimumVolumeZScore: ClosedRange<Double> = 0...5
    static let maxSequenceLength = 2...50
    static let displacementBodyPercent: ClosedRange<Double> = 40...95
    static let displacementAtrMultiplier: ClosedRange<Double> = 0.2...3
    static let structureLookback = 2...20
    static let pivotLeftBars = 1...10
    static let pivotRightBars = 1...5
    static let gapAtrMultiplier: ClosedRange<Double> = 0.05...3
    static let breakBufferTicks = 1...20
    static let zoneMitigationPercent: ClosedRange<Double> = 0.5...1
    static let minimumTick: ClosedRange<Double> = 0.000_001...100
    static let poolClusterThreshold = 2...10
    static let poolAtrFactor: ClosedRange<Double> = 1...5
    static let maxSupportPools = 1...60
    static let maxResistancePools = 1...60
    static let fvgFillPercent: ClosedRange<Double> = 10...100
    static let fvgLookback = 3...50
    static let fvgBodyPercent: ClosedRange<Double> = 0.05...3
    static let fvgWickPercent: ClosedRange<Double> = 0...2
    static let maxVisibleFvgs = 1...15
    static let fvgMaxBarsActive = 10...500
    static let fvgMinGapAtr: ClosedRange<Double> = 0...1
    static let fvgMinBodyAtr: ClosedRange<Double> = 0...3
}

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

    private enum CodingKeys: String, CodingKey {
        case enabled, enableProximityFilter, proximityPercent
        case maxSupportLevels, maxResistanceLevels, showLiquidityPools, showFvg
        case analysisTimeframe, customTimeframe, showConfluence, enableSrFlip
        case showBounceSignals, showSweepSignals, signalRequireQualification
        case requireConfirmationCandleDirection, cancelOpposingSignal, maxRecentSignalsTotal
        case volumeLookback, minimumRelativeVolume, minimumVolumeZScore, sessionAwareVolume
        case maxSequenceLength, displacementBodyPercent, displacementAtrMultiplier
        case structureLookback, pivotLeftBars, pivotRightBars, orderBlockUseWicks
        case gapAtrMultiplier, requirePriceVoidGaps, breakBufferTicks, zoneMitigationPercent
        case minimumTick, showFlippedOrigins, showAllBrokenLevels, hidePooledLines
        case poolClusterThreshold, poolAtrFactor, maxSupportPools, maxResistancePools
        case showIfvg, showFvgCe, showFvgLabels, fvgFillMode, fvgFillPercent
        case fvgLookback, fvgBodyPercent, fvgWickPercent, maxVisibleFvgs, fvgMaxBarsActive
        case fvgMinGapAtr, fvgMinBodyAtr, fvgBullishColor, fvgBearishColor, fvgCeColor
        case ifvgBullishColor, ifvgBearishColor
    }

    init() {}

    /// Decode additively so a settings payload written by an older app keeps
    /// every user choice it knows about while newly introduced fields receive
    /// their canonical defaults. A wrong-typed present value still fails
    /// closed and is rejected by SettingsStore.
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init()
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? enabled
        enableProximityFilter = try values.decodeIfPresent(Bool.self, forKey: .enableProximityFilter)
            ?? enableProximityFilter
        proximityPercent = try values.decodeIfPresent(Double.self, forKey: .proximityPercent) ?? proximityPercent
        maxSupportLevels = try values.decodeIfPresent(Int.self, forKey: .maxSupportLevels) ?? maxSupportLevels
        maxResistanceLevels = try values.decodeIfPresent(Int.self, forKey: .maxResistanceLevels) ?? maxResistanceLevels
        showLiquidityPools = try values.decodeIfPresent(Bool.self, forKey: .showLiquidityPools) ?? showLiquidityPools
        showFvg = try values.decodeIfPresent(Bool.self, forKey: .showFvg) ?? showFvg
        analysisTimeframe = try values.decodeIfPresent(String.self, forKey: .analysisTimeframe) ?? analysisTimeframe
        customTimeframe = try values.decodeIfPresent(String.self, forKey: .customTimeframe) ?? customTimeframe
        showConfluence = try values.decodeIfPresent(Bool.self, forKey: .showConfluence) ?? showConfluence
        enableSrFlip = try values.decodeIfPresent(Bool.self, forKey: .enableSrFlip) ?? enableSrFlip
        showBounceSignals = try values.decodeIfPresent(Bool.self, forKey: .showBounceSignals) ?? showBounceSignals
        showSweepSignals = try values.decodeIfPresent(Bool.self, forKey: .showSweepSignals) ?? showSweepSignals
        signalRequireQualification = try values.decodeIfPresent(Bool.self, forKey: .signalRequireQualification)
            ?? signalRequireQualification
        requireConfirmationCandleDirection = try values.decodeIfPresent(
            Bool.self,
            forKey: .requireConfirmationCandleDirection
        ) ?? requireConfirmationCandleDirection
        cancelOpposingSignal = try values.decodeIfPresent(Bool.self, forKey: .cancelOpposingSignal)
            ?? cancelOpposingSignal
        maxRecentSignalsTotal = try values.decodeIfPresent(Int.self, forKey: .maxRecentSignalsTotal)
            ?? maxRecentSignalsTotal
        volumeLookback = try values.decodeIfPresent(Int.self, forKey: .volumeLookback) ?? volumeLookback
        minimumRelativeVolume = try values.decodeIfPresent(Double.self, forKey: .minimumRelativeVolume)
            ?? minimumRelativeVolume
        minimumVolumeZScore = try values.decodeIfPresent(Double.self, forKey: .minimumVolumeZScore)
            ?? minimumVolumeZScore
        sessionAwareVolume = try values.decodeIfPresent(Bool.self, forKey: .sessionAwareVolume) ?? sessionAwareVolume
        maxSequenceLength = try values.decodeIfPresent(Int.self, forKey: .maxSequenceLength) ?? maxSequenceLength
        displacementBodyPercent = try values.decodeIfPresent(Double.self, forKey: .displacementBodyPercent)
            ?? displacementBodyPercent
        displacementAtrMultiplier = try values.decodeIfPresent(Double.self, forKey: .displacementAtrMultiplier)
            ?? displacementAtrMultiplier
        structureLookback = try values.decodeIfPresent(Int.self, forKey: .structureLookback) ?? structureLookback
        pivotLeftBars = try values.decodeIfPresent(Int.self, forKey: .pivotLeftBars) ?? pivotLeftBars
        pivotRightBars = try values.decodeIfPresent(Int.self, forKey: .pivotRightBars) ?? pivotRightBars
        orderBlockUseWicks = try values.decodeIfPresent(Bool.self, forKey: .orderBlockUseWicks) ?? orderBlockUseWicks
        gapAtrMultiplier = try values.decodeIfPresent(Double.self, forKey: .gapAtrMultiplier) ?? gapAtrMultiplier
        requirePriceVoidGaps = try values.decodeIfPresent(Bool.self, forKey: .requirePriceVoidGaps)
            ?? requirePriceVoidGaps
        breakBufferTicks = try values.decodeIfPresent(Int.self, forKey: .breakBufferTicks) ?? breakBufferTicks
        zoneMitigationPercent = try values.decodeIfPresent(Double.self, forKey: .zoneMitigationPercent)
            ?? zoneMitigationPercent
        minimumTick = try values.decodeIfPresent(Double.self, forKey: .minimumTick) ?? minimumTick
        showFlippedOrigins = try values.decodeIfPresent(Bool.self, forKey: .showFlippedOrigins) ?? showFlippedOrigins
        showAllBrokenLevels = try values.decodeIfPresent(Bool.self, forKey: .showAllBrokenLevels)
            ?? showAllBrokenLevels
        hidePooledLines = try values.decodeIfPresent(Bool.self, forKey: .hidePooledLines) ?? hidePooledLines
        poolClusterThreshold = try values.decodeIfPresent(Int.self, forKey: .poolClusterThreshold)
            ?? poolClusterThreshold
        poolAtrFactor = try values.decodeIfPresent(Double.self, forKey: .poolAtrFactor) ?? poolAtrFactor
        maxSupportPools = try values.decodeIfPresent(Int.self, forKey: .maxSupportPools) ?? maxSupportPools
        maxResistancePools = try values.decodeIfPresent(Int.self, forKey: .maxResistancePools) ?? maxResistancePools
        showIfvg = try values.decodeIfPresent(Bool.self, forKey: .showIfvg) ?? showIfvg
        showFvgCe = try values.decodeIfPresent(Bool.self, forKey: .showFvgCe) ?? showFvgCe
        showFvgLabels = try values.decodeIfPresent(Bool.self, forKey: .showFvgLabels) ?? showFvgLabels
        fvgFillMode = try values.decodeIfPresent(String.self, forKey: .fvgFillMode) ?? fvgFillMode
        fvgFillPercent = try values.decodeIfPresent(Double.self, forKey: .fvgFillPercent) ?? fvgFillPercent
        fvgLookback = try values.decodeIfPresent(Int.self, forKey: .fvgLookback) ?? fvgLookback
        fvgBodyPercent = try values.decodeIfPresent(Double.self, forKey: .fvgBodyPercent) ?? fvgBodyPercent
        fvgWickPercent = try values.decodeIfPresent(Double.self, forKey: .fvgWickPercent) ?? fvgWickPercent
        maxVisibleFvgs = try values.decodeIfPresent(Int.self, forKey: .maxVisibleFvgs) ?? maxVisibleFvgs
        fvgMaxBarsActive = try values.decodeIfPresent(Int.self, forKey: .fvgMaxBarsActive) ?? fvgMaxBarsActive
        fvgMinGapAtr = try values.decodeIfPresent(Double.self, forKey: .fvgMinGapAtr) ?? fvgMinGapAtr
        fvgMinBodyAtr = try values.decodeIfPresent(Double.self, forKey: .fvgMinBodyAtr) ?? fvgMinBodyAtr
        fvgBullishColor = try values.decodeIfPresent(String.self, forKey: .fvgBullishColor) ?? fvgBullishColor
        fvgBearishColor = try values.decodeIfPresent(String.self, forKey: .fvgBearishColor) ?? fvgBearishColor
        fvgCeColor = try values.decodeIfPresent(String.self, forKey: .fvgCeColor) ?? fvgCeColor
        ifvgBullishColor = try values.decodeIfPresent(String.self, forKey: .ifvgBullishColor) ?? ifvgBullishColor
        ifvgBearishColor = try values.decodeIfPresent(String.self, forKey: .ifvgBearishColor) ?? ifvgBearishColor
    }

    static let `default` = UsrSettings()

    var isValid: Bool {
        let colors = [fvgBullishColor, fvgBearishColor, fvgCeColor, ifvgBullishColor, ifvgBearishColor]
        return ["chart", "auto", "4h", "1d", "3d", "1w", "2w", "1m", "custom"].contains(analysisTimeframe)
            && ["touch", "close", "ce", "percent"].contains(fvgFillMode)
            && UsrSettingsBounds.proximityPercent.contains(proximityPercent)
            && UsrSettingsBounds.maxSupportLevels.contains(maxSupportLevels)
            && UsrSettingsBounds.maxResistanceLevels.contains(maxResistanceLevels)
            && UsrTimeframe.parse(customTimeframe) != nil
            && UsrSettingsBounds.maxRecentSignalsTotal.contains(maxRecentSignalsTotal)
            && UsrSettingsBounds.volumeLookback.contains(volumeLookback)
            && UsrSettingsBounds.minimumRelativeVolume.contains(minimumRelativeVolume)
            && UsrSettingsBounds.minimumVolumeZScore.contains(minimumVolumeZScore)
            && UsrSettingsBounds.maxSequenceLength.contains(maxSequenceLength)
            && UsrSettingsBounds.displacementBodyPercent.contains(displacementBodyPercent)
            && UsrSettingsBounds.displacementAtrMultiplier.contains(displacementAtrMultiplier)
            && UsrSettingsBounds.structureLookback.contains(structureLookback)
            && UsrSettingsBounds.pivotLeftBars.contains(pivotLeftBars)
            && UsrSettingsBounds.pivotRightBars.contains(pivotRightBars)
            && UsrSettingsBounds.gapAtrMultiplier.contains(gapAtrMultiplier)
            && UsrSettingsBounds.minimumTick.contains(minimumTick)
            && UsrSettingsBounds.breakBufferTicks.contains(breakBufferTicks)
            && UsrSettingsBounds.zoneMitigationPercent.contains(zoneMitigationPercent)
            && UsrSettingsBounds.poolClusterThreshold.contains(poolClusterThreshold)
            && UsrSettingsBounds.poolAtrFactor.contains(poolAtrFactor)
            && UsrSettingsBounds.maxSupportPools.contains(maxSupportPools)
            && UsrSettingsBounds.maxResistancePools.contains(maxResistancePools)
            && UsrSettingsBounds.fvgFillPercent.contains(fvgFillPercent)
            && UsrSettingsBounds.fvgLookback.contains(fvgLookback)
            && UsrSettingsBounds.fvgBodyPercent.contains(fvgBodyPercent)
            && UsrSettingsBounds.fvgWickPercent.contains(fvgWickPercent)
            && UsrSettingsBounds.maxVisibleFvgs.contains(maxVisibleFvgs)
            && UsrSettingsBounds.fvgMaxBarsActive.contains(fvgMaxBarsActive)
            && UsrSettingsBounds.fvgMinGapAtr.contains(fvgMinGapAtr)
            && UsrSettingsBounds.fvgMinBodyAtr.contains(fvgMinBodyAtr)
            && colors.allSatisfy(ScriptColor.isValid)
    }
}
