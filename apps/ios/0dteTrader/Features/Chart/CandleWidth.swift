import CoreGraphics

/// 95th-percentile reference volume and volume-weighted candle body width,
/// isolated from DGCharts so it can be unit-tested and reused by the
/// renderer without touching viewport/transformer APIs. Mirrors
/// `apps/desktop/src/features/chart/candleWidth.ts`.
enum CandleWidth {
    /// Linear-interpolation percentile over a copy of `values` (unsorted
    /// input is fine; the source array is never mutated). Only ever called
    /// with the currently visible slice, never the full historical dataset.
    static func percentile(_ values: [Double], _ p: Double) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        guard sorted.count > 1 else { return sorted[0] }
        let rank = p * Double(sorted.count - 1)
        let lowerIndex = Int(rank.rounded(.down))
        let upperIndex = Int(rank.rounded(.up))
        if lowerIndex == upperIndex { return sorted[lowerIndex] }
        let weight = rank - Double(lowerIndex)
        return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * weight
    }

    /// 95th percentile of the visible candles' volumes; 0 when there is
    /// nothing to normalize against (empty range, or every volume
    /// invalid/zero).
    static func referenceVolume(_ visibleVolumes: [Double]) -> Double {
        let valid = visibleVolumes.filter { $0.isFinite && $0 > 0 }
        guard !valid.isEmpty else { return 0 }
        return percentile(valid, 0.95)
    }

    /// Body width for one candle, proportional to its volume relative to the
    /// visible-range 95th percentile. Falls back to `normalCandleWidth`
    /// whenever there is no usable reference (empty/zero/invalid), which is
    /// also what keeps a single extreme spike from collapsing every other
    /// candle: that candle clamps to `maximumWidthRatio` instead of
    /// stretching the scale.
    static func calculate(
        volume: Double,
        referenceVolume: Double,
        normalCandleWidth: CGFloat,
        minimumWidthRatio: CGFloat = 0.20,
        maximumWidthRatio: CGFloat = 0.95
    ) -> CGFloat {
        guard referenceVolume.isFinite, referenceVolume > 0 else { return normalCandleWidth }
        let safeVolume = volume.isFinite && volume > 0 ? volume : 0
        let normalized = CGFloat(min(1, max(0, safeVolume / referenceVolume)))
        let minWidth = max(1, normalCandleWidth * minimumWidthRatio)
        let maxWidth = normalCandleWidth * maximumWidthRatio
        return minWidth + (maxWidth - minWidth) * normalized
    }
}
