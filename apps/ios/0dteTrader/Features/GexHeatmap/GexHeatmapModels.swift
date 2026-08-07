import SwiftUI

/// One strike's net GEX for a single grid column. Nil renders as "-".
struct GexHeatmapCell {
    /// Identifies which column this cell belongs to — an expiration date in
    /// the term-structure view, an ISO timestamp in the time-series view.
    let columnKey: String
    let netGex: Double?
}

/// One row of the grid: a strike and its GEX across every visible column.
struct GexHeatmapEntry {
    let strike: Double
    let cells: [GexHeatmapCell]
}

/// One column of the grid — its identity plus the label shown in the header.
struct GexHeatmapColumn: Identifiable, Equatable {
    var id: String { key }
    let key: String
    let label: String
}

struct GexCellStyle {
    let background: Color
    let borderColor: Color
}

/// A fully pre-formatted cell: text and colors resolved once, ahead of
/// render. `NumberFormatter`/`String(format:)`/color interpolation are real
/// CPU cost — cheap once per data load, ruinous once per gesture frame (a
/// drag's `@GestureState` changes on every touch-move, and re-deriving these
/// from `GexHeatmapCell` inside `body` reran that work on every frame).
struct RenderedGexCell: Identifiable, Equatable {
    var id: String { columnKey }
    let columnKey: String
    let text: String
    let background: Color
    let borderColor: Color
}

/// A fully pre-sorted, pre-formatted row, built once per data load.
struct RenderedGexRow: Identifiable, Equatable {
    var id: Double { strike }
    let strike: Double
    let strikeLabel: String
    let isSpotRow: Bool
    let cells: [RenderedGexCell]
}

/// Math and formatting shared by the GEX heatmap grid (desktop parity —
/// apps/desktop/src/features/gexHeatmap/gexHeatmapMath.ts).
enum GexHeatmapMath {
    /// Formats a GEX value as a dollar amount with an explicit sign; nil renders as a dash.
    static func formatGexValue(_ value: Double?) -> String {
        guard let value else { return "-" }
        let sign = value > 0 ? "+" : (value < 0 ? "-" : "")
        let magnitude = abs(value)
        let formatted = NumberFormatter.gexMagnitude.string(from: NSNumber(value: magnitude))
            ?? String(format: "%.0f", magnitude)
        return "\(sign)$\(formatted)"
    }

    private struct RGBA {
        let r: Double
        let g: Double
        let b: Double
        let a: Double
    }

    private static let positiveNear = RGBA(r: 8, g: 50, b: 27, a: 0.45)
    private static let positiveMid = RGBA(r: 10, g: 112, b: 42, a: 0.85)
    private static let positiveMax = RGBA(r: 0, g: 220, b: 34, a: 1)

    private static let negativeNear = RGBA(r: 45, g: 8, b: 14, a: 0.45)
    private static let negativeMid = RGBA(r: 120, g: 8, b: 28, a: 0.85)
    private static let negativeMax = RGBA(r: 210, g: 20, b: 45, a: 1)

    private static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double {
        a + (b - a) * t
    }

    private static func interpolate(_ near: RGBA, _ mid: RGBA, _ max: RGBA, _ intensity: Double) -> RGBA {
        if intensity <= 0.5 {
            let t = intensity / 0.5
            return RGBA(
                r: lerp(near.r, mid.r, t),
                g: lerp(near.g, mid.g, t),
                b: lerp(near.b, mid.b, t),
                a: lerp(near.a, mid.a, t)
            )
        }
        let t = (intensity - 0.5) / 0.5
        return RGBA(
            r: lerp(mid.r, max.r, t),
            g: lerp(mid.g, max.g, t),
            b: lerp(mid.b, max.b, t),
            a: lerp(mid.a, max.a, t)
        )
    }

    /// Computes a cell's background/border colors, scaling intensity by magnitude relative to the visible maximum.
    static func cellStyle(value: Double?, maxAbsoluteValue: Double) -> GexCellStyle {
        guard let value, maxAbsoluteValue > 0 else {
            return GexCellStyle(background: .clear, borderColor: Color.white.opacity(0.06))
        }
        let intensity = min(abs(value) / maxAbsoluteValue, 1)
        let isPositive = value >= 0
        let color = isPositive
            ? interpolate(positiveNear, positiveMid, positiveMax, intensity)
            : interpolate(negativeNear, negativeMid, negativeMax, intensity)
        let borderAlpha = max(0.15, intensity * 0.6)
        let borderColor = isPositive
            ? Color(red: 0, green: 220 / 255, blue: 34 / 255).opacity(borderAlpha)
            : Color(red: 210 / 255, green: 20 / 255, blue: 45 / 255).opacity(borderAlpha)
        return GexCellStyle(
            background: Color(red: color.r / 255, green: color.g / 255, blue: color.b / 255).opacity(color.a),
            borderColor: borderColor
        )
    }

    /// Returns entries sorted descending by strike (highest first).
    static func sortedByStrikeDescending(_ entries: [GexHeatmapEntry]) -> [GexHeatmapEntry] {
        entries.sorted { $0.strike > $1.strike }
    }

    /// Builds the fully pre-sorted, pre-formatted, pre-colored render model
    /// in one pass — sort once, format once, interpolate color once. Call
    /// this when `entries`/`columns`/`spotPrice` change; never from inside a
    /// gesture-driven view body, or the formatting/color cost repeats on
    /// every touch-move frame.
    static func buildRenderedRows(
        entries: [GexHeatmapEntry],
        columns: [GexHeatmapColumn],
        spotPrice: Double
    ) -> [RenderedGexRow] {
        let sorted = sortedByStrikeDescending(entries)
        let maxAbs = maxAbsoluteValue(sorted)
        let spot = closestStrike(sorted, spotPrice: spotPrice)
        return sorted.map { entry in
            let cellByColumn = Dictionary(uniqueKeysWithValues: entry.cells.map { ($0.columnKey, $0.netGex) })
            let cells = columns.map { column -> RenderedGexCell in
                let value = cellByColumn[column.key] ?? nil
                let style = cellStyle(value: value, maxAbsoluteValue: maxAbs)
                return RenderedGexCell(
                    columnKey: column.key,
                    text: formatGexValue(value),
                    background: style.background,
                    borderColor: style.borderColor
                )
            }
            return RenderedGexRow(
                strike: entry.strike,
                strikeLabel: Format.strike(entry.strike),
                isSpotRow: spot == entry.strike,
                cells: cells
            )
        }
    }

    /// Largest absolute net-GEX value across every visible cell; 0 if none are numeric.
    static func maxAbsoluteValue(_ entries: [GexHeatmapEntry]) -> Double {
        var max = 0.0
        for entry in entries {
            for cell in entry.cells {
                guard let netGex = cell.netGex else { continue }
                let value = abs(netGex)
                if value > max { max = value }
            }
        }
        return max
    }

    /// Strike (from a list of entries) closest to the given spot price.
    static func closestStrike(_ entries: [GexHeatmapEntry], spotPrice: Double) -> Double? {
        guard var closest = entries.first?.strike else { return nil }
        for entry in entries where abs(entry.strike - spotPrice) < abs(closest - spotPrice) {
            closest = entry.strike
        }
        return closest
    }

    /// Returns the strikes centered on spot (`windowSize` above, `windowSize` below, plus spot's own strike).
    static func strikesAroundSpot(
        _ entries: [GexHeatmapEntry],
        spotPrice: Double,
        windowSize: Int = 10
    ) -> [GexHeatmapEntry] {
        let ascending = entries.sorted { $0.strike < $1.strike }
        guard !ascending.isEmpty else { return ascending }
        var closestIndex = 0
        for i in 1..<ascending.count
        where abs(ascending[i].strike - spotPrice) < abs(ascending[closestIndex].strike - spotPrice) {
            closestIndex = i
        }
        let start = Swift.max(0, closestIndex - windowSize)
        let end = Swift.min(ascending.count, closestIndex + windowSize + 1)
        return Array(ascending[start..<end])
    }
}

private extension NumberFormatter {
    static let gexMagnitude: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        f.groupingSeparator = ","
        f.usesGroupingSeparator = true
        return f
    }()
}
