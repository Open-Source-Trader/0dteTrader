import XCTest
@testable import ZeroDTETrader

/// Mirrors the desktop vitest suite (computeTwc.test.ts) so the two 1:1 engine
/// ports stay in behavioral lockstep.
final class TwcEngineTests: XCTestCase {
    private let minute = 60
    /// Base time divisible by 360 so 1m bars align with 6-minute HTF buckets.
    private let baseTime: TimeInterval = 1_699_999_920

    // MARK: - Fixtures

    private func candle(_ i: Int, open: Double, high: Double, low: Double, close: Double, volume: Int = 1000) -> Candle {
        Candle(
            time: Date(timeIntervalSince1970: baseTime + TimeInterval(i * minute)),
            open: open,
            high: high,
            low: low,
            close: close,
            volume: volume
        )
    }

    /// Simple trending series: close moves `step` per bar with a small range.
    private func trend(_ count: Int, start: Double, step: Double) -> [Candle] {
        var out: [Candle] = []
        var price = start
        for i in 0..<count {
            let open = price
            price += step
            out.append(candle(i, open: open, high: max(open, price) + 0.2, low: min(open, price) - 0.2, close: price))
        }
        return out
    }

    /// V shape: down `downBars`, then up `upBars`, fixed step.
    private func vShape(_ downBars: Int, _ upBars: Int, start: Double, step: Double) -> [Candle] {
        var out: [Candle] = []
        var price = start
        for i in 0..<(downBars + upBars) {
            let open = price
            price += i < downBars ? -step : step
            out.append(candle(i, open: open, high: max(open, price) + 0.1, low: min(open, price) - 0.1, close: price))
        }
        return out
    }

    /// Alternating legs (300 → 240 → 320 → 280 → 430) long enough for BOTH
    /// the fib zigzag (10/10 pivots) and the SMC swing structure (34-bar
    /// legs); the final rally breaks the swing high and unlocks extensions.
    private func zigzagFixture() -> [Candle] {
        var out: [Candle] = []
        var price = 300.0
        var i = 0
        func leg(_ bars: Int, _ step: Double) {
            for _ in 0..<bars {
                let open = price
                price += step
                out.append(candle(i, open: open, high: max(open, price) + 0.1, low: min(open, price) - 0.1, close: price))
                i += 1
            }
        }
        leg(60, -1)
        leg(80, 1)
        leg(40, -1)
        leg(150, 1)
        return out
    }

    private func settings(_ patch: (inout TwcHeatmapSettings) -> Void = { _ in }) -> TwcHeatmapSettings {
        var s = TwcHeatmapSettings.default
        s.enabled = true
        patch(&s)
        return s
    }

    // MARK: - Supertrend

    func testSupertrendBullishInUptrend() {
        let candles = trend(80, start: 100, step: 1)
        let st = TwcMath.supertrend(candles, factor: 3.5, atrPeriod: 14)
        let last = candles.count - 1
        XCTAssertEqual(st.direction[last], -1)
        XCTAssertNotNil(st.value[last])
        XCTAssertLessThan(st.value[last]!, candles[last].close)
    }

    func testSupertrendBearishInDowntrend() {
        let candles = trend(80, start: 200, step: -1)
        let st = TwcMath.supertrend(candles, factor: 3.5, atrPeriod: 14)
        let last = candles.count - 1
        XCTAssertEqual(st.direction[last], 1)
        XCTAssertGreaterThan(st.value[last]!, candles[last].close)
    }

    func testSupertrendFlipsAfterReversal() {
        let candles = vShape(60, 60, start: 200, step: 1)
        let st = TwcMath.supertrend(candles, factor: 2, atrPeriod: 10)
        XCTAssertEqual(st.direction[55], 1)
        XCTAssertEqual(st.direction[candles.count - 1], -1)
    }

    func testSupertrendNilDuringWarmup() {
        let candles = trend(20, start: 100, step: 1)
        let st = TwcMath.supertrend(candles, factor: 3.5, atrPeriod: 14)
        XCTAssertNil(st.value[5])
        XCTAssertNil(st.direction[5])
    }

    // MARK: - HTF resample + confirmed mapping

    func testResampleBucketsSixBars() {
        let candles = trend(36, start: 100, step: 1)
        let resample = TwcMath.resampleHtf(candles, intervalSeconds: minute)
        XCTAssertEqual(resample.htfCandles.count, 6)
        XCTAssertEqual(resample.chartToHtf[0], 0)
        XCTAssertEqual(resample.chartToHtf[5], 0)
        XCTAssertEqual(resample.chartToHtf[6], 1)
        let bucket = resample.htfCandles[0]
        XCTAssertEqual(bucket.open, candles[0].open)
        XCTAssertEqual(bucket.close, candles[5].close)
        XCTAssertEqual(bucket.high, candles[0...5].map(\.high).max())
        XCTAssertEqual(bucket.volume, candles[0...5].map(\.volume).reduce(0, +))
    }

    func testConfirmedMappingIsRepaintSafe() {
        let candles = trend(36, start: 100, step: 1)
        let resample = TwcMath.resampleHtf(candles, intervalSeconds: minute)
        let sentinel: [Double?] = resample.htfCandles.indices.map { Double($0 * 10) }
        let mapped = TwcMath.mapConfirmedHtf(sentinel, chartToHtf: resample.chartToHtf)
        for i in 0..<6 { XCTAssertNil(mapped[i]) }
        for i in 6..<12 { XCTAssertEqual(mapped[i], 0) }
        for i in 12..<18 { XCTAssertEqual(mapped[i], 10) }

        // Appending a bar to the developing bucket never changes earlier values
        let more = trend(37, start: 100, step: 1)
        let r2 = TwcMath.resampleHtf(more, intervalSeconds: minute)
        let mapped2 = TwcMath.mapConfirmedHtf(
            r2.htfCandles.indices.map { Double($0 * 10) },
            chartToHtf: r2.chartToHtf
        )
        for i in 0..<36 { XCTAssertEqual(mapped2[i], mapped[i]) }
    }

    // MARK: - Fib zigzag engine

    func testFibDrawsSeedLevels() {
        let candles = zigzagFixture()
        let atr14 = IndicatorEngine.atr(candles: candles, period: 14)
        let fib = TwcFib.compute(candles: candles, settings: settings(), atr14: atr14)
        XCTAssertGreaterThanOrEqual(fib.segments.count, 5)
    }

    func testAlwaysShowFirstPreRevealsTargetBand() {
        let candles = zigzagFixture()
        let atr14 = IndicatorEngine.atr(candles: candles, period: 14)
        let fib = TwcFib.compute(candles: candles, settings: settings { $0.ptAlwaysShowFirst = true }, atr14: atr14)
        XCTAssertGreaterThanOrEqual(fib.bands.count, 1)
        XCTAssertTrue(fib.labels.contains { $0.text == "Profit Target #1" })
    }

    func testNoGeometryBeforeSwingForms() {
        var flat = vShape(30, 12, start: 300, step: 1)
        for _ in 0..<30 {
            let last = flat[flat.count - 1]
            flat.append(candle(flat.count, open: last.close, high: last.close + 0.1, low: last.close - 0.1, close: last.close))
        }
        let fib = TwcFib.compute(
            candles: flat,
            settings: settings { $0.ptAlwaysShowFirst = false },
            atr14: IndicatorEngine.atr(candles: flat, period: 14)
        )
        XCTAssertTrue(fib.segments.isEmpty)
        XCTAssertFalse(fib.labels.contains { $0.text.hasPrefix("Profit Target") })
    }

    func testGannSquaresStackPerUnlockedRange() {
        let candles = zigzagFixture()
        let atr14 = IndicatorEngine.atr(candles: candles, period: 14)
        let fib = TwcFib.compute(
            candles: candles,
            settings: settings {
                $0.showGannFan = true
                $0.showGannBox = true
                $0.gann1x1 = true
            },
            atr14: atr14
        )
        let dashed = fib.segments.filter { $0.style == .dashed }
        XCTAssertEqual(dashed.count % 4, 0)
        XCTAssertGreaterThanOrEqual(dashed.count, 4)
        let dotted = fib.segments.filter { $0.style == .dotted }
        XCTAssertGreaterThanOrEqual(dotted.count, 4)
    }

    func testFibDisabledReturnsNothing() {
        let candles = zigzagFixture()
        let fib = TwcFib.compute(
            candles: candles,
            settings: settings { $0.showFibonacci = false },
            atr14: IndicatorEngine.atr(candles: candles, period: 14)
        )
        XCTAssertTrue(fib.segments.isEmpty)
        XCTAssertTrue(fib.bands.isEmpty)
        XCTAssertTrue(fib.labels.isEmpty)
    }

    // MARK: - SMC engine

    func testPremiumDiscountZonesWithLabels() {
        let candles = zigzagFixture()
        let smc = TwcSmc.compute(candles: candles, settings: settings {
            $0.showPremiumDiscountZones = true
            $0.showSwingOrderBlocks = false
        })
        let texts = smc.labels.map(\.text)
        XCTAssertTrue(texts.contains("Premium"))
        XCTAssertTrue(texts.contains("Equilibrium"))
        XCTAssertTrue(texts.contains("Discount"))
        XCTAssertEqual(smc.bands.count, 3)
        XCTAssertGreaterThan(smc.bands[0].yTop, smc.bands[2].yBottom)
    }

    func testSwingOrderBlocksStoredAndCapped() {
        let candles = zigzagFixture()
        let smc = TwcSmc.compute(candles: candles, settings: settings {
            $0.showSwingOrderBlocks = true
            $0.swingOrderBlocksSize = 4
            $0.showPremiumDiscountZones = false
        })
        XCTAssertGreaterThanOrEqual(smc.bands.count, 1)
        XCTAssertLessThanOrEqual(smc.bands.count, 4)
        for band in smc.bands { XCTAssertNotNil(band.borderColor) }
    }

    func testStructureBiasFeedsConfluence() {
        let candles = zigzagFixture()
        let smc = TwcSmc.compute(candles: candles, settings: settings {
            $0.showSwingOrderBlocks = false
            $0.showPremiumDiscountZones = false
        })
        XCTAssertEqual(smc.swingBias.count, candles.count)
        XCTAssertEqual(smc.swingBias[candles.count - 1], 1)
    }

    // MARK: - Confluence engine

    func testTimeframeSeconds() {
        XCTAssertEqual(TwcMath.timeframeSeconds("5"), 300)
        XCTAssertEqual(TwcMath.timeframeSeconds("240"), 14_400)
        XCTAssertEqual(TwcMath.timeframeSeconds("D"), 86_400)
        XCTAssertEqual(TwcMath.timeframeSeconds("W"), 604_800)
    }

    func testResampleToIdentityForFinerTimeframes() {
        let candles = zigzagFixture()
        let resample = TwcMath.resampleTo(candles, targetSeconds: 60, chartIntervalSeconds: 60)
        XCTAssertEqual(resample.htfCandles.count, candles.count)
        XCTAssertEqual(resample.chartToHtf[10], 10)
    }

    func testFibDirectionSeriesTurnsBullish() {
        let candles = zigzagFixture()
        let dir = TwcFib.fibDirectionSeries(candles: candles, settings: settings())
        XCTAssertEqual(dir[candles.count - 1], 1)
        XCTAssertEqual(dir[0], 0)
    }

    func testConfluenceMarkersOnlyWhenEnabled() {
        let candles = zigzagFixture()
        let off = TwcEngine.compute(candles: candles, settings: settings { $0.showConfMarkers = false }, intervalSeconds: minute)!
        XCTAssertFalse(off.markers.contains { $0.text == "CL" || $0.text == "CS" })
        let on = TwcEngine.compute(candles: candles, settings: settings {
            $0.showConfMarkers = true
            $0.useConfluenceGate = false
        }, intervalSeconds: minute)!
        for m in on.markers where m.text == "CL" || m.text == "CS" {
            XCTAssertTrue(m.shape == .labelUp || m.shape == .labelDown)
        }
    }

    // MARK: - VWAP rip

    func testVwapRipFiresOnFirstStretchCross() {
        var candles: [Candle] = []
        for i in 0..<80 {
            let wiggle = (i % 2 == 0 ? 1.0 : -1.0) * 0.3
            candles.append(candle(i, open: 100 + wiggle, high: 100.6 + wiggle, low: 99.4 + wiggle, close: 100 - wiggle))
        }
        for i in 80..<90 {
            let price = 100 + Double(i - 79) * 3
            candles.append(candle(i, open: price - 3, high: price + 0.5, low: price - 3.5, close: price))
        }
        let model = TwcEngine.compute(candles: candles, settings: settings {
            $0.showVwapRip = true
            $0.vwapWarn = 1.5
        }, intervalSeconds: minute)!
        let rips = model.markers.filter { $0.text == "RIP" }
        XCTAssertGreaterThanOrEqual(rips.count, 1)
        XCTAssertEqual(rips.first?.placement, .aboveBar)
        let off = TwcEngine.compute(candles: candles, settings: settings { $0.showVwapRip = false }, intervalSeconds: minute)!
        XCTAssertFalse(off.markers.contains { $0.text == "RIP" })
    }

    // MARK: - computeTwc

    func testDisabledOrEmptyReturnsNil() {
        let candles = vShape(60, 200, start: 300, step: 1)
        XCTAssertNil(TwcEngine.compute(candles: candles, settings: .default, intervalSeconds: minute))
        XCTAssertNil(TwcEngine.compute(candles: [], settings: settings(), intervalSeconds: minute))
    }

    func testRegimeCandleColorsFollowToggle() {
        let candles = vShape(60, 200, start: 300, step: 1)
        let off = TwcEngine.compute(candles: candles, settings: settings { $0.colorBars = false }, intervalSeconds: minute)!
        XCTAssertNil(off.candleColors)
        let on = TwcEngine.compute(candles: candles, settings: settings { $0.colorBars = true }, intervalSeconds: minute)!
        XCTAssertNotNil(on.candleColors)
        XCTAssertEqual(on.candleColors?.count, candles.count)
        XCTAssertTrue(on.candleColors?.contains { $0 != nil } ?? false)
    }

    func testCtfLinesSplitByDirection() {
        let candles = vShape(60, 200, start: 300, step: 1)
        let model = TwcEngine.compute(candles: candles, settings: settings(), intervalSeconds: minute)!
        guard let bull = model.lines.first(where: { $0.id == "ctfBull" }),
              let bear = model.lines.first(where: { $0.id == "ctfBear" })
        else {
            return XCTFail("CTF lines missing")
        }
        for i in 0..<candles.count {
            XCTAssertFalse(bull.values[i] != nil && bear.values[i] != nil)
        }
        XCTAssertNotNil(bull.values[candles.count - 1])
    }

    func testBannerUsesConfiguredTexts() {
        let candles = vShape(60, 200, start: 300, step: 1)
        let model = TwcEngine.compute(candles: candles, settings: settings(), intervalSeconds: minute)!
        let d = TwcHeatmapSettings.default
        XCTAssertNotNil(model.banner)
        XCTAssertTrue([d.biasLongText, d.biasShortText, d.biasChopText].contains(model.banner!.text))
    }

    func testShowMarkersOffSuppressesDiamonds() {
        let candles = vShape(60, 200, start: 300, step: 1)
        let model = TwcEngine.compute(
            candles: candles,
            settings: settings {
                $0.showMarkers = false
                $0.showMacdAlign = false
            },
            intervalSeconds: minute
        )!
        XCTAssertTrue(model.markers.filter { $0.shape == .diamond }.isEmpty)
    }
}
