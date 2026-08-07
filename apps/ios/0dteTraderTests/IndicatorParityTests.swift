import Foundation
import XCTest
@testable import ZeroDTETrader

final class IndicatorParityTests: XCTestCase {
    private struct Fixture: Decodable {
        let tolerance: Double
        let candleSets: [String: [FixtureCandle]]
        let indicatorCases: [IndicatorCase]
    }

    private struct FixtureCandle: Decodable {
        let timestamp: Double
        let open: Double
        let high: Double
        let low: Double
        let close: Double
        let volume: Int

        var candle: Candle {
            Candle(
                time: Date(timeIntervalSince1970: timestamp / 1_000),
                open: open,
                high: high,
                low: low,
                close: close,
                volume: Double(volume)
            )
        }
    }

    private struct IndicatorCase: Decodable {
        let id: String
        let indicatorId: String
        let candleSetId: String
        let parameters: [String: Double]
        let expected: ExpectedGeometry
    }

    private struct ExpectedGeometry: Decodable {
        let kind: String
        let series: [String: [Double?]]?
        let rows: [PriceProfileRow]?
    }

    func testEverySharedIndicatorParityCaseMatchesWithinFixtureTolerance() throws {
        let fixture = try loadFixture()
        let registry = try IndicatorRegistry.bundled()
        XCTAssertGreaterThanOrEqual(fixture.indicatorCases.count, 25)

        for testCase in fixture.indicatorCases {
            let candles = try XCTUnwrap(fixture.candleSets[testCase.candleSetId]).map(\.candle)
            let actual = try IndicatorEngine.compute(
                indicatorId: testCase.indicatorId,
                candles: candles,
                parameters: testCase.parameters,
                registry: registry
            )
            XCTAssertEqual(actual.kind.rawValue, testCase.expected.kind, testCase.id)
            if let expectedSeries = testCase.expected.series {
                XCTAssertEqual(Set(actual.series.keys), Set(expectedSeries.keys), testCase.id)
                for (seriesId, expectedValues) in expectedSeries {
                    assertSeries(
                        try XCTUnwrap(actual.series[seriesId]),
                        equals: expectedValues,
                        accuracy: fixture.tolerance,
                        message: "\(testCase.id).\(seriesId)"
                    )
                }
            }
            if let expectedRows = testCase.expected.rows {
                XCTAssertEqual(actual.rows.count, expectedRows.count, testCase.id)
                for (actualRow, expectedRow) in zip(actual.rows, expectedRows) {
                    XCTAssertEqual(actualRow.low, expectedRow.low, accuracy: fixture.tolerance, testCase.id)
                    XCTAssertEqual(actualRow.high, expectedRow.high, accuracy: fixture.tolerance, testCase.id)
                    XCTAssertEqual(actualRow.volume, expectedRow.volume, accuracy: fixture.tolerance, testCase.id)
                    XCTAssertEqual(actualRow.inValueArea, expectedRow.inValueArea, testCase.id)
                }
            }
        }
    }

    func testExecutorCatalogCoversEveryCandleIndicatorWithoutIdentifierSwitching() throws {
        let registry = try IndicatorRegistry.bundled()
        let candleIds = Set(registry.indicators.filter { !$0.requiresL2 }.map(\.id))

        XCTAssertEqual(IndicatorEngine.registeredCandleIndicatorIds, candleIds)
    }

    func testExecutorCatalogCoversEveryL2IndicatorWithoutIdentifierSwitching() throws {
        let registry = try IndicatorRegistry.bundled()
        let l2Ids = Set(registry.indicators.filter(\.requiresL2).map(\.id))

        XCTAssertEqual(IndicatorEngine.registeredL2IndicatorIds, l2Ids)
    }

    func testL2ExecutorsMapEveryServerValueToAlignedLastCandleGeometry() throws {
        let registry = try IndicatorRegistry.bundled()
        let candles = [
            Candle(time: Date(timeIntervalSince1970: 0), open: 1, high: 1, low: 1, close: 1, volume: 1),
            Candle(time: Date(timeIntervalSince1970: 60), open: 1, high: 1, low: 1, close: 1, volume: 1),
        ]
        let input = OrderBookIndicatorsDTO(
            spreadAbs: 1,
            spreadBps: 2,
            spreadPercentile: 3,
            topBookImbalance: 4,
            tickPressure: 5,
            depthImbalance: 6,
            cumulativePressure: 7,
            touchDepletion: 8
        )
        let expected: [String: [String: Double]] = [
            "spread": ["absolute": 1, "bps": 2, "percentile": 3],
            "top_book_imbalance": ["value": 4],
            "tick_pressure": ["value": 5],
            "depth_imbalance": ["value": 6],
            "cumulative_pressure": ["value": 7],
            "touch_depletion": ["value": 8],
        ]

        for descriptor in registry.indicators where descriptor.requiresL2 {
            let geometry = try IndicatorEngine.compute(
                indicatorId: descriptor.id,
                candles: candles,
                parameters: descriptor.defaultSettings.parameters,
                registry: registry,
                l2Indicators: input
            )
            XCTAssertNil(geometry.unavailableReason)
            XCTAssertEqual(
                Set(geometry.series.keys),
                Set(expected[descriptor.id]?.keys.map { $0 } ?? [])
            )
            for (series, value) in expected[descriptor.id] ?? [:] {
                XCTAssertNil(geometry.series[series]?[0] ?? nil)
                XCTAssertEqual(geometry.series[series]?[1] ?? nil, value)
            }
        }
    }

    func testCandleValidationRejectsOrderingOhlcAndNonfiniteOrNegativeData() throws {
        let registry = try IndicatorRegistry.bundled()
        let parameters = try XCTUnwrap(registry.descriptor(id: "sma")?.defaultSettings.parameters)
        let first = Candle(
            time: Date(timeIntervalSince1970: 100),
            open: 10,
            high: 12,
            low: 9,
            close: 11,
            volume: 100
        )
        let validSecond = Candle(
            time: Date(timeIntervalSince1970: 200),
            open: 11,
            high: 13,
            low: 10,
            close: 12,
            volume: 100
        )
        let invalidCases: [[Candle]] = [
            [first, Candle(time: first.time, open: 11, high: 13, low: 10, close: 12, volume: 100)],
            [validSecond, first],
            [first, Candle(time: validSecond.time, open: 14, high: 13, low: 10, close: 12, volume: 100)],
            [first, Candle(time: validSecond.time, open: 11, high: 13, low: 12.5, close: 12, volume: 100)],
            [first, Candle(time: validSecond.time, open: 11, high: .nan, low: 10, close: 12, volume: 100)],
            [first, Candle(time: validSecond.time, open: 11, high: 13, low: 10, close: 12, volume: -1)],
            [first, Candle(time: validSecond.time, open: 11, high: 13, low: 10, close: 12, volume: .infinity)],
        ]

        for candles in invalidCases {
            XCTAssertThrowsError(try IndicatorEngine.compute(
                indicatorId: "sma",
                candles: candles,
                parameters: parameters,
                registry: registry
            ))
        }
    }

    func testL2RegistryEntriesAreAddressableButUnavailableWithoutBookInput() throws {
        let registry = try IndicatorRegistry.bundled()
        let candles = [
            Candle(time: Date(), open: 1, high: 1, low: 1, close: 1, volume: 1),
        ]

        for descriptor in registry.indicators where descriptor.requiresL2 {
            let geometry = try IndicatorEngine.compute(
                indicatorId: descriptor.id,
                candles: candles,
                parameters: descriptor.defaultSettings.parameters,
                registry: registry
            )
            XCTAssertEqual(geometry, .unavailable(descriptor: descriptor, reason: "No L2 data"))
        }
    }

    func testGeometryValidationRequiresDescriptorKeysAndAlignedSeriesLengths() throws {
        let registry = try IndicatorRegistry.bundled()
        let descriptor = try XCTUnwrap(registry.descriptor(id: "bollinger"))
        let validSeries = Dictionary(uniqueKeysWithValues: descriptor.geometry.series.map {
            ($0.id, [1.0, 2.0] as [Double?])
        })
        let missing = IndicatorGeometry(
            indicatorId: descriptor.id,
            kind: descriptor.geometry.kind,
            series: validSeries.filter { $0.key != "middle" },
            rows: [],
            unavailableReason: nil
        )
        var extraSeries = validSeries
        extraSeries["extra"] = [1, 2]
        let extra = IndicatorGeometry(
            indicatorId: descriptor.id,
            kind: descriptor.geometry.kind,
            series: extraSeries,
            rows: [],
            unavailableReason: nil
        )
        var shortSeries = validSeries
        shortSeries["upper"] = [1]
        let short = IndicatorGeometry(
            indicatorId: descriptor.id,
            kind: descriptor.geometry.kind,
            series: shortSeries,
            rows: [],
            unavailableReason: nil
        )
        let wrongIdentity = IndicatorGeometry(
            indicatorId: "ema",
            kind: .line,
            series: validSeries,
            rows: [],
            unavailableReason: nil
        )

        for geometry in [missing, extra, short, wrongIdentity] {
            XCTAssertThrowsError(try IndicatorEngine.validateGeometry(
                geometry,
                descriptor: descriptor,
                candleCount: 2
            ))
        }
    }

    func testGeometryValidationRequiresOrderedNonnegativePriceProfileRows() throws {
        let registry = try IndicatorRegistry.bundled()
        let descriptor = try XCTUnwrap(registry.descriptor(id: "vpvr"))
        let invalidRows: [[PriceProfileRow]] = [
            [.init(low: 2, high: 1, volume: 1, inValueArea: false)],
            [.init(low: 1, high: 2, volume: -1, inValueArea: false)],
            [
                .init(low: 2, high: 3, volume: 1, inValueArea: false),
                .init(low: 1, high: 2, volume: 1, inValueArea: false),
            ],
        ]

        for rows in invalidRows {
            XCTAssertThrowsError(try IndicatorEngine.validateGeometry(
                IndicatorGeometry(
                    indicatorId: descriptor.id,
                    kind: descriptor.geometry.kind,
                    series: [:],
                    rows: rows,
                    unavailableReason: nil
                ),
                descriptor: descriptor,
                candleCount: 2
            ))
        }
    }

    func testZeroAnchoredVwapStartsAtLatestNewYorkSession() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/New_York"))
        func candle(day: Int, minute: Int = 0, close: Double) throws -> Candle {
            Candle(
                time: try XCTUnwrap(calendar.date(from: DateComponents(
                    year: 2026,
                    month: 8,
                    day: day,
                    hour: 10,
                    minute: minute
                ))),
                open: close,
                high: close,
                low: close,
                close: close,
                volume: 1
            )
        }
        let registry = try IndicatorRegistry.bundled()
        let candles = [
            try candle(day: 4, close: 10),
            try candle(day: 5, close: 20),
            try candle(day: 5, minute: 1, close: 30),
        ]
        let geometry = try IndicatorEngine.compute(
            indicatorId: "anchored_vwap",
            candles: candles,
            parameters: ["anchorTimestamp": 0],
            registry: registry
        )

        XCTAssertEqual(geometry.series["value"] ?? [], [nil, 20, 25])
    }

    func testRenderModelEnumeratesRegistryGeometryAndCapsSubpanes() throws {
        let registry = try IndicatorRegistry.bundled()
        var state = try IndicatorSettingsState.defaults(for: registry)
        state.indicators["sma"]?.enabled = true
        state.indicators["bollinger"]?.enabled = true
        state.indicators["rsi"]?.enabled = true
        state.indicators["macd"]?.enabled = true

        let candles = try loadFixture().candleSets["risingSix"]!.map(\.candle)
        let model = try IndicatorRenderModel.make(
            registry: registry,
            settings: state,
            candles: candles
        )

        XCTAssertEqual(model.overlays.map(\.indicatorId), ["sma", "ema", "bollinger", "anchored_vwap"])
        XCTAssertEqual(model.subPanes.map(\.indicatorId), ["rsi", "macd"])
        XCTAssertEqual(model.subPanes.count, registry.maxSubPanes)
        XCTAssertTrue(model.overlays.contains { $0.geometry.kind == .band })
        XCTAssertTrue(model.subPanes.contains { $0.geometry.kind == .multiLine })
    }

    private func loadFixture() throws -> Fixture {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = root.appendingPathComponent("packages/shared-types/fixtures/indicator-parity-v1.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func assertSeries(
        _ actual: [Double?],
        equals expected: [Double?],
        accuracy: Double,
        message: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(actual.count, expected.count, message, file: file, line: line)
        for index in expected.indices where index < actual.count {
            switch (actual[index], expected[index]) {
            case (nil, nil):
                break
            case let (actualValue?, expectedValue?):
                XCTAssertEqual(actualValue, expectedValue, accuracy: accuracy, "\(message)[\(index)]", file: file, line: line)
            default:
                XCTFail("\(message)[\(index)] nil mismatch", file: file, line: line)
            }
        }
    }
}
