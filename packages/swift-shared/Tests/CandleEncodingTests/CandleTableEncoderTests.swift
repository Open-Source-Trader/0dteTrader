import XCTest
@testable import CandleEncoding

final class CandleTableEncoderTests: XCTestCase {
    func testEncodesAKnownThreeCandleExampleByteForByte() {
        let bars = [
            CandleBar(open: 452.10, high: 452.40, low: 451.90, close: 452.30, volume: 1_204_300),
            CandleBar(open: 452.35, high: 452.55, low: 452.20, close: 452.32, volume: 980_100),
            CandleBar(open: 452.30, high: 452.45, low: 452.10, close: 452.28, volume: 875_200),
        ]

        let encoded = CandleTableEncoder.encode(bars, interval: "5m", startLabel: "2026-08-01 09:30")

        let expected = """
            CANDLES 5m start=2026-08-01 09:30 tz=NY columns=open,high,low,close,volume encoding=b1-absolute-bars2plus-delta-from-previous-close
            B1: 452.10,452.40,451.90,452.30,1204300
            B2: +0.05,+0.25,-0.10,+0.02,980100
            B3: -0.02,+0.13,-0.22,-0.04,875200
            """
        XCTAssertEqual(encoded, expected)
    }

    func testRoundTripsAtTwoDecimalPrecision() {
        let bars = [
            CandleBar(open: 100.12, high: 101.34, low: 99.87, close: 100.56, volume: 120_000),
            CandleBar(open: 100.63, high: 101.11, low: 100.22, close: 100.89, volume: 118_500),
            CandleBar(open: 100.77, high: 101.45, low: 100.40, close: 101.02, volume: 121_250),
            CandleBar(open: 101.05, high: 101.62, low: 100.88, close: 101.31, volume: 119_900),
        ]

        let encoded = CandleTableEncoder.encode(bars, interval: "5m", startLabel: "2026-07-24 09:30")
        let reconstructed = reconstructBars(from: encoded)

        XCTAssertEqual(reconstructed.count, bars.count)
        for (source, recovered) in zip(bars, reconstructed) {
            XCTAssertEqual(twoDecimalString(recovered.open), twoDecimalString(source.open))
            XCTAssertEqual(twoDecimalString(recovered.high), twoDecimalString(source.high))
            XCTAssertEqual(twoDecimalString(recovered.low), twoDecimalString(source.low))
            XCTAssertEqual(twoDecimalString(recovered.close), twoDecimalString(source.close))
            XCTAssertEqual(recovered.volume, source.volume)
        }
    }

    func testHandlesSingleAndEmptyInputs() {
        XCTAssertEqual(CandleTableEncoder.encode([], interval: "5m", startLabel: "2026-07-24 09:30"), "")

        let single = CandleBar(open: 100.12, high: 101.34, low: 99.87, close: 100.56, volume: 120_000)
        let encoded = CandleTableEncoder.encode([single], interval: "5m", startLabel: "2026-07-24 09:30")

        XCTAssertTrue(encoded.contains("B1: 100.12,101.34,99.87,100.56,120000"))
        XCTAssertFalse(encoded.contains("B2:"))
        XCTAssertTrue(encoded.contains("encoding=b1-absolute-bars2plus-delta-from-previous-close"))
    }

    func testIsSmallerThanVerboseEncoding() {
        var bars: [CandleBar] = []
        for index in 0..<50 {
            let offset: Double = Double(index) * 0.05
            let bar = CandleBar(
                open: 500.10 + offset,
                high: 500.40 + offset,
                low: 499.80 + offset,
                close: 500.20 + offset,
                volume: Double(100_000 + index * 250)
            )
            bars.append(bar)
        }

        let encoded = CandleTableEncoder.encode(bars, interval: "5m", startLabel: "2026-07-24 09:30")
        let verbose = bars
            .map { "\(twoDecimalString($0.open)) | \(twoDecimalString($0.high)) | \(twoDecimalString($0.low)) | \(twoDecimalString($0.close)) | \(Int($0.volume))" }
            .joined(separator: "\n")

        XCTAssertLessThan(encoded.count, verbose.count)
    }

    // MARK: - Helpers

    private func reconstructBars(from encoded: String) -> [CandleBar] {
        let lines = encoded.split(separator: "\n").filter { $0.hasPrefix("B") }
        var previousClose: Double?
        var result: [CandleBar] = []

        for lineSubsequence in lines {
            let line = String(lineSubsequence)
            let parts = line.split(separator: ":", maxSplits: 1).map(String.init)
            XCTAssertEqual(parts.count, 2)
            let values = parts[1].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            XCTAssertEqual(values.count, 5)

            let volume = Double(values[4]) ?? 0
            if let base = previousClose {
                let open = base + (Double(values[0]) ?? 0)
                let high = base + (Double(values[1]) ?? 0)
                let low = base + (Double(values[2]) ?? 0)
                let close = base + (Double(values[3]) ?? 0)
                result.append(CandleBar(open: open, high: high, low: low, close: close, volume: volume))
                previousClose = close
            } else {
                let open = Double(values[0]) ?? 0
                let high = Double(values[1]) ?? 0
                let low = Double(values[2]) ?? 0
                let close = Double(values[3]) ?? 0
                result.append(CandleBar(open: open, high: high, low: low, close: close, volume: volume))
                previousClose = close
            }
        }
        return result
    }

    private func twoDecimalString(_ value: Double) -> String {
        String(format: "%.2f", value)
    }
}
