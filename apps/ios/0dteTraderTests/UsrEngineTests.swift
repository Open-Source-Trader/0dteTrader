import XCTest
@testable import ZeroDTETrader

final class UsrEngineTests: XCTestCase {
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

    func testHtfStructuralOriginUsesSourceCandleEndWithoutBackpainting() throws {
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
}
