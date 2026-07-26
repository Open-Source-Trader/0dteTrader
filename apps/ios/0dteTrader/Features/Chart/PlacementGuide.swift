import CoreGraphics

/// Placement-guide metrics (pt values).
enum AppPlacementGuide {
    /// Drawn size of the `+` handle.
    static let handleSize: CGFloat = 28
    /// Minimum touch target around it.
    static let handleTouchSize: CGFloat = 44
    /// Gap between the handle and the right edge of the pane.
    static let handleMargin: CGFloat = 6
    /// Chamfer on the handle, matching `HudPanelShape` at chip scale.
    static let handleChamfer: CGFloat = 6
    /// Dash pattern for the guide line, keeping it visually subordinate to the
    /// solid lines a real resting order draws.
    static let dash: [CGFloat] = [4, 4]
    /// Finger travel before a press on the handle counts as a drag, not a tap.
    static let dragThreshold: CGFloat = 4
}

/// Resolves the guide's price for this frame.
///
/// The guide is permanent chrome, so it must never end up somewhere the user
/// cannot see or reach. Panning the price axis past it re-anchors it to the last
/// traded price — the level it would have started at — and if that is off-screen
/// too it clamps to the nearest edge. A guide left outside the pane would pin the
/// `+` to a border with no relationship to the price it arms, which is the one
/// way this control can lie about what it is going to do.
///
/// `min` is the price at the *bottom* of the pane and `max` the price at the
/// top. Callers derive them from a content rect, where the y axis runs the other
/// way — `min` comes from `maxY` and `max` from `minY`. Swapping them yields a
/// range that always looks degenerate, so the guide silently stops re-anchoring
/// instead of failing loudly.
///
/// Mirrors `apps/desktop/src/features/chart/placementGuide.ts`; the two test
/// suites are what keep the platforms from drifting apart. Change one and you
/// change both.
func resolveGuidePrice(
    current: Double?,
    lastPrice: Double?,
    min lowerBound: Double,
    max upperBound: Double
) -> Double? {
    // A degenerate range means the chart has no usable price transform yet; hold
    // whatever we had rather than inventing a level from garbage. `current` is
    // still filtered on the way out — a non-finite level escaping here would
    // become a non-finite y-coordinate and silently erase the guide, which is
    // the exact failure this function exists to prevent.
    guard lowerBound.isFinite, upperBound.isFinite, upperBound > lowerBound else {
        return usablePrice(current)
    }

    func inRange(_ price: Double?) -> Bool {
        guard let price = usablePrice(price) else { return false }
        return price >= lowerBound && price <= upperBound
    }

    if inRange(current) { return current }
    if inRange(lastPrice) { return lastPrice }
    if let current = usablePrice(current) { return min(upperBound, max(lowerBound, current)) }
    return (lowerBound + upperBound) / 2
}

/// A price only counts if it can survive the trip through the chart's price
/// transform, so NaN and the infinities are treated the same as "absent".
private func usablePrice(_ value: Double?) -> Double? {
    guard let value, value.isFinite else { return nil }
    return value
}
