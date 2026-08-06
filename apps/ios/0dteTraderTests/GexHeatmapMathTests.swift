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
