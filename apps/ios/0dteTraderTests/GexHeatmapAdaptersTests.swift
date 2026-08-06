import XCTest
@testable import ZeroDTETrader

final class GexHeatmapAdaptersTests: XCTestCase {
    func testTermStructure_buildsOneColumnPerExpirationSortedAsGiven() {
        let snapshot = GexTermStructureSnapshotDTO(
            underlyingSymbol: "SPY",
            expirations: ["2026-08-21", "2026-09-18"],
            strikes: [500],
            cells: [
                GexTermStructureCellDTO(
                    timestamp: "2026-08-06T14:30:00.000Z",
                    strike: 500,
                    callGex: 1_000,
                    putGex: -500,
                    netGex: 500,
                    dataQuality: .complete,
                    expiration: "2026-08-21"
                ),
                GexTermStructureCellDTO(
                    timestamp: "2026-08-06T14:30:00.000Z",
                    strike: 500,
                    callGex: 2_000,
                    putGex: -1_000,
                    netGex: 1_000,
                    dataQuality: .complete,
                    expiration: "2026-09-18"
                ),
            ]
        )

        let (columns, entries) = GexHeatmapAdapters.columnsAndEntries(fromTermStructure: snapshot)

        XCTAssertEqual(columns.map(\.key), ["2026-08-21", "2026-09-18"])
        XCTAssertEqual(columns.map(\.label), ["2026-08-21", "2026-09-18"])
        XCTAssertEqual(entries.count, 1)
        let cellByColumn = Dictionary(uniqueKeysWithValues: entries[0].cells.map { ($0.columnKey, $0.netGex) })
        XCTAssertEqual(cellByColumn["2026-08-21"] ?? nil, 500)
        XCTAssertEqual(cellByColumn["2026-09-18"] ?? nil, 1_000)
    }

    func testTermStructure_missingCellForAnExpirationIsNilNotZero() {
        let snapshot = GexTermStructureSnapshotDTO(
            underlyingSymbol: "SPY",
            expirations: ["2026-08-21", "2026-09-18"],
            strikes: [500],
            cells: [
                GexTermStructureCellDTO(
                    timestamp: "2026-08-06T14:30:00.000Z",
                    strike: 500,
                    callGex: 1_000,
                    putGex: -500,
                    netGex: 500,
                    dataQuality: .complete,
                    expiration: "2026-08-21"
                )
            ]
        )

        let (_, entries) = GexHeatmapAdapters.columnsAndEntries(fromTermStructure: snapshot)

        let cellByColumn = Dictionary(uniqueKeysWithValues: entries[0].cells.map { ($0.columnKey, $0.netGex) })
        XCTAssertNil(cellByColumn["2026-09-18"] ?? nil)
    }

    func testTimeSeries_buildsOneColumnPerTimestamp() {
        let snapshot = GexHeatmapSnapshotDTO(
            underlyingSymbol: "SPY",
            expiration: "2026-08-21",
            spotSeries: [500, 501],
            timestamps: ["2026-08-06T14:30:00.000Z", "2026-08-06T14:31:00.000Z"],
            strikes: [500],
            cells: [
                GexHeatmapCellDTO(
                    timestamp: "2026-08-06T14:30:00.000Z",
                    strike: 500,
                    callGex: 1_000,
                    putGex: -500,
                    netGex: 500,
                    dataQuality: .complete
                ),
                GexHeatmapCellDTO(
                    timestamp: "2026-08-06T14:31:00.000Z",
                    strike: 500,
                    callGex: 1_200,
                    putGex: -600,
                    netGex: 600,
                    dataQuality: .complete
                ),
            ]
        )

        let (columns, entries) = GexHeatmapAdapters.columnsAndEntries(fromHeatmap: snapshot)

        XCTAssertEqual(columns.count, 2)
        XCTAssertEqual(columns.map(\.key), snapshot.timestamps)
        XCTAssertEqual(entries.count, 1)
        let cellByColumn = Dictionary(uniqueKeysWithValues: entries[0].cells.map { ($0.columnKey, $0.netGex) })
        XCTAssertEqual(cellByColumn["2026-08-06T14:30:00.000Z"] ?? nil, 500)
        XCTAssertEqual(cellByColumn["2026-08-06T14:31:00.000Z"] ?? nil, 600)
    }

    func testTimeSeries_aggregatesMultipleStrikesIndependently() {
        let snapshot = GexHeatmapSnapshotDTO(
            underlyingSymbol: "SPY",
            expiration: "2026-08-21",
            spotSeries: [500],
            timestamps: ["2026-08-06T14:30:00.000Z"],
            strikes: [495, 500],
            cells: [
                GexHeatmapCellDTO(
                    timestamp: "2026-08-06T14:30:00.000Z",
                    strike: 495,
                    callGex: 100,
                    putGex: -50,
                    netGex: 50,
                    dataQuality: .complete
                ),
                GexHeatmapCellDTO(
                    timestamp: "2026-08-06T14:30:00.000Z",
                    strike: 500,
                    callGex: 1_000,
                    putGex: -500,
                    netGex: 500,
                    dataQuality: .complete
                ),
            ]
        )

        let (_, entries) = GexHeatmapAdapters.columnsAndEntries(fromHeatmap: snapshot)

        let byStrike = Dictionary(uniqueKeysWithValues: entries.map { ($0.strike, $0) })
        XCTAssertEqual(byStrike[495]?.cells.first?.netGex, 50)
        XCTAssertEqual(byStrike[500]?.cells.first?.netGex, 500)
    }
}
