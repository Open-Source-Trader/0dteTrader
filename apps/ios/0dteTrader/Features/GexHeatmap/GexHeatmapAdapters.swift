import Foundation

/// Reshapes the API's GEX DTOs into the grid's generic column/entry model.
/// Desktop parity: apps/desktop/src/features/gexHeatmap/gexHeatmapAdapters.ts.
enum GexHeatmapAdapters {
    private static func timeLabel(_ iso: String) -> String {
        guard let date = DateParsing.dateTime(iso) else { return iso }
        return date.formatted(date: .omitted, time: .shortened)
    }

    /// Maps the chart's candle interval to the GEX time-series bucket size,
    /// so a 5m chart shows 5-minute GEX columns instead of the raw 1-minute
    /// capture cadence. GEX history has no tick-level granularity (it's
    /// captured on a wall-clock cadence, not per-trade), so a tick interval
    /// falls back to the finest bucket available. Desktop parity:
    /// gexHeatmapAdapters.ts's gexBucketMinutes.
    static func bucketMinutes(for interval: AnyChartInterval) -> Int {
        switch interval {
        case .tick:
            return 1
        case .candle(let candle):
            switch candle {
            case .m1: return 1
            case .m5: return 5
            case .m15: return 15
            case .m30: return 30
            case .h1, .h4, .d1, .w1: return 60
            }
        }
    }

    /// How many time-series columns a single page loads. Older history isn't
    /// as interesting as recent data, so the initial load — and each
    /// subsequent page fetched as the user scrolls toward older time —
    /// stays small rather than front-loading a large window upfront.
    static let timeSeriesPageSize = 12

    /// The API's own ceiling on `historyWindowMinutes` (24h) — matched here
    /// so this never requests a window the backend would reject.
    private static let maxHistoryWindowMinutes = 24 * 60

    /// The history window to request for one page at a given bucket size,
    /// small enough that gap-filled columns stay within `timeSeriesPageSize`.
    static func historyWindowMinutes(for bucketMinutes: Int) -> Int {
        min(maxHistoryWindowMinutes, max(1, bucketMinutes) * timeSeriesPageSize)
    }

    /// Fraction of spot price to request above/below spot when querying the
    /// GEX endpoints. An unbounded chain can be 400+ strikes wide, and
    /// rendering that many rows — times up to 60 time-series columns — made
    /// the grid unusably slow. strikeRangeAboveSpot/BelowSpot are dollar
    /// distances, not strike counts, so this scales with price rather than
    /// being a fixed constant (a fixed $10 window is way too wide for a $50
    /// stock with $1 strikes and returns nothing for a $1500 stock with $50
    /// strikes). Desktop parity: GexHeatmapModal.tsx's strikeWindow.
    static func strikeWindow(forSpotPrice spotPrice: Double) -> Int {
        Int(max(5, spotPrice * 0.08).rounded(.up))
    }

    /// Term structure: strike x expiration, columns labeled with the expiration date.
    static func columnsAndEntries(
        fromTermStructure snapshot: GexTermStructureSnapshotDTO
    ) -> (columns: [GexHeatmapColumn], entries: [GexHeatmapEntry]) {
        let columns = snapshot.expirations.map { GexHeatmapColumn(key: $0, label: $0) }
        var byStrike: [Double: [String: Double?]] = [:]
        for cell in snapshot.cells {
            byStrike[cell.strike, default: [:]][cell.expiration] = cell.netGex
        }
        let entries = byStrike.map { strike, byColumn -> GexHeatmapEntry in
            let cells = snapshot.expirations.map { expiration in
                GexHeatmapCell(columnKey: expiration, netGex: byColumn[expiration] ?? nil)
            }
            return GexHeatmapEntry(strike: strike, cells: cells)
        }
        return (columns, entries)
    }

    /// Time series: strike x timestamp, columns labeled with a local clock time.
    static func columnsAndEntries(
        fromHeatmap snapshot: GexHeatmapSnapshotDTO
    ) -> (columns: [GexHeatmapColumn], entries: [GexHeatmapEntry]) {
        let columns = snapshot.timestamps.map { GexHeatmapColumn(key: $0, label: timeLabel($0)) }
        var byStrike: [Double: [String: Double?]] = [:]
        for cell in snapshot.cells {
            byStrike[cell.strike, default: [:]][cell.timestamp] = cell.netGex
        }
        let entries = byStrike.map { strike, byColumn -> GexHeatmapEntry in
            let cells = snapshot.timestamps.map { timestamp in
                GexHeatmapCell(columnKey: timestamp, netGex: byColumn[timestamp] ?? nil)
            }
            return GexHeatmapEntry(strike: strike, cells: cells)
        }
        return (columns, entries)
    }

    /// Prepends an older page's columns/entries in front of the currently
    /// loaded ones, for scroll-triggered time-series pagination. Rows are
    /// matched by strike; a strike present in one page but not the other
    /// still gets a cell for every column (missing as an unavailable "-",
    /// never coerced to zero — same missing-data convention the rest of the
    /// heatmap follows). Assumes `older`'s columns are all chronologically
    /// before `current`'s (the caller fetches with `to` = the timestamp of
    /// `current`'s first column), so no de-duplication or re-sorting is
    /// needed — this only concatenates.
    static func prepend(
        older: (columns: [GexHeatmapColumn], entries: [GexHeatmapEntry]),
        before current: (columns: [GexHeatmapColumn], entries: [GexHeatmapEntry])
    ) -> (columns: [GexHeatmapColumn], entries: [GexHeatmapEntry]) {
        let mergedColumns = older.columns + current.columns
        var cellsByStrike: [Double: [String: Double?]] = [:]
        for entry in older.entries {
            for cell in entry.cells {
                cellsByStrike[entry.strike, default: [:]][cell.columnKey] = cell.netGex
            }
        }
        for entry in current.entries {
            for cell in entry.cells {
                cellsByStrike[entry.strike, default: [:]][cell.columnKey] = cell.netGex
            }
        }
        let strikes = Set(older.entries.map(\.strike)).union(current.entries.map(\.strike))
        let mergedEntries = strikes.map { strike -> GexHeatmapEntry in
            let byColumn = cellsByStrike[strike] ?? [:]
            let cells = mergedColumns.map { column in
                GexHeatmapCell(columnKey: column.key, netGex: byColumn[column.key] ?? nil)
            }
            return GexHeatmapEntry(strike: strike, cells: cells)
        }
        return (mergedColumns, mergedEntries)
    }
}
