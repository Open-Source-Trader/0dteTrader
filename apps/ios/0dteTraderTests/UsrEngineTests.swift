import XCTest
@testable import ZeroDTETrader

final class UsrEngineTests: XCTestCase {
    func testContinuousMarketClassificationUsesTheSymbolPickerCatalog() {
        XCTAssertTrue(ChartSymbolCatalog.cryptoSymbols.allSatisfy(
            ChartSymbolCatalog.isContinuousMarket
        ))
        XCTAssertTrue(ChartSymbolCatalog.isContinuousMarket(" btc\n"))
        XCTAssertTrue(ChartSymbolCatalog.isContinuousMarket("ETH"))
        XCTAssertFalse(ChartSymbolCatalog.isContinuousMarket("SPY"))
        XCTAssertFalse(ChartSymbolCatalog.isContinuousMarket("BTCUSD"))
    }

    private func history(start: TimeInterval = 1_700_000_000) -> [Candle] {
        (0..<24).map { index in
            let center = index == 12 ? 90 : 100 + sin(Double(index) / 2)
            return Candle(
                time: Date(timeIntervalSince1970: start + Double(index * 60)),
                open: center,
                high: center + 2,
                low: center - 2,
                close: center + 1,
                volume: index == 12 ? 300 : 100
            )
        }
    }

    private func settings() -> UsrSettings {
        var value = UsrSettings.default
        value.enabled = true
        value.volumeLookback = 10
        value.minimumRelativeVolume = 1
        value.minimumVolumeZScore = 0
        value.pivotLeftBars = 3
        value.pivotRightBars = 1
        return value
    }

    private func analysisCandle(
        _ index: Int,
        open: Double = 100,
        high: Double = 101,
        low: Double = 99,
        close: Double = 100,
        volume: Double = 100,
        chartEnd: Int? = nil,
        eventChartIndex: Int? = nil
    ) -> UsrAnalysisCandle {
        let time = Date(timeIntervalSince1970: 1_700_000_000 + Double(index * 60))
        return UsrAnalysisCandle(
            time: time, open: open, high: high, low: low, close: close, volume: volume,
            chartStart: index, chartEnd: chartEnd ?? index,
            eventChartIndex: eventChartIndex ?? index,
            eventTime: time.addingTimeInterval(60), closeTime: time.addingTimeInterval(60),
            regularSession: true, atr: 1, volumeMean: 100, volumeStd: 1
        )
    }

    private func zone(
        _ id: Int,
        top: Double = 101,
        bottom: Double = 99,
        line: Bool = false
    ) -> UsrZone {
        let time = Date(timeIntervalSince1970: 1_700_000_000 + Double(id * 60))
        return UsrZone(
            id: id, sourceId: id, analysisBirth: 0, top: top, bottom: bottom,
            startBar: id, sourceTime: time, detectedTime: time, activeTime: time,
            activationBar: id, isSupport: true, volumeRatio: 3,
            isFlipped: false, isLine: line, originStartBar: 0,
            originZoneId: 0, originIsSupport: true
        )
    }

    func testConfirmedVolumePivotIsDeterministic() throws {
        let candles = history()
        let now = try XCTUnwrap(candles.last?.time.addingTimeInterval(120))
        let first = try XCTUnwrap(UsrEngine.compute(
            candles: candles, settings: settings(), chartIntervalSeconds: 60, now: now
        ))
        let second = try XCTUnwrap(UsrEngine.compute(
            candles: candles, settings: settings(), chartIntervalSeconds: 60, now: now
        ))
        XCTAssertTrue(first.supportZones.contains { $0.isLine && $0.startBar == 12 })
        XCTAssertEqual(first.supportZones.map(\.id), second.supportZones.map(\.id))
        XCTAssertEqual(first.signals.map(\.sourceKey), second.signals.map(\.sourceKey))
    }

    func testOpenRealtimeCandleCannotMutateConfirmedState() throws {
        let candles = history()
        let now = try XCTUnwrap(candles.last?.time.addingTimeInterval(90))
        let live = Candle(time: now.addingTimeInterval(-30), open: 100, high: 150,
                          low: 50, close: 55, volume: 1_000_000)
        let base = try XCTUnwrap(UsrEngine.compute(
            candles: candles, settings: settings(), chartIntervalSeconds: 60, now: now
        ))
        let withLive = try XCTUnwrap(UsrEngine.compute(
            candles: candles + [live], settings: settings(), chartIntervalSeconds: 60, now: now
        ))
        XCTAssertEqual(base.supportZones.map(\.id), withLive.supportZones.map(\.id))
        XCTAssertEqual(base.resistanceZones.map(\.id), withLive.resistanceZones.map(\.id))
        XCTAssertEqual(base.signals.map(\.sourceKey), withLive.signals.map(\.sourceKey))
    }

    func testOpenRealtimeCandleExtendsOnlyThePresentationClock() throws {
        let candles = history()
        let now = try XCTUnwrap(candles.last?.time.addingTimeInterval(90))
        let live = Candle(time: now.addingTimeInterval(-30), open: 100, high: 101,
                          low: 99, close: 100, volume: 100)
        var renderSettings = settings()
        renderSettings.enableProximityFilter = false
        let base = try XCTUnwrap(UsrEngine.compute(
            candles: candles, settings: renderSettings, chartIntervalSeconds: 60, now: now
        ))
        let withLive = try XCTUnwrap(UsrEngine.compute(
            candles: candles + [live], settings: renderSettings,
            chartIntervalSeconds: 60, now: now
        ))
        let baseSegment = try XCTUnwrap(base.renderModel.segments.first)
        let liveSegment = try XCTUnwrap(withLive.renderModel.segments.first)
        XCTAssertEqual(liveSegment.x2, baseSegment.x2 + 1)
        XCTAssertEqual(base.supportZones.map(\.id), withLive.supportZones.map(\.id))
    }

    func testHtfOriginUsesSourceEndWithoutBackpainting() throws {
        let start = 1_699_920_000.0
        let candles = (0..<52).map { index in
            let group = index / 4
            let center = group == 10 ? 90.0 : 100.0
            return Candle(
                time: Date(timeIntervalSince1970: start + Double(index * 3_600)),
                open: center,
                high: center + 2,
                low: center - 2,
                close: center + 1,
                volume: group == 10 ? 300 : 100
            )
        }
        var value = settings()
        value.analysisTimeframe = "4h"
        let result = try XCTUnwrap(UsrEngine.compute(
            candles: candles,
            settings: value,
            chartIntervalSeconds: 3_600,
            now: try XCTUnwrap(candles.last?.time.addingTimeInterval(7_200))
        ))
        let pivot = result.supportZones.first { $0.isLine && $0.top == 90 && $0.bottom == 90 }
        XCTAssertEqual(pivot?.startBar, 43)
        XCTAssertEqual(pivot?.activationBar, 48)
    }

    func testSettingsRoundTripAndRejectInvalidPayload() throws {
        let suite = "UsrEngineTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = SettingsStore(defaults: defaults)
        var value = settings()
        value.analysisTimeframe = "4h"
        store.usrSettings = value
        XCTAssertEqual(store.usrSettings, value)
        value.minimumTick = 0
        store.usrSettings = value
        XCTAssertNotEqual(store.usrSettings.minimumTick, 0)
    }

    func testEveryBoundedSettingIsValidatedBeforePersistence() throws {
        let suite = "UsrEngineTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = SettingsStore(defaults: defaults)
        var value = settings()
        value.poolClusterThreshold = 11
        store.usrSettings = value
        XCTAssertEqual(store.usrSettings, .default)
        value = settings()
        value.fvgBodyPercent = .infinity
        store.usrSettings = value
        XCTAssertEqual(store.usrSettings, .default)
        value = settings()
        value.fvgBullishColor = "not-a-color"
        store.usrSettings = value
        XCTAssertEqual(store.usrSettings, .default)
        value = settings()
        value.customTimeframe = "2H"
        store.usrSettings = value
        XCTAssertEqual(store.usrSettings, .default)
    }

    func testForceChunkCannotReadFutureFollowThrough() throws {
        let start = 1_700_000_000.0
        var candles = (0..<18).map { index in
            Candle(time: Date(timeIntervalSince1970: start + Double(index * 60)),
                   open: 99, high: 101, low: 98, close: 100, volume: 100)
        }
        candles[14] = Candle(time: candles[14].time, open: 100, high: 101,
                             low: 98, close: 99, volume: 300)
        candles[15] = Candle(time: candles[15].time, open: 99, high: 110.5,
                             low: 98.5, close: 110, volume: 300)
        candles[16] = Candle(time: candles[16].time, open: 107, high: 109,
                             low: 106, close: 108, volume: 100)
        var value = settings()
        value.maxSequenceLength = 2
        value.structureLookback = 2
        value.displacementAtrMultiplier = 0.2
        let result = try XCTUnwrap(UsrEngine.compute(
            candles: candles, settings: value, chartIntervalSeconds: 60,
            now: try XCTUnwrap(candles.last?.time.addingTimeInterval(120))
        ))
        let orderBlock = result.supportZones.first {
            $0.startBar == 14 && $0.top == 100 && $0.bottom == 99
        }
        XCTAssertEqual(orderBlock?.analysisBirth, 16)
    }

    func testQueuedSourceIdentityAndReverseSameSideCommitMatchPine() throws {
        let start = 1_700_000_000.0
        var candles = (0..<16).map { index in
            Candle(time: Date(timeIntervalSince1970: start + Double(index * 60)),
                   open: 100, high: 101, low: 99, close: 100, volume: 100)
        }
        candles[12] = Candle(time: candles[12].time, open: 110,
                             high: 111, low: 109, close: 110.5, volume: 300)
        candles[13] = Candle(time: candles[13].time, open: 120,
                             high: 121, low: 119, close: 120.5, volume: 300)
        candles[14] = Candle(time: candles[14].time, open: 120,
                             high: 121, low: 119, close: 120, volume: 100)
        candles[15] = Candle(time: candles[15].time, open: 120,
                             high: 121, low: 119, close: 120, volume: 100)
        var value = settings()
        value.minimumRelativeVolume = 2
        value.minimumVolumeZScore = 0.5
        value.pivotRightBars = 5
        value.requirePriceVoidGaps = true
        value.showFvg = false
        let result = try XCTUnwrap(UsrEngine.compute(
            candles: candles, settings: value, chartIntervalSeconds: 60,
            now: try XCTUnwrap(candles.last?.time.addingTimeInterval(120))
        ))
        let gaps = result.supportZones.filter {
            !$0.isLine && ($0.startBar == 12 || $0.startBar == 13)
        }
        XCTAssertEqual(gaps.map(\.startBar), [12, 13])
        XCTAssertEqual(gaps.map(\.sourceId), [2, 1])
        XCTAssertEqual(gaps.map(\.id), [3, 4])
    }

    func testSimultaneousFlipIdentityUsesPineNewestFirstSideOrder() {
        let analysis = [
            analysisCandle(0),
            analysisCandle(1, open: 100, high: 101, low: 89, close: 90)
        ]
        let runtime = UsrEngine.Runtime(settings: settings(), analysis: analysis, timeframeTag: "chart")
        runtime.identity = 20
        runtime.support = [
            zone(10, top: 96, bottom: 95),
            zone(20, top: 94, bottom: 93)
        ]

        UsrEngine.processZones(runtime, index: 1)

        XCTAssertEqual(runtime.support.map(\.isActive), [false, false])
        XCTAssertEqual(runtime.resistance.map(\.originZoneId), [20, 10])
        XCTAssertEqual(runtime.resistance.map(\.id), [21, 22])
    }

    func testChartAtrWarmupUsesPinePriceFallback() throws {
        let start = 1_700_000_000.0
        var candles = (0..<8).map { index in
            Candle(time: Date(timeIntervalSince1970: start + Double(index * 60)),
                   open: 100, high: 100.6, low: 99.6, close: 100.2, volume: 100)
        }
        candles[2] = Candle(time: candles[2].time, open: 100,
                            high: 101, low: 99, close: 100.2, volume: 100)
        candles[3] = Candle(time: candles[3].time, open: 101,
                            high: 106.1, low: 100.9, close: 106, volume: 100)
        candles[4] = Candle(time: candles[4].time, open: 103,
                            high: 104, low: 102, close: 103.5, volume: 100)
        var value = settings()
        value.fvgLookback = 3
        value.fvgBodyPercent = 0.05
        value.fvgMinBodyAtr = 0
        value.fvgMinGapAtr = 0
        let result = try XCTUnwrap(UsrEngine.compute(
            candles: candles, settings: value, chartIntervalSeconds: 60,
            now: try XCTUnwrap(candles.last?.time.addingTimeInterval(120))
        ))
        XCTAssertEqual(result.bullishFvgs.count, 1)
    }

    func testFvgCloseMilestoneUsesConfiguredTickBuffer() throws {
        let start = 1_700_000_000.0
        var candles = (0..<6).map { index in
            Candle(time: Date(timeIntervalSince1970: start + Double(index * 60)),
                   open: 100, high: 100.6, low: 99.6, close: 100.2, volume: 100)
        }
        candles[2] = Candle(time: candles[2].time, open: 100,
                            high: 101, low: 99, close: 100.2, volume: 100)
        candles[3] = Candle(time: candles[3].time, open: 101,
                            high: 106.1, low: 100.9, close: 106, volume: 100)
        candles[4] = Candle(time: candles[4].time, open: 103,
                            high: 104, low: 102, close: 103.5, volume: 100)
        candles[5] = Candle(time: candles[5].time, open: 102.03,
                            high: 102.2, low: 102.02, close: 102.04, volume: 100)
        var oneTick = settings()
        oneTick.fvgFillMode = "close"
        oneTick.fvgLookback = 3
        oneTick.fvgBodyPercent = 0.05
        oneTick.fvgMinBodyAtr = 0
        oneTick.fvgMinGapAtr = 0
        var fiveTicks = oneTick
        oneTick.breakBufferTicks = 1
        fiveTicks.breakBufferTicks = 5
        let now = try XCTUnwrap(candles.last?.time.addingTimeInterval(120))
        let one = try XCTUnwrap(UsrEngine.compute(
            candles: candles, settings: oneTick, chartIntervalSeconds: 60, now: now
        ))
        let five = try XCTUnwrap(UsrEngine.compute(
            candles: candles, settings: fiveTicks, chartIntervalSeconds: 60, now: now
        ))
        XCTAssertFalse(try XCTUnwrap(one.bullishFvgs.first).milestoneReached)
        XCTAssertTrue(try XCTUnwrap(five.bullishFvgs.first).milestoneReached)
    }

    func testWeeklyAutoUsesCalendarMonthBuckets() throws {
        let calendar = Calendar(identifier: .gregorian)
        let start = try XCTUnwrap(calendar.date(from: DateComponents(
            timeZone: TimeZone(secondsFromGMT: 0), year: 2026, month: 1, day: 5
        )))
        let candles = (0..<10).map { index in
            Candle(time: start.addingTimeInterval(Double(index * 7 * 86_400)),
                   open: 100, high: 101, low: 99, close: 100, volume: 100)
        }
        var value = settings()
        value.analysisTimeframe = "auto"
        let prepared = UsrTimeframe.prepare(
            candles: candles, settings: value, chartSeconds: 7 * 86_400,
            now: try XCTUnwrap(candles.last?.time.addingTimeInterval(8 * 86_400))
        )
        XCTAssertEqual(prepared.timeframeTag, "1M")
        XCTAssertEqual(prepared.analysisCandles.count, 2)
    }

    func testEqualDurationDifferentClockRemainsAlternate() throws {
        let start = Date(timeIntervalSince1970: 1_700_006_400)
        let candles = (0..<5).map { index in
            Candle(time: start.addingTimeInterval(Double(index * 86_400)),
                   open: 100, high: 101, low: 99, close: 100, volume: 100)
        }
        var value = settings()
        value.analysisTimeframe = "custom"
        value.customTimeframe = "1440"
        let prepared = UsrTimeframe.prepare(
            candles: candles, settings: value, chartSeconds: 86_400,
            now: try XCTUnwrap(candles.last?.time.addingTimeInterval(2 * 86_400))
        )
        XCTAssertFalse(prepared.usedChartTimeframe)
        XCTAssertEqual(prepared.analysisCandles.count, 4)
    }

    func testCompletedTickCandlesAreAllRetained() throws {
        let candles = history()
        let prepared = UsrTimeframe.prepare(
            candles: candles,
            settings: settings(),
            chartSeconds: nil,
            now: try XCTUnwrap(candles.last?.time),
            lastCandleIsOpen: false
        )
        XCTAssertEqual(prepared.chartCandles.count, candles.count)
        XCTAssertEqual(prepared.analysisCandles.count, candles.count)
    }

    func testPersistedSettingsDecodeAndRejectWrongTypes() throws {
        let partial = Data(#"{"enabled":true,"volumeLookback":50}"#.utf8)
        let decoded = try JSONDecoder().decode(UsrSettings.self, from: partial)
        XCTAssertTrue(decoded.enabled)
        XCTAssertEqual(decoded.volumeLookback, 50)
        XCTAssertEqual(decoded.fvgFillMode, UsrSettings.default.fvgFillMode)
        XCTAssertEqual(decoded.ifvgBearishColor, UsrSettings.default.ifvgBearishColor)

        let wrongType = Data(#"{"enabled":"true"}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(UsrSettings.self, from: wrongType))
    }

    func testScriptColorParserRejectsMalformedValuesAndClampsOpacity() {
        XCTAssertTrue(ScriptColor.isValid("#A1B2C3"))
        XCTAssertTrue(ScriptColor.isValid("rgba(1, 2, 3, 0.5)"))
        XCTAssertFalse(ScriptColor.isValid("rgbfoo(1, 2, 3)"))
        XCTAssertFalse(ScriptColor.isValid("rgb(1,,3)"))
        XCTAssertFalse(ScriptColor.isValid("rgb(0x10, 2, 3)"))
        XCTAssertFalse(ScriptColor.isValid("rgba(1, 2, 3, 2)"))
        XCTAssertEqual(ScriptColor.withOpacity("#FF0000", 2), "rgba(255, 0, 0, 1.0)")
        XCTAssertEqual(ScriptColor.withOpacity("#FF0000", -1), "rgba(255, 0, 0, 0.0)")
    }

    func testQuantizedIdentityUsesPineUpwardMidpointRounding() {
        XCTAssertEqual(UsrMath.quantizedPriceKey(1.5, minimumTick: 1), "2")
        XCTAssertEqual(UsrMath.quantizedPriceKey(-1.5, minimumTick: 1), "-1")
        XCTAssertEqual(UsrMath.quantizedPriceKey(-0.5, minimumTick: 1), "0")
        XCTAssertEqual(
            UsrMath.quantizedPriceKey(1e20, minimumTick: 0.000_001),
            "bits:4554adf4b7320335"
        )
        XCTAssertEqual(
            UsrMath.quantizedPriceKey(Double.greatestFiniteMagnitude, minimumTick: 0.000_001),
            "price-bits:7fefffffffffffff"
        )
    }

    func testPineTimeframeAliasesAndTickClockFallback() throws {
        XCTAssertEqual(UsrTimeframe.parse("D")?.tag, "1D")
        XCTAssertEqual(UsrTimeframe.parse("W")?.tag, "1W")
        XCTAssertEqual(UsrTimeframe.parse("M")?.tag, "1M")
        XCTAssertEqual(UsrTimeframe.parse("S")?.tag, "1S")
        XCTAssertEqual(UsrTimeframe.parse("T")?.ticks, 1)
        XCTAssertEqual(UsrTimeframe.parse("1000T")?.ticks, 1_000)
        XCTAssertNil(UsrTimeframe.parse("25T"))
        XCTAssertNil(UsrTimeframe.parse("1H"))

        let candles = (0..<21).map { index in
            Candle(time: Date(timeIntervalSince1970: 1_700_000_000 + Double(index)),
                   open: 100, high: 101, low: 99, close: 100, volume: 10)
        }
        var value = settings()
        value.analysisTimeframe = "custom"
        value.customTimeframe = "100T"
        let prepared = UsrTimeframe.prepare(
            candles: candles, settings: value, chartSeconds: nil,
            now: try XCTUnwrap(candles.last?.time), lastCandleIsOpen: false
        )
        XCTAssertTrue(prepared.usedChartTimeframe)
        XCTAssertEqual(prepared.timeframeTag, "chart")
        XCTAssertEqual(prepared.analysisCandles.count, 21)
    }

    func testDuplicateTimestampKeepsLastProviderCorrection() {
        let time = Date(timeIntervalSince1970: 1_700_000_000)
        let first = Candle(time: time, open: 10, high: 12, low: 9, close: 11, volume: 10)
        let correction = Candle(time: time, open: 10, high: 12, low: 9, close: 11.5, volume: 20)
        let prepared = UsrTimeframe.prepare(
            candles: [first, correction], settings: settings(), chartSeconds: 60,
            now: time.addingTimeInterval(120), lastCandleIsOpen: false
        )
        XCTAssertEqual(prepared.chartCandles, [correction])
        XCTAssertEqual(prepared.warnings.count, 1)
    }

    func testContinuousMarketVolumeUsesOneExchangeSession() throws {
        var candles: [Candle] = []
        var date = Date(timeIntervalSince1970: 1_767_571_200) // 2026-01-05 00:00 UTC.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        var weekdays = 0
        while weekdays < 10 {
            let weekday = calendar.component(.weekday, from: date)
            if weekday != 1 && weekday != 7 {
                candles.append(Candle(time: date.addingTimeInterval(15 * 3_600),
                    open: 100, high: 101, low: 99, close: 100, volume: 100))
                candles.append(Candle(time: date.addingTimeInterval(22 * 3_600),
                    open: 100, high: 101, low: 99, close: 100, volume: 10))
                weekdays += 1
            }
            date = date.addingTimeInterval(86_400)
        }
        while [1, 7].contains(calendar.component(.weekday, from: date)) {
            date = date.addingTimeInterval(86_400)
        }
        let finalTime = date.addingTimeInterval(15 * 3_600)
        candles.append(Candle(time: finalTime, open: 100, high: 101, low: 99, close: 100, volume: 100))
        var value = settings()
        value.volumeLookback = 10
        let regular = UsrTimeframe.prepare(
            candles: candles, settings: value, chartSeconds: 60,
            now: finalTime.addingTimeInterval(120), lastCandleIsOpen: false
        )
        let continuous = UsrTimeframe.prepare(
            candles: candles, settings: value, chartSeconds: 60, continuousSession: true,
            now: finalTime.addingTimeInterval(120), lastCandleIsOpen: false
        )
        XCTAssertEqual(try XCTUnwrap(regular.analysisCandles.last?.volumeMean), 100, accuracy: 0.000_001)
        XCTAssertEqual(try XCTUnwrap(continuous.analysisCandles.last?.volumeMean), 55, accuracy: 0.000_001)
    }

    func testConfluenceBudgetsAndPoolIdentityFollowPineOrder() throws {
        var value = settings()
        value.showConfluence = true
        value.showLiquidityPools = false
        value.showFvg = false
        value.enableProximityFilter = false
        value.poolClusterThreshold = 3
        let runtime = UsrEngine.Runtime(
            settings: value, analysis: [analysisCandle(0), analysisCandle(1)], timeframeTag: "chart"
        )
        runtime.analysisBarId = 0
        runtime.resistanceConfluence = (0..<40).map { index in
            UsrConfluence(top: 110 + Double(index), bottom: 109 + Double(index),
                           startBar: 0, isMixed: false, memberIds: [], strength: 1)
        }
        runtime.mixedConfluence = (0..<40).map { index in
            UsrConfluence(top: 210 + Double(index), bottom: 209 + Double(index),
                           startBar: 0, isMixed: true, memberIds: [], strength: 1)
        }
        let rendered = UsrEngine.render(runtime, lastBar: 0, reference: 100)
        XCTAssertEqual(rendered.bands.count, 60)
        XCTAssertEqual(rendered.bands.filter { $0.borderWidth == 2 }.count, 20)

        runtime.support = [zone(1), zone(2), zone(3)]
        UsrEngine.rebuildConfluence(runtime)
        XCTAssertEqual(runtime.supportConfluence.first?.memberIds, [3, 2, 1])

        var levels = [
            zone(1, top: 100, bottom: 100, line: true),
            zone(2, top: 100, bottom: 100, line: true),
            zone(3, top: 100, bottom: 100, line: true)
        ]
        var pools = UsrEngine.rebuildPoolSide(runtime, support: true, zones: &levels, previous: [])
        XCTAssertEqual(pools.first?.id, "PS|3|2|1")
        pools[0].state = .swept
        pools[0].bounceSignalCount = 2
        runtime.analysisBarId = 1
        pools = UsrEngine.rebuildPoolSide(runtime, support: true, zones: &levels, previous: pools)
        XCTAssertEqual(pools.first?.state, .swept)
        XCTAssertEqual(pools.first?.bounceSignalCount, 2)
        XCTAssertEqual(pools.first?.analysisBirth, 0)
    }

    func testSameBarIfvgVisualEvictsEarlierNewFvg() throws {
        let analysis = [
            analysisCandle(0, open: 90, high: 91, low: 89, close: 90),
            analysisCandle(1, open: 90, high: 91, low: 89, close: 90),
            analysisCandle(2, open: 89, high: 91, low: 88, close: 90),
            analysisCandle(3, open: 92, high: 100.2, low: 91.8, close: 100),
            analysisCandle(4, open: 96, high: 101, low: 95, close: 100)
        ]
        var value = settings()
        value.showFvg = true
        value.showIfvg = true
        value.fvgLookback = 3
        value.fvgBodyPercent = 0.05
        value.fvgMinBodyAtr = 0
        value.fvgMinGapAtr = 0
        value.maxVisibleFvgs = 1
        let runtime = UsrEngine.Runtime(settings: value, analysis: analysis, timeframeTag: "chart")
        runtime.analysisBarId = 4
        runtime.bullishFvgs = [UsrFvg(
            id: "old", top: 110, bottom: 105, ce: 107.5,
            startBar: 0, analysisBirth: 0, direction: .bullish
        )]
        UsrEngine.processFvgs(runtime)
        XCTAssertEqual(runtime.bullishFvgs.count, 2)
        let old = try XCTUnwrap(runtime.bullishFvgs.first { $0.id == "old" })
        XCTAssertTrue(old.ifvgActive)
        XCTAssertTrue(old.visualVisible)
        XCTAssertFalse(runtime.bullishFvgs[0].visualVisible)
        let rendered = UsrEngine.render(runtime, lastBar: 4, reference: 100)
        XCTAssertEqual(rendered.bands.count, 1)
        XCTAssertEqual(rendered.bands.first?.yTop, 110)
        XCTAssertEqual(rendered.bands.first?.yBottom, 105)
    }

    func testIfvgVisualReservationUsesPineRecordOrder() {
        var value = settings()
        value.showFvg = true
        value.showIfvg = true
        value.maxVisibleFvgs = 2
        value.fvgLookback = 3
        let runtime = UsrEngine.Runtime(
            settings: value,
            analysis: [analysisCandle(0), analysisCandle(1, high: 81, low: 79, close: 80)],
            timeframeTag: "chart"
        )
        runtime.analysisBarId = 1
        var newest = UsrFvg(id: "newest", top: 130, bottom: 125, ce: 127.5,
                            startBar: 0, analysisBirth: 0, direction: .bullish)
        newest.isActive = false
        var hidden = UsrFvg(id: "hidden", top: 95, bottom: 90, ce: 92.5,
                            startBar: 0, analysisBirth: 0, direction: .bullish)
        hidden.visualVisible = false
        var oldest = UsrFvg(id: "oldest-visible", top: 200, bottom: 195, ce: 197.5,
                            startBar: 0, analysisBirth: 0, direction: .bullish)
        oldest.isActive = false
        oldest.ifvgActive = true
        runtime.bullishFvgs = [newest, hidden, oldest]

        UsrEngine.processFvgs(runtime)

        XCTAssertEqual(runtime.bullishFvgs.map(\.visualVisible), [true, true, false])
    }

    func testHtfFvgAndIfvgRetireOnChartEventBar() throws {
        var originalSettings = settings()
        originalSettings.showFvg = true
        originalSettings.showIfvg = false
        let originalRuntime = UsrEngine.Runtime(
            settings: originalSettings,
            analysis: [
                analysisCandle(0),
                analysisCandle(1, low: 99, close: 100, chartEnd: 9, eventChartIndex: 10)
            ],
            timeframeTag: "4h"
        )
        originalRuntime.analysisBarId = 1
        originalRuntime.bullishFvgs = [UsrFvg(
            id: "original", top: 110, bottom: 105, ce: 107.5,
            startBar: 0, analysisBirth: 0, direction: .bullish
        )]

        UsrEngine.processFvgs(originalRuntime)

        let retiredOriginal = try XCTUnwrap(originalRuntime.bullishFvgs.first)
        XCTAssertFalse(retiredOriginal.isActive)
        XCTAssertEqual(retiredOriginal.endBar, 10)
        XCTAssertEqual(retiredOriginal.lifecycle, .invalidated)
        XCTAssertEqual(UsrEngine.render(originalRuntime, lastBar: 10, reference: 100).bands.first?.x2, 10)

        var inverseSettings = settings()
        inverseSettings.showFvg = true
        inverseSettings.showIfvg = true
        let inverseRuntime = UsrEngine.Runtime(
            settings: inverseSettings,
            analysis: [
                analysisCandle(0),
                analysisCandle(1),
                analysisCandle(2, close: 100, chartEnd: 9, eventChartIndex: 10)
            ],
            timeframeTag: "4h"
        )
        inverseRuntime.analysisBarId = 2
        var inverse = UsrFvg(
            id: "inverse", top: 90, bottom: 85, ce: 87.5,
            startBar: 0, analysisBirth: 0, direction: .bullish
        )
        inverse.isActive = false
        inverse.ifvgActive = true
        inverse.ifvgAnalysisBirth = 1
        inverseRuntime.bullishFvgs = [inverse]

        UsrEngine.processFvgs(inverseRuntime)

        let retiredInverse = try XCTUnwrap(inverseRuntime.bullishFvgs.first)
        XCTAssertFalse(retiredInverse.ifvgActive)
        XCTAssertEqual(retiredInverse.ifvgEndBar, 10)
        XCTAssertEqual(retiredInverse.lifecycle, .invalidated)
        XCTAssertEqual(UsrEngine.render(inverseRuntime, lastBar: 10, reference: 100).bands.first?.x2, 10)
    }

    func testScriptRenderMergeCombinesCollectionsAndKeepsSingletons() {
        let first = ScriptRenderModel(
            candleColors: ["#010203"], markers: [], lines: [], fills: [],
            segments: [ScriptSegment(
                x1: 0, y1: 1, x2: 2, y2: 3,
                color: "#010203", width: 1, style: .solid
            )],
            bands: [], labels: [],
            banner: ScriptBanner(text: "first", color: "#010203", position: "top", size: "small")
        )
        let second = ScriptRenderModel(
            candleColors: ["#040506"], markers: [], lines: [], fills: [], segments: [],
            bands: [ScriptBand(x1: 0, x2: 1, yTop: 2, yBottom: 1, fillColor: "#040506")],
            labels: [],
            banner: ScriptBanner(text: "second", color: "#040506", position: "bottom", size: "large")
        )
        let merged = ScriptRenderModel.merging([nil, first, second])

        XCTAssertEqual(merged?.candleColors, first.candleColors)
        XCTAssertEqual(merged?.segments, first.segments)
        XCTAssertEqual(merged?.bands, second.bands)
        XCTAssertEqual(merged?.banner, first.banner)
        XCTAssertNil(ScriptRenderModel.merging([nil, nil]))
    }
}
