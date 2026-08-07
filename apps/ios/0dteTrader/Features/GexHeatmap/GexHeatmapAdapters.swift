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

    /// Caps how many time-series columns a single load can produce. The
    /// backend gap-fills every bucket in the requested window — including
    /// buckets with no capture — so a 1-minute chart interval (bucketMinutes
    /// = 1) against the default 60-minute window would render 60 real
    /// columns with no virtualization underneath (the grid is a plain
    /// VStack/HStack, not a lazy/scrolling one), which froze the sheet after
    /// the initial load. Bounding the requested window by the bucket size
    /// keeps the column count constant regardless of chart granularity.
    private static let maxTimeSeriesColumns = 30

    /// The API's own ceiling on `historyWindowMinutes` (24h) — matched here
    /// so this never requests a window the backend would reject.
    private static let maxHistoryWindowMinutes = 24 * 60

    /// The history window to request for a given bucket size, small enough
    /// that gap-filled columns stay within `maxTimeSeriesColumns`.
    static func historyWindowMinutes(for bucketMinutes: Int) -> Int {
        min(maxHistoryWindowMinutes, max(1, bucketMinutes) * maxTimeSeriesColumns)
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
}
