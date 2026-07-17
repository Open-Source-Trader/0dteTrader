import XCTest
@testable import ZeroDTETrader

final class IndicatorEngineTests: XCTestCase {
    private let accuracy = 1e-9

    // MARK: - Helpers

    private func candles(closes: [Double]) -> [Candle] {
        closes.enumerated().map { index, close in
            Candle(
                time: Date(timeIntervalSince1970: TimeInterval(index * 60)),
                open: close,
                high: close,
                low: close,
                close: close,
                volume: 100
            )
        }
    }

    private func assertSeries(
        _ actual: [Double?],
        equals expected: [Double?],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(actual.count, expected.count, "series length mismatch", file: file, line: line)
        for (index, expectedValue) in expected.enumerated() where index < actual.count {
            switch (actual[index], expectedValue) {
            case (nil, nil):
                continue
            case let (actualValue?, expectedValue?):
                XCTAssertEqual(actualValue, expectedValue, accuracy: accuracy, "index \(index)", file: file, line: line)
            default:
                XCTFail("index \(index): expected \(String(describing: expectedValue)), got \(String(describing: actual[index]))", file: file, line: line)
            }
        }
    }

    // MARK: - SMA

    func testSMA_knownValues() {
        let result = IndicatorEngine.sma(candles: candles(closes: [1, 2, 3, 4, 5]), period: 3)
        assertSeries(result, equals: [nil, nil, 2, 3, 4])
    }

    func testSMA_insufficientData_returnsAllNil() {
        let result = IndicatorEngine.sma(candles: candles(closes: [1, 2]), period: 3)
        assertSeries(result, equals: [nil, nil])
    }

    // MARK: - EMA

    func testEMA_seededWithSMA_knownValues() {
        // k = 2/(3+1) = 0.5; seed = SMA(1,2,3) = 2 at index 2.
        // idx3 = 4*0.5 + 2*0.5 = 3; idx4 = 5*0.5 + 3*0.5 = 4.
        let result = IndicatorEngine.ema(candles: candles(closes: [1, 2, 3, 4, 5]), period: 3)
        assertSeries(result, equals: [nil, nil, 2, 3, 4])
    }

    // MARK: - VWAP

    func testVWAP_knownValues() {
        let input = [
            Candle(time: Date(timeIntervalSince1970: 0), open: 9, high: 10, low: 8, close: 9, volume: 100),
            Candle(time: Date(timeIntervalSince1970: 60), open: 11, high: 12, low: 10, close: 11, volume: 300),
        ]
        // c1 typical = 9 → pv = 900; c2 typical = 11 → pv = 3300.
        // vwap1 = 900/100 = 9; vwap2 = (900+3300)/400 = 10.5.
        let result = IndicatorEngine.vwap(candles: input)
        assertSeries(result, equals: [9, 10.5])
    }

    func testVWAP_zeroVolume_returnsNil() {
        let input = [
            Candle(time: Date(timeIntervalSince1970: 0), open: 9, high: 10, low: 8, close: 9, volume: 0),
        ]
        XCTAssertNil(IndicatorEngine.vwap(candles: input)[0] ?? nil)
    }

    // MARK: - RSI

    func testRSI_period2_knownValues() {
        // changes: +1, +1, −1.
        // idx2: avgGain = 1, avgLoss = 0 → RSI 100.
        // idx3: avgGain = 0.5, avgLoss = 0.5 → RS = 1 → RSI 50.
        let result = IndicatorEngine.rsi(candles: candles(closes: [1, 2, 3, 2]), period: 2)
        assertSeries(result, equals: [nil, nil, 100, 50])
    }

    func testRSI_allGains_is100() {
        let result = IndicatorEngine.rsi(candles: candles(closes: (0...20).map { Double($0) }), period: 14)
        XCTAssertEqual(result[20] ?? .nan, 100, accuracy: accuracy)
    }

    func testRSI_insufficientData_returnsAllNil() {
        let result = IndicatorEngine.rsi(candles: candles(closes: [1, 2, 3]), period: 14)
        assertSeries(result, equals: [nil, nil, nil])
    }

    // MARK: - MACD

    func testMACD_smallPeriods_knownValues() {
        // fast EMA(2): [nil, 1.5, 2.5, 3.5, 4.5]; slow EMA(3): [nil, nil, 2, 3, 4].
        // MACD line: 0.5 at idx 2...4; signal EMA(2) over [0.5, 0.5, 0.5] = 0.5; histogram = 0.
        let result = IndicatorEngine.macd(
            candles: candles(closes: [1, 2, 3, 4, 5]),
            fastPeriod: 2,
            slowPeriod: 3,
            signalPeriod: 2
        )
        assertSeries(result.macdLine, equals: [nil, nil, 0.5, 0.5, 0.5])
        assertSeries(result.signalLine, equals: [nil, nil, nil, 0.5, 0.5])
        assertSeries(result.histogram, equals: [nil, nil, nil, 0, 0])
    }

    func testMACD_defaultPeriods_warmupIsNil() {
        let result = IndicatorEngine.macd(candles: candles(closes: (1...40).map { Double($0) }))
        XCTAssertNil(result.macdLine[24] ?? nil)
        XCTAssertNotNil(result.macdLine[25])
        XCTAssertNotNil(result.signalLine[33])
        XCTAssertNil(result.signalLine[32] ?? nil)
    }

    // MARK: - Bollinger Bands

    func testBollinger_knownValues() {
        // Window [1,2,3]: mean = 2, population sd = sqrt(2/3); ± 2σ.
        let result = IndicatorEngine.bollingerBands(
            candles: candles(closes: [1, 2, 3, 4, 5]),
            period: 3,
            multiplier: 2
        )
        let sd = (2.0 / 3.0).squareRoot()
        assertSeries(result.middle, equals: [nil, nil, 2, 3, 4])
        assertSeries(result.upper, equals: [nil, nil, 2 + 2 * sd, 3 + 2 * sd, 4 + 2 * sd])
        assertSeries(result.lower, equals: [nil, nil, 2 - 2 * sd, 3 - 2 * sd, 4 - 2 * sd])
    }

    func testBollinger_middleEqualsSMA() {
        let input = candles(closes: [3, 1, 4, 1, 5, 9, 2, 6])
        let bands = IndicatorEngine.bollingerBands(candles: input, period: 4, multiplier: 2)
        let sma = IndicatorEngine.sma(candles: input, period: 4)
        assertSeries(bands.middle, equals: sma)
    }
}
