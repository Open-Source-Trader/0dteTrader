/**
 * Whether the order-placement guide still has a level to sit at.
 *
 * Kept pure and out of the canvas component for the same reason the order-line
 * geometry is: the guide is the thing that decides what price a new line gets
 * armed at, and "it looked right when I dragged it" is not a test.
 */

import { CORNER_CONTROL_INSET, CORNER_CONTROL_SIZE } from './cornerSeat';
import { PILL_GAP } from './orderLineGeometry';

/**
 * Side of the square `+` handle, and its distance from the pane's right edge.
 *
 * Both come from `cornerSeat` — the description the reset button reads too — so
 * the handle and the `A` seated in the corner below it share a left and a right
 * edge by construction rather than because two numbers were tuned to agree.
 */
export const PLUS_SIZE = CORNER_CONTROL_SIZE;
export const PLUS_MARGIN = CORNER_CONTROL_INSET;
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

/**
 * The lowest y the handle may be dragged to, given the pane's height.
 *
 * Sharing the reset button's column is what puts the `+` and the `A` on one
 * line, and the cost is that a handle dragged to the pane's bottom edge lands
 * exactly on `A`. Not merely untidy: `A` is a DOM button stacked above the
 * order-line canvas, so it takes the click from anything it covers, and a
 * handle parked under it cannot be picked up again. Stopping a pill-gap short
 * costs the bottom ~40px of the visible range, still reachable by dragging the
 * price axis; an unreachable handle was not recoverable at all.
 *
 * Mirrors `OrderLineOverlayView.guideDragMaxY` on iOS.
 */
export function guideDragFloor(paneHeight: number): number {
  const resetTop = paneHeight - CORNER_CONTROL_INSET - CORNER_CONTROL_SIZE;
  return resetTop - PILL_GAP - PLUS_SIZE / 2;
}

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
