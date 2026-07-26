/**
 * Whether the order-placement guide still has a level to sit at.
 *
 * Kept pure and out of the canvas component for the same reason the order-line
 * geometry is: the guide is the thing that decides what price a new line gets
 * armed at, and "it looked right when I dragged it" is not a test.
 */

/** Side of the square `+` handle. */
export const PLUS_SIZE = 22;
/** Gap between the handle and the right edge of the pane. */
export const PLUS_MARGIN = 6;
/** Pointer travel before a press on the handle counts as a drag, not a click. */
export const GUIDE_DRAG_THRESHOLD = 3;
/**
 * One tick, and the step the arrow keys move the guide by. Matches the rounding
 * applied to any level that gets armed, so adjusting never lands between ticks.
 * Mirrored by `AppPlacementGuide.adjustmentStep` on iOS.
 */
export const GUIDE_ADJUST_STEP = 0.01;
/** Coarse step for PageUp/PageDown, for crossing a range without a hundred presses. */
export const GUIDE_ADJUST_PAGE = 0.1;

export interface PriceRange {
  /** Price at the bottom of the pane. */
  min: number;
  /** Price at the top of the pane. */
  max: number;
}

function isUsablePrice(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

/**
 * Resolves the guide's price for this frame — or null for no guide at all.
 *
 * The guide is summoned by a click on empty chart space and dismissed by the
 * next one, so `null` is its resting state rather than a failure, and the level
 * is one the user picked by pointing at it. That is why nothing here re-anchors:
 * moving a deliberately-placed level to the last traded price because the axis
 * panned would silently arm an order somewhere the user never chose. Panning the
 * level out of view dismisses the guide instead — clamping it to an edge would
 * pin the `+` to a border with no relationship to the price it arms, and holding
 * it off-screen would leave a control that toggles something invisible.
 *
 * A degenerate range is the one case that holds rather than dismisses: it means
 * the chart has no usable price transform this frame, which is a fact about the
 * chart and not about where the user put the guide.
 *
 * Mirrored by `apps/ios/0dteTrader/Features/Chart/PlacementGuide.swift`; the two
 * test suites are what keep the platforms from drifting apart. Change one and
 * you change both.
 */
export function resolveGuidePrice(current: number | null, range: PriceRange): number | null {
  // `current` is filtered on the way out either way — a non-finite level
  // escaping here would become a non-finite y-coordinate and paint the guide
  // nowhere while every hit path still believed in it.
  if (!isUsablePrice(current)) return null;
  const { min, max } = range;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return current;
  return current >= min && current <= max ? current : null;
}
