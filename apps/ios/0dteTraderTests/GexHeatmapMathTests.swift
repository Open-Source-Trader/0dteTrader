import XCTest
@testable import ZeroDTETrader

final class GexHeatmapMathTests: XCTestCase {
    private func column(_ key: String) -> GexHeatmapColumn {
        GexHeatmapColumn(key: key, label: key)
    }

    func testBuildRenderedRows_sortsDescendingByStrike() {
        let entries = [
            GexHeatmapEntry(strike: 100, cells: [GexHeatmapCell(columnKey: "a", netGex: 1)]),
            GexHeatmapEntry(strike: 300, cells: [GexHeatmapCell(columnKey: "a", netGex: 1)]),
            GexHeatmapEntry(strike: 200, cells: [GexHeatmapCell(columnKey: "a", netGex: 1)]),
        ]

        let rows = GexHeatmapMath.buildRenderedRows(entries: entries, columns: [column("a")], spotPrice: 200)

        XCTAssertEqual(rows.map(\.strike), [300, 200, 100])
    }

    func testBuildRenderedRows_marksTheClosestStrikeToSpotAsTheSpotRow() {
        let entries = [
            GexHeatmapEntry(strike: 95, cells: [GexHeatmapCell(columnKey: "a", netGex: 1)]),
            GexHeatmapEntry(strike: 100, cells: [GexHeatmapCell(columnKey: "a", netGex: 1)]),
            GexHeatmapEntry(strike: 106, cells: [GexHeatmapCell(columnKey: "a", netGex: 1)]),
        ]

        let rows = GexHeatmapMath.buildRenderedRows(entries: entries, columns: [column("a")], spotPrice: 101)

        let spotRows = rows.filter(\.isSpotRow)
        XCTAssertEqual(spotRows.count, 1)
        XCTAssertEqual(spotRows.first?.strike, 100)
    }

    func testBuildRenderedRows_preFormatsEveryCellText() {
        let entries = [
            GexHeatmapEntry(
                strike: 100,
                cells: [
                    GexHeatmapCell(columnKey: "a", netGex: 54_700_000),
                    GexHeatmapCell(columnKey: "b", netGex: nil),
                ]
            )
        ]

        let rows = GexHeatmapMath.buildRenderedRows(
            entries: entries,
            columns: [column("a"), column("b")],
            spotPrice: 100
        )

        XCTAssertEqual(rows.first?.cells.map(\.text), ["+$54,700,000", "-"])
    }

    func testBuildRenderedRows_missingCellForAColumnRendersAsUnavailableRatherThanCrashing() {
        let entries = [
            GexHeatmapEntry(strike: 100, cells: [GexHeatmapCell(columnKey: "a", netGex: 5)])
        ]

        let rows = GexHeatmapMath.buildRenderedRows(
            entries: entries,
            columns: [column("a"), column("missing")],
            spotPrice: 100
        )

        XCTAssertEqual(rows.first?.cells.map(\.columnKey), ["a", "missing"])
        XCTAssertEqual(rows.first?.cells.last?.text, "-")
    }

    func testVisibleWindow_showsOnlyTheColumnsAndRowsIntersectingTheViewportAtRest() {
        // 100pt viewport, 92pt cells, no scroll/zoom: columns 0 and 1 are
        // partially or fully visible, plus the 1-cell trailing buffer.
        let window = GexHeatmapMath.visibleWindow(
            clamped: .zero,
            viewport: CGSize(width: 100, height: 100),
            scale: 1,
            cellWidth: 92,
            rowHeight: 38,
            rowCount: 50,
            columnCount: 30
        )

        XCTAssertEqual(window.columns, 0..<4)
        XCTAssertEqual(window.rows, 0..<5)
        XCTAssertEqual(window.originOffset, .zero)
    }

    func testVisibleWindow_scrollsTheWindowAsTheGridPans() {
        // Panned 5 columns and 10 rows to the left/up (content moved that
        // far in the negative direction); the visible window should start
        // around index 5/10, not index 0 — this is the core fix for the
        // "every cell built even when scrolled far away" performance bug.
        let scaledCellWidth: CGFloat = 92
        let scaledRowHeight: CGFloat = 38
        let clamped = CGSize(width: -5 * scaledCellWidth, height: -10 * scaledRowHeight)

        let window = GexHeatmapMath.visibleWindow(
            clamped: clamped,
            viewport: CGSize(width: 200, height: 200),
            scale: 1,
            cellWidth: 92,
            rowHeight: 38,
            rowCount: 50,
            columnCount: 30
        )

        XCTAssertEqual(window.columns.lowerBound, 4)
        XCTAssertEqual(window.rows.lowerBound, 9)
        // originOffset repositions the sliced window back to where the
        // unsliced content would have been drawn.
        XCTAssertEqual(window.originOffset.width, clamped.width + CGFloat(window.columns.lowerBound) * scaledCellWidth)
        XCTAssertEqual(window.originOffset.height, clamped.height + CGFloat(window.rows.lowerBound) * scaledRowHeight)
    }

    func testVisibleWindow_clampsToAvailableRowsAndColumnsRatherThanOverrunning() {
        // A tiny grid (3 rows x 2 columns) in a viewport that could fit more
        // — the window should never claim indices beyond what exists.
        let window = GexHeatmapMath.visibleWindow(
            clamped: .zero,
            viewport: CGSize(width: 1000, height: 1000),
            scale: 1,
            cellWidth: 92,
            rowHeight: 38,
            rowCount: 3,
            columnCount: 2
        )

        XCTAssertEqual(window.columns, 0..<2)
        XCTAssertEqual(window.rows, 0..<3)
    }

    func testVisibleWindow_emptyGridProducesAnEmptyWindow() {
        let window = GexHeatmapMath.visibleWindow(
            clamped: .zero,
            viewport: CGSize(width: 100, height: 100),
            scale: 1,
            cellWidth: 92,
            rowHeight: 38,
            rowCount: 0,
            columnCount: 0
        )

        XCTAssertEqual(window.columns, 0..<0)
        XCTAssertEqual(window.rows, 0..<0)
    }

    func testBuildRenderedRows_isDeterministic() {
        let entries = [
            GexHeatmapEntry(
                strike: 100,
                cells: [GexHeatmapCell(columnKey: "a", netGex: 5), GexHeatmapCell(columnKey: "b", netGex: -3)]
            ),
            GexHeatmapEntry(
                strike: 105,
                cells: [GexHeatmapCell(columnKey: "a", netGex: 2), GexHeatmapCell(columnKey: "b", netGex: nil)]
            ),
        ]
        let columns = [column("a"), column("b")]

        let first = GexHeatmapMath.buildRenderedRows(entries: entries, columns: columns, spotPrice: 100)
        let second = GexHeatmapMath.buildRenderedRows(entries: entries, columns: columns, spotPrice: 100)

        XCTAssertEqual(first.map(\.strike), second.map(\.strike))
        XCTAssertEqual(first.map { $0.cells.map(\.text) }, second.map { $0.cells.map(\.text) })
    }
}
