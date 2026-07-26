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
    /// Smallest level an order can be armed at: one tick.
    static let levelMinimum: Double = 0.01
    /// Largest, so a pasted or fat-fingered twenty-digit level is refused
    /// rather than armed. Paired with desktop's `LEVEL_MAX`, which bounds its
    /// `levelValid` as well as its stepper — the stepper alone never was the
    /// guard, since nothing stops the level being typed straight in.
    static let levelMaximum: Double = 100_000
}

/// Resolves the guide's price for this frame — or nil for no guide at all.
///
/// The guide is summoned by a tap on empty chart space and dismissed by the next
/// one, so nil is its resting state rather than a failure, and the level is one
/// the user picked by pointing at it. That is why nothing here re-anchors:
/// moving a deliberately-placed level to the last traded price because the axis
/// panned would silently arm an order somewhere the user never chose. Panning
/// the level out of view dismisses the guide instead — clamping it to an edge
/// would pin the `+` to a border with no relationship to the price it arms, and
/// holding it off-screen would leave a control that toggles something invisible.
///
/// A degenerate range is the one case that holds rather than dismisses: it means
/// the chart has no usable price transform this frame, which is a fact about the
/// chart and not about where the user put the guide.
///
/// `min` is the price at the *bottom* of the pane and `max` the price at the
/// top. Callers derive them from a content rect, where the y axis runs the other
/// way — `min` comes from `maxY` and `max` from `minY`. Swapping them yields a
/// range that always looks degenerate, so the guide silently stops being
/// dismissed instead of failing loudly.
///
/// Mirrors `apps/desktop/src/features/chart/placementGuide.ts`; the two test
/// suites are what keep the platforms from drifting apart. Change one and you
/// change both.
func resolveGuidePrice(current: Double?, min lowerBound: Double, max upperBound: Double) -> Double? {
    // `current` is filtered either way — a non-finite level escaping here would
    // become a non-finite y-coordinate and paint the guide nowhere while every
    // hit path still believed in it.
    guard let current = usablePrice(current) else { return nil }
    guard lowerBound.isFinite, upperBound.isFinite, upperBound > lowerBound else { return current }
    return current >= lowerBound && current <= upperBound ? current : nil
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
/// would arm a chart order at a trigger price of zero. The upper bound is the
/// other half of that: without it a pasted twenty-digit level is finite too.
func parseLevelInput(_ text: String) -> Double? {
    guard isLevelInputShape(text), let value = Double(text), value.isFinite,
          value >= AppPlacementGuide.levelMinimum, value <= AppPlacementGuide.levelMaximum
    else { return nil }
    return value
}

/// Reduces arbitrary field text to something `isLevelInputShape` accepts.
///
/// The level field cannot reject a keystroke by returning early from its
/// `Binding` setter: SwiftUI then sees `get` hand back the unchanged value and
/// does not reliably push a text update to the `UITextField`, so the field can
/// end up reading `4300..` while the model holds `4300.` — valid, submittable,
/// and disagreeing with what is on screen. Reachable by pasting, or by the
/// second separator on `decimalPad`. Sanitising and *always* assigning removes
/// the ambiguity: what the field shows is what the model holds, keystroke by
/// keystroke.
///
/// `foldingComma` is for locales whose `decimalPad` decimal key emits `,`.
/// Elsewhere a comma can only be a grouping mark, and silently promoting it to
/// a decimal point would turn `1,234.56` into a different number than the one
/// the user typed, so it is dropped like any other stray character.
func sanitiseLevelInput(_ text: String, foldingComma: Bool) -> String {
    var result = ""
    var seenPoint = false
    for character in text {
        let isSeparator = character == "." || (foldingComma && character == ",")
        if isSeparator {
            // Second and later separators are dropped, not kept: `4300..` is
            // not a price, and the first point is the one the user meant.
            guard !seenPoint else { continue }
            seenPoint = true
            result.append(".")
        } else if character.isASCII, character.isNumber {
            result.append(character)
        }
    }
    return result
}
