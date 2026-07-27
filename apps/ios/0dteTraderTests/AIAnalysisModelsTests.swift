#if canImport(FoundationModels)
import XCTest
@testable import ZeroDTETrader

@available(iOS 26, *)
final class AIAnalysisModelsTests: XCTestCase {
    func testBuildCandleTableRoundTripsAtTwoDecimalPrecision() {
        let candles = [
            Candle(time: makeDate("2026-07-24T09:30:00Z"), open: 100.12, high: 101.34, low: 99.87, close: 100.56, volume: 120_000),
            Candle(time: makeDate("2026-07-24T09:35:00Z"), open: 100.63, high: 101.11, low: 100.22, close: 100.89, volume: 118_500),
            Candle(time: makeDate("2026-07-24T09:40:00Z"), open: 100.77, high: 101.45, low: 100.40, close: 101.02, volume: 121_250),
            Candle(time: makeDate("2026-07-24T09:45:00Z"), open: 101.05, high: 101.62, low: 100.88, close: 101.31, volume: 119_900),
        ]

        let encoded = AIAnalysisPromptBuilder.buildCandleTable(candles, interval: "5m")
        let reconstructed = reconstructCandles(from: encoded)

        XCTAssertEqual(reconstructed.count, candles.count)
        for (source, recovered) in zip(candles, reconstructed) {
            XCTAssertEqual(twoDecimalString(recovered.open), twoDecimalString(source.open))
            XCTAssertEqual(twoDecimalString(recovered.high), twoDecimalString(source.high))
            XCTAssertEqual(twoDecimalString(recovered.low), twoDecimalString(source.low))
            XCTAssertEqual(twoDecimalString(recovered.close), twoDecimalString(source.close))
            XCTAssertEqual(recovered.volume, source.volume)
        }
    }

    func testBuildCandleTableHandlesSingleAndEmptyInputs() {
        XCTAssertEqual(AIAnalysisPromptBuilder.buildCandleTable([], interval: "5m"), "")

        let single = Candle(
            time: makeDate("2026-07-24T09:30:00Z"),
            open: 100.12,
            high: 101.34,
            low: 99.87,
            close: 100.56,
            volume: 120_000
        )
        let encoded = AIAnalysisPromptBuilder.buildCandleTable([single], interval: "5m")

        XCTAssertTrue(encoded.contains("B1: 100.12,101.34,99.87,100.56,120000"))
        XCTAssertFalse(encoded.contains("B2:"))
        XCTAssertTrue(encoded.contains("encoding=b1-absolute-bars2plus-delta-from-previous-close"))
    }

    func testBuildCandleTableIsSmallerThanVerboseEncoding() {
        let candles = makeCandles(count: 50)

        let encoded = AIAnalysisPromptBuilder.buildCandleTable(candles, interval: "5m")
        let verbose = verboseCandleTable(candles)

        XCTAssertLessThan(encoded.count, verbose.count)
    }

    func testBuildOptionsAnalyticsSectionDensifiesAndPreservesValues() throws {
        let snapshot = try makeOptionsSnapshot(status: .complete, includeScenario: true)
        let section = AIAnalysisPromptBuilder.buildOptionsAnalyticsSection(snapshot)
        let verbose = verboseOptionsAnalyticsSection(snapshot)

        XCTAssertLessThan(section.count, verbose.count)
        XCTAssertTrue(section.contains("s sym=SPY root=SPY exp=2026-07-19"))
        XCTAssertTrue(section.contains("q=complete/realtime"))
        XCTAssertTrue(section.contains("cov=3/4"))
        XCTAssertTrue(section.contains("cg=+$120K"))
        XCTAssertTrue(section.contains("pg=+$110K"))
        XCTAssertTrue(section.contains("gg=+$230K"))
        XCTAssertTrue(section.contains("cd=+$36.5M"))
        XCTAssertTrue(section.contains("pd=-$29.1M"))
        XCTAssertTrue(section.contains("cw=585.00"))
        XCTAssertTrue(section.contains("r label=model-implied 68% range"))
        XCTAssertTrue(section.contains("d assumption=calls long, puts short dealer proxy"))
        XCTAssertTrue(section.contains("roots=583.40,587.20"))
    }

    func testBuildOptionsAnalyticsSectionDropsScenarioWhenQualityIsPartial() throws {
        let snapshot = try makeOptionsSnapshot(status: .partial, includeScenario: true)
        let section = AIAnalysisPromptBuilder.buildOptionsAnalyticsSection(snapshot)

        XCTAssertTrue(section.contains("q=partial/realtime"))
        XCTAssertFalse(section.contains("d assumption="))
        XCTAssertFalse(section.contains("roots="))
    }

    func testCappedPriceOverlaysLimitsToThree() {
        let overlays = (1...5).map { index in
            IndicatorSeries(
                id: "overlay-\(index)",
                name: "Overlay \(index)",
                values: [Double?](repeating: Double(index), count: 4)
            )
        }

        let capped = AIAnalysisSheet.cappedPriceOverlays(overlays)

        XCTAssertEqual(capped.count, 3)
        XCTAssertEqual(capped.map(\.name), ["Overlay 1", "Overlay 2", "Overlay 3"])
    }

    func testBuildPromptStaysWithinBudgetForMaximalFixture() throws {
        let snapshot = try makeMaxPromptSnapshot()
        let prompt = AIAnalysisPromptBuilder.buildPrompt(from: snapshot)

        XCTAssertLessThanOrEqual(prompt.count, 6_000)
        XCTAssertTrue(prompt.contains("OPTIONS"))
        XCTAssertTrue(prompt.contains("RECENT PRICE ACTION"))
        XCTAssertTrue(prompt.contains("Analyze this data and provide your market assessment."))
    }
}

@available(iOS 26, *)
private extension AIAnalysisModelsTests {
    func reconstructCandles(from encoded: String) -> [Candle] {
        let lines = encoded.split(separator: "\n")
        let candleLines = lines.filter { $0.hasPrefix("B") }

        var previousClose: Double?
        var result: [Candle] = []

        for lineSubsequence in candleLines {
            let line = String(lineSubsequence)
            let parts = line.split(separator: ":", maxSplits: 1).map(String.init)
            XCTAssertEqual(parts.count, 2)
            let values = parts[1]
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }

            XCTAssertEqual(values.count, 5)

            if previousClose == nil {
                let open = Double(values[0])
                let high = Double(values[1])
                let low = Double(values[2])
                let close = Double(values[3])
                let volume = Int(values[4])
                XCTAssertNotNil(open)
                XCTAssertNotNil(high)
                XCTAssertNotNil(low)
                XCTAssertNotNil(close)
                XCTAssertNotNil(volume)
                result.append(
                    Candle(
                        time: Date(timeIntervalSince1970: 0),
                        open: open ?? 0,
                        high: high ?? 0,
                        low: low ?? 0,
                        close: close ?? 0,
                        volume: volume ?? 0
                    )
                )
                previousClose = close
            } else {
                let deltaOpen = Double(values[0])
                let deltaHigh = Double(values[1])
                let deltaLow = Double(values[2])
                let deltaClose = Double(values[3])
                let volume = Int(values[4])
                XCTAssertNotNil(deltaOpen)
                XCTAssertNotNil(deltaHigh)
                XCTAssertNotNil(deltaLow)
                XCTAssertNotNil(deltaClose)
                XCTAssertNotNil(volume)
                let open = previousClose! + (deltaOpen ?? 0)
                let high = previousClose! + (deltaHigh ?? 0)
                let low = previousClose! + (deltaLow ?? 0)
                let close = previousClose! + (deltaClose ?? 0)
                result.append(
                    Candle(
                        time: Date(timeIntervalSince1970: 0),
                        open: open,
                        high: high,
                        low: low,
                        close: close,
                        volume: volume ?? 0
                    )
                )
                previousClose = close
            }
        }

        return result
    }

    func verboseCandleTable(_ candles: [Candle]) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        formatter.timeZone = TimeZone(identifier: "America/New_York")

        return candles.map { candle in
            "\(formatter.string(from: candle.time)) | \(twoDecimalString(candle.open)) | \(twoDecimalString(candle.high)) | \(twoDecimalString(candle.low)) | \(twoDecimalString(candle.close)) | \(candle.volume)"
        }
        .joined(separator: "\n")
    }

    func makeCandles(count: Int) -> [Candle] {
        let start = makeDate("2026-07-24T09:30:00Z")
        var candles: [Candle] = []
        candles.reserveCapacity(count)

        for index in 0..<count {
            candles.append(
                Candle(
                    time: start.addingTimeInterval(TimeInterval(index * 5 * 60)),
                    open: 500.10 + Double(index) * 0.05,
                    high: 500.40 + Double(index) * 0.05,
                    low: 499.80 + Double(index) * 0.05,
                    close: 500.20 + Double(index) * 0.05,
                    volume: 100_000 + index * 250
                )
            )
        }

        return candles
    }

    func twoDecimalString(_ value: Double) -> String {
        String(format: "%.2f", value)
    }

    func makeDate(_ iso: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: iso) ?? Date(timeIntervalSince1970: 0)
    }

    func makeOptionsSnapshot(
        status: OptionsAnalyticsStatusDTO,
        includeScenario: Bool
    ) throws -> OptionsAnalyticsSnapshotDTO {
        let scenario: [String: Any] = includeScenario
            ? [
                "callPutDealerProxy": [
                    "assumption": "calls long, puts short dealer proxy",
                    "gammaExposure": 15_000,
                    "deltaNotional": 6_200_000,
                    "strikeGammaExposures": [
                        ["strike": 585, "gammaExposure": 15_000]
                    ],
                    "gammaRoots": [583.4, 587.2],
                    "primaryGammaRoot": 583.4,
                ]
            ]
            : ["callPutDealerProxy": NSNull()]

        let payload: [String: Any] = [
            "scope": [
                "symbol": "SPY",
                "rootSymbol": "SPY",
                "expiration": "2026-07-19",
                "settlementStyle": "pm",
                "observedAt": "2026-07-19T14:30:05Z",
                "settlementAt": "2026-07-19T20:00:00Z",
                "spot": 584,
                "forward": 584.2,
            ],
            "exposureUnit": "$ delta change per 1% underlying move",
            "quality": [
                "quoteAsOf": "2026-07-19T14:30:04Z",
                "greeksAsOf": "2026-07-19T14:30:00Z",
                "oiEffectiveDate": "2026-07-18",
                "feedMode": "realtime",
                "coverage": ["contractsTotal": 4, "contractsIncluded": 3, "ratio": 0.75],
                "status": status.rawValue,
                "warnings": ["one crossed quote excluded"],
                "calculationVersion": "options-analytics-v1",
                "cacheStatus": "fresh",
            ],
            "structure": [
                "callGammaExposure": 120_000,
                "putGammaExposure": 110_000,
                "grossGammaExposure": 230_000,
                "callDeltaNotional": 36_500_000,
                "putDeltaNotional": -29_100_000,
                "callWall": 585,
                "putWall": 580,
                "grossGammaConcentration": 0.42,
                "maxOpenInterestStrike": 585,
            ],
            "scenarios": scenario,
            "impliedRange": [
                "lower": 576.2,
                "upper": 591.8,
                "confidence": 0.68,
                "label": "model-implied 68% range",
                "atmIv": 0.192,
                "straddleLower": 575.5,
                "straddleUpper": 592.5,
            ],
            "strikes": [
                [
                    "strike": 585,
                    "call": [
                        "openInterest": 1_200,
                        "volume": 210,
                        "impliedVolatility": 0.19,
                        "delta": 0.52,
                        "gamma": 0.031,
                        "gammaExposure": 120_000,
                        "deltaNotional": 36_500_000,
                        "markedOiValue": 144_000,
                        "relativeSpread": 0.04,
                        "roundTripCost": 0.08,
                        "bidSize": 31,
                        "askSize": 27,
                        "multiplier": 100,
                    ],
                    "put": [
                        "openInterest": 900,
                        "volume": 180,
                        "impliedVolatility": 0.2,
                        "delta": -0.48,
                        "gamma": 0.03,
                        "gammaExposure": 110_000,
                        "deltaNotional": -29_100_000,
                        "markedOiValue": 126_000,
                        "relativeSpread": 0.05,
                        "roundTripCost": 0.08,
                        "bidSize": 29,
                        "askSize": 25,
                        "multiplier": 100,
                    ],
                    "grossGammaExposure": 230_000,
                    "totalOpenInterest": 2_100,
                ]
            ],
        ]

        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(OptionsAnalyticsSnapshotDTO.self, from: data)
    }

    func makeMaxPromptSnapshot() throws -> AIAnalysisSnapshot {
        let candles = makeCandles(count: 50)
        let indicators = AIAnalysisSnapshot.Indicators(
            overlays: (1...5).map { index in
                AIAnalysisSnapshot.OverlaySeries(
                    name: "Overlay \(index)",
                    values: makeOptionalSeries(base: Double(index), count: 18)
                )
            },
            rsi: makeOptionalSeries(base: 50, count: 18),
            macdLine: makeOptionalSeries(base: 1.25, count: 18),
            macdSignal: makeOptionalSeries(base: 1.1, count: 18),
            macdHistogram: makeOptionalSeries(base: 0.15, count: 18),
            stochK: makeOptionalSeries(base: 62, count: 18),
            stochD: makeOptionalSeries(base: 58, count: 18),
            atr: makeOptionalSeries(base: 3.1, count: 18)
        )

        return AIAnalysisSnapshot(
            symbol: "SPY",
            interval: "5m",
            candles: candles,
            quote: Quote(
                symbol: "SPY",
                bid: 583.95,
                ask: 584.05,
                last: 584.00,
                bidSize: 20,
                askSize: 18,
                volume: 1_200_000,
                timestamp: makeDate("2026-07-24T15:30:00Z")
            ),
            dayChange: .init(change: 12.34, percent: 2.16),
            indicators: indicators,
            optionsAnalytics: try makeOptionsSnapshot(status: .complete, includeScenario: true),
            twcBias: "Bullish momentum with support at VWAP",
            chain: .init(
                underlying: "SPY",
                underlyingPrice: 584.00,
                nearestExpiration: "2026-07-24",
                callCount: 42,
                putCount: 39
            )
        )
    }

    func makeOptionalSeries(base: Double, count: Int) -> [Double?] {
        (0..<count).map { index in base + Double(index) * 0.01 }
    }

    func verboseOptionsAnalyticsSection(_ options: OptionsAnalyticsSnapshotDTO) -> String {
        var lines: [String] = []
        lines.append("OPTIONS STRUCTURE (modeled from observed quotes and open interest):")
        lines.append(
            "Expiration: \(options.scope.expiration) | Product: \(options.scope.rootSymbol) " +
            "\(options.scope.settlementStyle.rawValue.uppercased()) | Status: \(options.quality.status.rawValue) | " +
            "Coverage: \(options.quality.coverage.contractsIncluded)/\(options.quality.coverage.contractsTotal)"
        )
        lines.append(
            "Gamma per 1% move — Calls: \(optionalDollarText(options.structure.callGammaExposure)) | " +
            "Puts: \(optionalDollarText(options.structure.putGammaExposure)) | " +
            "Gross: \(optionalDollarText(options.structure.grossGammaExposure))"
        )
        var levels: [String] = []
        if let cw = options.structure.callWall { levels.append("Call Wall: \(f(cw))") }
        if let pw = options.structure.putWall { levels.append("Put Wall: \(f(pw))") }
        if let oi = options.structure.maxOpenInterestStrike {
            levels.append("Max OI Strike: \(f(oi))")
        }
        if !levels.isEmpty { lines.append(levels.joined(separator: " | ")) }
        if let range = options.impliedRange {
            lines.append(
                "Model-implied 68% range: \(f(range.lower)) to \(f(range.upper)) | " +
                "Straddle breakevens: \(f(range.straddleLower)) to \(f(range.straddleUpper))"
            )
        }
        if options.quality.status == .complete, let proxy = options.scenarios.callPutDealerProxy {
            let roots = proxy.gammaRoots.map(f).joined(separator: ", ")
            lines.append(
                "OPTIONAL DEALER POSITIONING SCENARIO — Gamma: \(dollarText(proxy.gammaExposure)) | " +
                "Primary root: \(proxy.primaryGammaRoot.map(f) ?? "Unavailable") | " +
                "All roots: \(roots.isEmpty ? "None" : roots)"
            )
            lines.append("Scenario assumption: \(proxy.assumption)")
        }
        if !options.quality.warnings.isEmpty {
            lines.append("Data quality warnings: \(options.quality.warnings.joined(separator: "; "))")
        }
        return lines.joined(separator: "\n")
    }

    func f(_ value: Double) -> String {
        String(format: "%.2f", value)
    }

    func dollarText(_ value: Double) -> String {
        let abs = Swift.abs(value)
        let sign = value >= 0 ? "+" : "-"
        if abs >= 1_000_000_000 {
            return "\(sign)$\(String(format: "%.1f", abs / 1_000_000_000))B"
        } else if abs >= 1_000_000 {
            return "\(sign)$\(String(format: "%.1f", abs / 1_000_000))M"
        } else if abs >= 1_000 {
            return "\(sign)$\(String(format: "%.0f", abs / 1_000))K"
        } else {
            return "\(sign)$\(String(format: "%.0f", abs))"
        }
    }

    func optionalDollarText(_ value: Double?) -> String {
        value.map(dollarText) ?? "Unavailable"
    }
}
#endif
