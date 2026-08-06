import Foundation

/// Pure event simulator mirroring computeUsr.ts and the confirmed-bar Pine
/// state machine. No UIKit/SwiftUI dependencies belong in this layer.
enum UsrEngine {
    enum Constants {
        static let minimumAge = 3
        static let signalCooldown = 20
        static let maximumSignals = 2
        static let maximumCandidateKeys = 2_000
        static let maximumStoredFvgs = 100
        static let confluenceThreshold = 0.3
        static let maximumConfluenceCandidates = 45
        static let maximumConfluences = 60
        static let maximumClusterLevels = 250
        static let maximumZoneLines = 450
        static let supportBase = "#2196F3"
        static let resistanceBase = "#9C27B0"
        static let support = "rgba(33, 150, 243, 0.30)"
        static let resistance = "rgba(156, 39, 176, 0.30)"
        static let flippedSupport = "rgba(8, 153, 129, 0.30)"
        static let flippedResistance = "rgba(255, 152, 0, 0.30)"
        static let confluenceSupport = "rgba(0, 230, 118, 0.30)"
        static let confluenceSupportBorder = "rgba(0, 230, 118, 0.70)"
        static let confluenceResistance = "rgba(224, 64, 251, 0.30)"
        static let confluenceResistanceBorder = "rgba(224, 64, 251, 0.70)"
        static let confluenceMixed = "rgba(255, 255, 255, 0.25)"
        static let confluenceMixedBorder = "rgba(255, 255, 255, 0.80)"
        static let bullishBounce = "#00E676"
        static let bearishBounce = "#880E4F"
        static let bullishSweep = "#4CAF50"
        static let bearishSweep = "#F23645"
        static let poolSweptBorder = "rgba(253, 216, 53, 0.70)"
    }

    final class Runtime {
        let settings: UsrSettings
        let analysis: [UsrAnalysisCandle]
        let timeframeTag: String
        var processed = Set<String>()
        var processedOrder: [String] = []
        var support: [UsrZone] = []
        var resistance: [UsrZone] = []
        var supportPools: [UsrPool] = []
        var resistancePools: [UsrPool] = []
        var bullishFvgs: [UsrFvg] = []
        var bearishFvgs: [UsrFvg] = []
        var supportConfluence: [UsrConfluence] = []
        var resistanceConfluence: [UsrConfluence] = []
        var mixedConfluence: [UsrConfluence] = []
        var signals: [UsrSignal] = []
        var identity = 0
        var analysisBarId = -1
        var sequenceLength = 0
        var zonesChanged = false
        var lastConfluenceBuild = -1
        var lastPoolBuild = -1
        var previousBull: UsrSignal?
        var previousBear: UsrSignal?

        init(settings: UsrSettings, analysis: [UsrAnalysisCandle], timeframeTag: String) {
            self.settings = settings
            self.analysis = analysis
            self.timeframeTag = timeframeTag
        }
    }

    struct ZoneDraft {
        let top: Double
        let bottom: Double
        let origin: Int
        let support: Bool
        let relativeVolume: Double
        let detection: Int
        var flipped = false
        var parent: UsrZone? = nil
    }

    static func above(_ runtime: Runtime, _ price: Double, _ boundary: Double) -> Bool {
        price >= boundary + runtime.settings.minimumTick * Double(runtime.settings.breakBufferTicks)
    }

    static func below(_ runtime: Runtime, _ price: Double, _ boundary: Double) -> Bool {
        price <= boundary - runtime.settings.minimumTick * Double(runtime.settings.breakBufferTicks)
    }

    static func force(_ runtime: Runtime, _ candle: UsrAnalysisCandle) -> Bool {
        UsrMath.isVolumeAnomaly(candle, runtime.settings)
            || displacement(runtime, candle, bullish: true)
            || displacement(runtime, candle, bullish: false)
    }

    /// Pine substitutes 2% of price while chart ATR is seeding, and the latest
    /// confirmed true range while requested-timeframe ATR is warming.
    static func activeAtr(_ runtime: Runtime, _ candle: UsrAnalysisCandle) -> Double {
        if let atr = candle.atr { return atr }
        if runtime.timeframeTag == "chart" {
            return max(abs(candle.close) * 0.02, runtime.settings.minimumTick)
        }
        return max(candle.high - candle.low, runtime.settings.minimumTick)
    }

    static func displacement(_ runtime: Runtime, _ candle: UsrAnalysisCandle, bullish: Bool) -> Bool {
        var candleWithAtr = candle
        candleWithAtr.atr = activeAtr(runtime, candle)
        return UsrMath.displacement(candleWithAtr, bullish: bullish, settings: runtime.settings)
    }

    static func strength(_ zone: UsrZone, _ analysisBar: Int) -> Double {
        let normalized = UsrMath.clamp((zone.volumeRatio - 1) / 2, 0, 1)
        let volume = 0.35 + normalized * 0.65
        let age = 1 / (1 + Double(max(analysisBar - zone.analysisBirth, 0)) / 750)
        let touch = pow(0.84, Double(max(zone.touchCount - 1, 0)))
        let state = zone.state == .fresh ? 1.0 : zone.state == .tested ? 0.88 : 0.62
        return UsrMath.clamp(volume * age * touch * state * (zone.isFlipped ? 0.82 : 1), 0.05, 1)
    }

    /// Pine's bounded selectors add a small, causal recency component to strength.
    static func recencyAdjustedPriority(_ strength: Double, start: Int, currentChartBar: Int) -> Double {
        strength + (currentChartBar > 0 ? Double(start) / Double(currentChartBar) * 0.001 : 0)
    }

    static func invalidates(
        _ runtime: Runtime,
        candle: UsrAnalysisCandle,
        previous: UsrAnalysisCandle?,
        top: Double,
        bottom: Double,
        support: Bool
    ) -> Bool {
        let forceBreak = force(runtime, candle)
            && (support ? below(runtime, candle.close, bottom) : above(runtime, candle.close, top))
        if forceBreak { return true }
        guard let previous else { return false }
        let threshold = activeAtr(runtime, candle) * runtime.settings.gapAtrMultiplier
        if support {
            return previous.low > top && below(runtime, candle.high, bottom)
                && below(runtime, candle.close, bottom) && previous.low - candle.high >= threshold
        }
        return previous.high < bottom && above(runtime, candle.low, top)
            && above(runtime, candle.close, top) && candle.low - previous.high >= threshold
    }

    static func broken(
        _ runtime: Runtime,
        top: Double,
        bottom: Double,
        support: Bool,
        origin: Int,
        detection: Int
    ) -> Bool {
        guard origin < detection else { return false }
        for index in max(origin + 1, detection - 99)...detection where
            invalidates(
                runtime,
                candle: runtime.analysis[index],
                previous: index > 0 ? runtime.analysis[index - 1] : nil,
                top: top,
                bottom: bottom,
                support: support
            ) {
            return true
        }
        return false
    }

    @discardableResult
    static func createZone(_ runtime: Runtime, _ draft: ZoneDraft) -> Int? {
        guard draft.top.isFinite, draft.bottom.isFinite, draft.top >= draft.bottom,
              !broken(runtime, top: draft.top, bottom: draft.bottom, support: draft.support,
                      origin: draft.origin, detection: draft.detection)
        else { return nil }
        let source = runtime.analysis[draft.origin]
        let tick = runtime.settings.minimumTick
        let topKey = UsrMath.quantizedPriceKey(draft.top, minimumTick: tick)
        let bottomKey = UsrMath.quantizedPriceKey(draft.bottom, minimumTick: tick)
        let key = "\(runtime.timeframeTag)|\(source.chartEnd)|\(draft.support ? "S" : "R")|\(topKey)|\(bottomKey)"
        if !draft.flipped {
            guard runtime.processed.insert(key).inserted else { return nil }
            runtime.processedOrder.append(key)
            if runtime.processedOrder.count > Constants.maximumCandidateKeys {
                runtime.processed.remove(runtime.processedOrder.removeFirst())
            }
        }
        runtime.identity += 1
        let zone = UsrZone(
            id: runtime.identity,
            sourceId: draft.parent?.sourceId ?? runtime.identity,
            analysisBirth: draft.detection,
            top: draft.top,
            bottom: draft.bottom,
            startBar: draft.flipped ? runtime.analysis[draft.detection].chartEnd : source.chartEnd,
            sourceTime: draft.parent?.sourceTime ?? source.time,
            detectedTime: runtime.analysis[draft.detection].closeTime,
            activeTime: draft.flipped
                ? runtime.analysis[draft.detection].closeTime
                : runtime.analysis[draft.detection].eventTime,
            activationBar: runtime.analysis[draft.detection].eventChartIndex,
            isSupport: draft.support,
            volumeRatio: max(draft.relativeVolume, 0),
            isFlipped: draft.flipped,
            isLine: draft.top == draft.bottom,
            originStartBar: draft.parent.map { $0.originStartBar == 0 ? $0.startBar : $0.originStartBar } ?? 0,
            originZoneId: draft.parent.map { $0.originZoneId == 0 ? $0.id : $0.originZoneId } ?? 0,
            originIsSupport: draft.parent.map { $0.originZoneId == 0 ? $0.isSupport : $0.originIsSupport } ?? true
        )
        if draft.support {
            runtime.support.append(zone)
            runtime.zonesChanged = true
            return runtime.support.count - 1
        }
        runtime.resistance.append(zone)
        runtime.zonesChanged = true
        return runtime.resistance.count - 1
    }

    static func pivot(_ runtime: Runtime, index: Int, low: Bool) -> Bool {
        guard runtime.analysis.indices.contains(index) else { return false }
        let center = low ? runtime.analysis[index].low : runtime.analysis[index].high
        for offset in 1...runtime.settings.pivotLeftBars {
            guard runtime.analysis.indices.contains(index - offset) else { return false }
            let candidate = low ? runtime.analysis[index - offset].low : runtime.analysis[index - offset].high
            if low ? center > candidate : center < candidate { return false }
        }
        for offset in 1...runtime.settings.pivotRightBars {
            guard runtime.analysis.indices.contains(index + offset) else { return false }
            let candidate = low ? runtime.analysis[index + offset].low : runtime.analysis[index + offset].high
            if low ? center > candidate : center < candidate { return false }
        }
        return true
    }

    static func maturePivot(_ runtime: Runtime, detection: Int) {
        let origin = detection - runtime.settings.pivotRightBars
        guard runtime.analysis.indices.contains(origin),
              UsrMath.isVolumeAnomaly(runtime.analysis[origin], runtime.settings)
        else { return }
        let candle = runtime.analysis[origin]
        let ratio = UsrMath.volumeRatio(candle)
        if pivot(runtime, index: origin, low: true) {
            let level = min(candle.open, candle.close)
            createZone(runtime, ZoneDraft(top: level, bottom: level, origin: origin,
                                         support: true, relativeVolume: ratio, detection: detection))
        }
        if pivot(runtime, index: origin, low: false) {
            let level = max(candle.open, candle.close)
            createZone(runtime, ZoneDraft(top: level, bottom: level, origin: origin,
                                         support: false, relativeVolume: ratio, detection: detection))
        }
    }

    static func structure(_ runtime: Runtime, index: Int, high: Bool) -> Double? {
        let start = index - runtime.settings.structureLookback
        guard start >= 0 else { return nil }
        let values = runtime.analysis[start..<index].map { high ? $0.high : $0.low }
        return high ? values.max() : values.min()
    }

    static func sequenceBar(_ runtime: Runtime, index: Int, detection: Int) {
        guard index > 0 else { return }
        let candle = runtime.analysis[index]
        let previous = runtime.analysis[index - 1]
        let ratio = UsrMath.volumeRatio(candle)
        var gapUp = false
        var gapDown = false
        let threshold = activeAtr(runtime, candle) * runtime.settings.gapAtrMultiplier
        if runtime.settings.requirePriceVoidGaps {
            gapUp = candle.low - previous.high >= threshold
            gapDown = previous.low - candle.high >= threshold
        } else {
            gapUp = candle.open - previous.close >= threshold
                && candle.low - previous.close >= threshold
            gapDown = previous.close - candle.open >= threshold
                && previous.close - candle.high >= threshold
        }
        if gapUp {
            createZone(runtime, ZoneDraft(
                top: candle.low,
                bottom: runtime.settings.requirePriceVoidGaps ? previous.high : previous.close,
                origin: index, support: true, relativeVolume: ratio, detection: detection
            ))
        }
        if gapDown {
            createZone(runtime, ZoneDraft(
                top: runtime.settings.requirePriceVoidGaps ? previous.low : previous.close,
                bottom: candle.high, origin: index, support: false,
                relativeVolume: ratio, detection: detection
            ))
        }
        // Full-history simulation must not let a force-chunk inspect the next
        // analysis candle before that candle's event has occurred.
        guard index + 1 <= detection, index + 1 < runtime.analysis.count else { return }
        let follow = runtime.analysis[index + 1]
        let midpoint = (candle.open + candle.close) / 2
        if previous.close < previous.open,
           let high = structure(runtime, index: index, high: true),
           displacement(runtime, candle, bullish: true),
           above(runtime, candle.close, high), follow.close >= midpoint, above(runtime, follow.close, high) {
            createZone(runtime, ZoneDraft(
                top: runtime.settings.orderBlockUseWicks ? previous.high : previous.open,
                bottom: runtime.settings.orderBlockUseWicks ? previous.low : previous.close,
                origin: index - 1, support: true, relativeVolume: ratio, detection: detection
            ))
        }
        if previous.close > previous.open,
           let low = structure(runtime, index: index, high: false),
           displacement(runtime, candle, bullish: false),
           below(runtime, candle.close, low), follow.close <= midpoint, below(runtime, follow.close, low) {
            createZone(runtime, ZoneDraft(
                top: runtime.settings.orderBlockUseWicks ? previous.high : previous.close,
                bottom: runtime.settings.orderBlockUseWicks ? previous.low : previous.open,
                origin: index - 1, support: false, relativeVolume: ratio, detection: detection
            ))
        }
    }

    static func sequence(_ runtime: Runtime, newest: Int, count: Int, detection: Int) {
        for scanned in 0..<count {
            let index = newest - scanned
            guard runtime.analysis.indices.contains(index),
                  UsrMath.isVolumeAnomaly(runtime.analysis[index], runtime.settings)
            else { break }
            sequenceBar(runtime, index: index, detection: detection)
        }
    }

    static func updateState(_ runtime: Runtime, zone: inout UsrZone, candle: UsrAnalysisCandle, index: Int) -> Bool {
        guard zone.isActive, index > zone.analysisBirth else { return false }
        var strengthStateChanged = false
        let height = zone.top - zone.bottom
        let tolerance = activeAtr(runtime, candle) * 0.05
        let epsilon = runtime.settings.minimumTick * Double(runtime.settings.breakBufferTicks)
        let entered = height == 0
            ? candle.low <= zone.top + tolerance && candle.high >= zone.bottom - tolerance
            : candle.low <= zone.top + epsilon && candle.high >= zone.bottom - epsilon
        if entered && !zone.wasInsideLastBar && zone.lastTouchAnalysisBar != index {
            zone.touchCount += 1
            zone.lastTouchAnalysisBar = index
            strengthStateChanged = true
            if zone.state == .fresh { zone.state = .tested }
        }
        if entered && height > 0 {
            let penetration = zone.isSupport
                ? (zone.top - candle.low) / height
                : (candle.high - zone.bottom) / height
            zone.maxPenetration = max(zone.maxPenetration, UsrMath.clamp(penetration, 0, 1))
            if zone.maxPenetration >= runtime.settings.zoneMitigationPercent, zone.state != .mitigated {
                zone.state = .mitigated
                strengthStateChanged = true
            }
        }
        zone.wasInsideLastBar = entered
        return strengthStateChanged
    }

    static func markFlippedLineage(
        _ runtime: Runtime,
        parent: UsrZone,
        parentSupport: Bool,
        parentIndex: Int
    ) {
        if parent.originZoneId == 0 {
            if parentSupport { runtime.support[parentIndex].hasActiveFlippedChild = true }
            else { runtime.resistance[parentIndex].hasActiveFlippedChild = true }
            return
        }
        if parentSupport { runtime.support[parentIndex].hasActiveFlippedChild = false }
        else { runtime.resistance[parentIndex].hasActiveFlippedChild = false }
        if let origin = runtime.support.firstIndex(where: { $0.id == parent.originZoneId }) {
            runtime.support[origin].hasActiveFlippedChild = true
        } else if let origin = runtime.resistance.firstIndex(where: { $0.id == parent.originZoneId }) {
            runtime.resistance[origin].hasActiveFlippedChild = true
        }
    }

    static func lifecycle(_ runtime: Runtime, index: Int) {
        let candle = runtime.analysis[index]
        let previous = index > 0 ? runtime.analysis[index - 1] : nil
        for position in runtime.support.indices.reversed() {
            if runtime.support[position].isActive, index > runtime.support[position].analysisBirth,
               invalidates(runtime, candle: candle, previous: previous,
                           top: runtime.support[position].top, bottom: runtime.support[position].bottom,
                           support: true) {
                let parent = runtime.support[position]
                if runtime.settings.enableSrFlip,
                   createZone(runtime, ZoneDraft(
                       top: parent.top, bottom: parent.bottom, origin: index,
                       support: false, relativeVolume: parent.volumeRatio, detection: index,
                       flipped: true, parent: parent
                   )) != nil {
                    markFlippedLineage(runtime, parent: parent, parentSupport: true, parentIndex: position)
                }
                runtime.support[position].isActive = false
                runtime.support[position].invalidatedTime = candle.closeTime
                runtime.support[position].endBar = candle.chartEnd
                runtime.zonesChanged = true
            }
            if updateState(runtime, zone: &runtime.support[position], candle: candle, index: index) {
                runtime.zonesChanged = true
            }
        }
        let resistanceCount = runtime.resistance.count
        guard resistanceCount > 0 else { return }
        for position in stride(from: resistanceCount - 1, through: 0, by: -1) {
            if runtime.resistance[position].isActive, index > runtime.resistance[position].analysisBirth,
               invalidates(runtime, candle: candle, previous: previous,
                           top: runtime.resistance[position].top, bottom: runtime.resistance[position].bottom,
                           support: false) {
                let parent = runtime.resistance[position]
                if runtime.settings.enableSrFlip,
                   createZone(runtime, ZoneDraft(
                       top: parent.top, bottom: parent.bottom, origin: index,
                       support: true, relativeVolume: parent.volumeRatio, detection: index,
                       flipped: true, parent: parent
                   )) != nil {
                    markFlippedLineage(runtime, parent: parent, parentSupport: false, parentIndex: position)
                }
                runtime.resistance[position].isActive = false
                runtime.resistance[position].invalidatedTime = candle.closeTime
                runtime.resistance[position].endBar = candle.chartEnd
                runtime.zonesChanged = true
            }
            if updateState(runtime, zone: &runtime.resistance[position], candle: candle, index: index) {
                runtime.zonesChanged = true
            }
        }
    }

    static func trim(_ runtime: Runtime) {
        let total = runtime.settings.maxSupportLevels + runtime.settings.maxResistanceLevels
        let supportSurplus = max(0, runtime.settings.maxSupportLevels - runtime.support.count)
        let resistanceSurplus = max(0, runtime.settings.maxResistanceLevels - runtime.resistance.count)
        let supportMaximum = max(1, min(runtime.settings.maxSupportLevels + resistanceSurplus,
            total - min(runtime.resistance.count, runtime.settings.maxResistanceLevels)))
        let resistanceMaximum = max(1, min(runtime.settings.maxResistanceLevels + supportSurplus,
            total - min(runtime.support.count, runtime.settings.maxSupportLevels)))
        if runtime.support.count > supportMaximum {
            let removed = Array(runtime.support.prefix(runtime.support.count - supportMaximum))
            runtime.support.removeFirst(removed.count)
            releaseTrimmedFlipOrigins(runtime, removed: removed)
            runtime.zonesChanged = true
        }
        if runtime.resistance.count > resistanceMaximum {
            let removed = Array(runtime.resistance.prefix(runtime.resistance.count - resistanceMaximum))
            runtime.resistance.removeFirst(removed.count)
            releaseTrimmedFlipOrigins(runtime, removed: removed)
            runtime.zonesChanged = true
        }
    }

    static func releaseTrimmedFlipOrigins(_ runtime: Runtime, removed: [UsrZone]) {
        let originIds = Set(removed.filter { $0.isFlipped && $0.originZoneId > 0 }.map(\.originZoneId))
        guard !originIds.isEmpty else { return }
        for index in runtime.support.indices where originIds.contains(runtime.support[index].id) {
            runtime.support[index].hasActiveFlippedChild = false
        }
        for index in runtime.resistance.indices where originIds.contains(runtime.resistance[index].id) {
            runtime.resistance[index].hasActiveFlippedChild = false
        }
    }

    static func processZones(_ runtime: Runtime, index: Int) {
        runtime.analysisBarId = index
        runtime.zonesChanged = false
        maturePivot(runtime, detection: index)
        let anomaly = UsrMath.isVolumeAnomaly(runtime.analysis[index], runtime.settings)
        if anomaly {
            runtime.sequenceLength += 1
            if runtime.sequenceLength >= runtime.settings.maxSequenceLength {
                sequence(runtime, newest: index, count: runtime.sequenceLength, detection: index)
                runtime.sequenceLength = 1
            }
        } else {
            if index > 0, UsrMath.isVolumeAnomaly(runtime.analysis[index - 1], runtime.settings),
               runtime.sequenceLength > 0 {
                sequence(runtime, newest: index - 1, count: runtime.sequenceLength, detection: index)
            }
            runtime.sequenceLength = 0
        }
        lifecycle(runtime, index: index)
        trim(runtime)
    }

    static func compute(
        candles: [Candle],
        settings: UsrSettings,
        chartIntervalSeconds: TimeInterval?,
        now: Date = Date(),
        lastCandleIsOpen: Bool? = nil
    ) -> UsrComputation? {
        guard settings.enabled, settings.isValid, !candles.isEmpty else { return nil }
        let prepared = UsrTimeframe.prepare(candles: candles, settings: settings,
            chartSeconds: chartIntervalSeconds, now: now, lastCandleIsOpen: lastCandleIsOpen)
        let runtime = Runtime(settings: settings, analysis: prepared.analysisCandles,
            timeframeTag: prepared.timeframeTag)
        var events: [Int: [Int]] = [:]
        for (index, candle) in prepared.analysisCandles.enumerated() {
            events[candle.eventChartIndex, default: []].append(index)
        }
        let chartAtr = UsrMath.atr(prepared.chartCandles)
        for chartIndex in prepared.chartCandles.indices {
            for analysisIndex in events[chartIndex] ?? [] {
                processZones(runtime, index: analysisIndex)
                processDerived(runtime)
                processFvgs(runtime)
            }
            let fallback = max(abs(prepared.chartCandles[chartIndex].close) * 0.02, settings.minimumTick)
            processSignals(runtime, candles: prepared.chartCandles, chartIndex: chartIndex,
                           chartAtr: chartAtr[chartIndex] ?? fallback)
        }
        let last = max(0, prepared.chartCandles.count - 1)
        let reference = prepared.chartCandles.indices.contains(last) ? prepared.chartCandles[last].close : 0
        return UsrComputation(
            renderModel: render(runtime, lastBar: last, reference: reference),
            supportZones: runtime.support,
            resistanceZones: runtime.resistance,
            supportConfluence: runtime.supportConfluence,
            resistanceConfluence: runtime.resistanceConfluence,
            mixedConfluence: runtime.mixedConfluence,
            supportPools: runtime.supportPools,
            resistancePools: runtime.resistancePools,
            bullishFvgs: runtime.bullishFvgs,
            bearishFvgs: runtime.bearishFvgs,
            signals: runtime.signals,
            warnings: prepared.warnings
        )
    }
}
