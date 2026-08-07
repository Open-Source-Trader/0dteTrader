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

    func testPrepend_putsOlderColumnsBeforeCurrentOnes() {
        let older = (
            columns: [GexHeatmapColumn(key: "t1", label: "1:00")],
            entries: [GexHeatmapEntry(strike: 500, cells: [GexHeatmapCell(columnKey: "t1", netGex: 10)])]
        )
        let current = (
            columns: [GexHeatmapColumn(key: "t2", label: "2:00")],
            entries: [GexHeatmapEntry(strike: 500, cells: [GexHeatmapCell(columnKey: "t2", netGex: 20)])]
        )

        let merged = GexHeatmapAdapters.prepend(older: older, before: current)

        XCTAssertEqual(merged.columns.map(\.key), ["t1", "t2"])
        let cellsByColumn = Dictionary(
            uniqueKeysWithValues: merged.entries[0].cells.map { ($0.columnKey, $0.netGex) }
        )
        XCTAssertEqual(cellsByColumn["t1"] ?? nil, 10)
        XCTAssertEqual(cellsByColumn["t2"] ?? nil, 20)
    }

    func testPrepend_aStrikePresentInOnlyOnePageGetsUnavailableCellsForTheOtherPagesColumns() {
        // Strike sets can differ between pages (a different window of the
        // chain may have been captured) — this must never coerce a missing
        // combination to 0, only to nil ("-" on screen).
        let older = (
            columns: [GexHeatmapColumn(key: "t1", label: "1:00")],
            entries: [GexHeatmapEntry(strike: 495, cells: [GexHeatmapCell(columnKey: "t1", netGex: 10)])]
        )
        let current = (
            columns: [GexHeatmapColumn(key: "t2", label: "2:00")],
            entries: [GexHeatmapEntry(strike: 500, cells: [GexHeatmapCell(columnKey: "t2", netGex: 20)])]
        )

        let merged = GexHeatmapAdapters.prepend(older: older, before: current)

        let byStrike = Dictionary(uniqueKeysWithValues: merged.entries.map { ($0.strike, $0) })
        let strike495Cells = Dictionary(uniqueKeysWithValues: byStrike[495]!.cells.map { ($0.columnKey, $0.netGex) })
        XCTAssertEqual(strike495Cells["t1"] ?? nil, 10)
        XCTAssertNil(strike495Cells["t2"] ?? nil)
        let strike500Cells = Dictionary(uniqueKeysWithValues: byStrike[500]!.cells.map { ($0.columnKey, $0.netGex) })
        XCTAssertNil(strike500Cells["t1"] ?? nil)
        XCTAssertEqual(strike500Cells["t2"] ?? nil, 20)
    }

    func testBucketMinutes_matchesEachCandleIntervalToItsOwnMinuteCount() {
        XCTAssertEqual(GexHeatmapAdapters.bucketMinutes(for: .candle(.m1)), 1)
        XCTAssertEqual(GexHeatmapAdapters.bucketMinutes(for: .candle(.m5)), 5)
        XCTAssertEqual(GexHeatmapAdapters.bucketMinutes(for: .candle(.m15)), 15)
        XCTAssertEqual(GexHeatmapAdapters.bucketMinutes(for: .candle(.m30)), 30)
        XCTAssertEqual(GexHeatmapAdapters.bucketMinutes(for: .candle(.h1)), 60)
        XCTAssertEqual(GexHeatmapAdapters.bucketMinutes(for: .candle(.h4)), 60)
        XCTAssertEqual(GexHeatmapAdapters.bucketMinutes(for: .candle(.d1)), 60)
        XCTAssertEqual(GexHeatmapAdapters.bucketMinutes(for: .candle(.w1)), 60)
    }

    func testBucketMinutes_tickIntervalsFallBackToTheFinestBucket() {
        XCTAssertEqual(GexHeatmapAdapters.bucketMinutes(for: .tick(.t10)), 1)
        XCTAssertEqual(GexHeatmapAdapters.bucketMinutes(for: .tick(.t250)), 1)
    }

    func testHistoryWindowMinutes_scalesWithBucketSizeToCapColumnCount() {
        // Column count per page should stay bounded (timeSeriesPageSize)
        // regardless of chart granularity — the backend gap-fills every
        // bucket in the window, so an unbounded window at a fine bucket size
        // renders too many columns at once.
        XCTAssertEqual(GexHeatmapAdapters.historyWindowMinutes(for: 1), 12)
        XCTAssertEqual(GexHeatmapAdapters.historyWindowMinutes(for: 5), 60)
        XCTAssertEqual(GexHeatmapAdapters.historyWindowMinutes(for: 15), 180)
    }

    func testHistoryWindowMinutes_clampsToTheAPIsOwnCeiling() {
        // A bucket size large enough that pageSize * bucketMinutes exceeds
        // the API's 1440-minute (24h) maximum must still clamp to it.
        XCTAssertEqual(GexHeatmapAdapters.historyWindowMinutes(for: 200), 24 * 60)
    }

    func testStrikeWindow_scalesWithSpotPriceRatherThanBeingFixed() {
        // A fixed dollar window would be wildly wrong at either extreme: too
        // wide for a cheap stock with $1 strikes, too narrow (or empty) for
        // an expensive one with $50 strikes. Scaling by price keeps both
        // sane without hardcoding a strike-spacing table per symbol.
        XCTAssertEqual(GexHeatmapAdapters.strikeWindow(forSpotPrice: 50), 5)
        XCTAssertEqual(GexHeatmapAdapters.strikeWindow(forSpotPrice: 500), 40)
        XCTAssertEqual(GexHeatmapAdapters.strikeWindow(forSpotPrice: 1500), 120)
    }

    func testStrikeWindow_hasAFloorForVeryLowPricedSymbols() {
        XCTAssertEqual(GexHeatmapAdapters.strikeWindow(forSpotPrice: 1), 5)
        XCTAssertEqual(GexHeatmapAdapters.strikeWindow(forSpotPrice: 0), 5)
    }
}
