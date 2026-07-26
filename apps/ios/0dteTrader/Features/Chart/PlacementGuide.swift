import CoreGraphics

/// Placement-guide metrics (pt values).
///
/// The handle's minimum touch target is `AppOrderLine.minimumTouchTarget` — the
/// same HIG 44pt the order-line pills already use, deliberately not restated
/// here under a second name.
enum AppPlacementGuide {
    /// Drawn size of the `+` handle.
    static let handleSize: CGFloat = 28
    /// Gap between the handle and the right edge of the pane.
    static let handleMargin: CGFloat = 6
    /// Chamfer on the handle, matching `HudPanelShape` at chip scale.
    static let handleChamfer: CGFloat = 6
    /// Dash pattern for the guide line, keeping it visually subordinate to the
    /// solid lines a real resting order draws.
    static let dash: [CGFloat] = [4, 4]
    /// Floor beneath `UIPanGestureRecognizer`'s own slop, mirroring the desktop
    /// constant. It does not decide tap versus drag here — the recognizer does
    /// not reach `.began` until roughly 10pt of travel, so this is already
    /// satisfied by the first `.changed`. Desktop drives its guide from raw
    /// pointer events, which have no slop of their own, so there the same
    /// number is what actually makes the call.
    static let dragThreshold: CGFloat = 4
    /// One tick, and the step VoiceOver's increment/decrement moves the guide
    /// by. Matches the rounding `ChartTradingCoordinator` applies to any level
    /// it arms, so adjusting never lands between ticks.
    static let adjustmentStep: Double = 0.01
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

/// Whether `text` is a shape the level field is allowed to hold.
///
/// Digits and at most one decimal point, and nothing else. It deliberately
/// accepts the part-typed forms a level passes through on the way in — `""`,
/// `"."`, `"4300."` — because rejecting those is what eats the decimal point
/// mid-word. It rejects everything `Double(_:)` is otherwise happy to read as a
/// price: `"1e5"`, `"0x1f"`, `"inf"`, `"-3"`, `" 42 "`. None of those are things
/// anyone means to type into a dollar level.
///
/// Mirrors `LEVEL_SHAPE` in `apps/desktop/src/features/chart/OrderPlacementPopover.tsx`.
func isLevelInputShape(_ text: String) -> Bool {
    var seenPoint = false
    for character in text {
        if character == "." {
            if seenPoint { return false }
            seenPoint = true
            continue
        }
        // `isNumber` alone would admit non-ASCII digits, which `Double(_:)`
        // does not parse — the field would look valid and never resolve.
        guard character.isASCII, character.isNumber else { return false }
    }
    return true
}

/// The level `text` names, or nil while it does not name one yet.
///
/// Nil covers both "still being typed" (`""`, `"."`, `"0"`) and "not a level at
/// all". The caller cannot submit either, which is the point: a cleared field
/// used to parse to `0`, which is finite and passed every guard, and PLACE
/// would arm a chart order at a trigger price of zero.
func parseLevelInput(_ text: String) -> Double? {
    guard isLevelInputShape(text), let value = Double(text), value.isFinite, value > 0 else {
        return nil
    }
    return value
}
