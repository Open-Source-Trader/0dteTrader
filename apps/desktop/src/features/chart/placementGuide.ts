/**
 * Where the permanent order-placement guide sits.
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
 * Resolves the guide's price for this frame.
 *
 * The guide is permanent chrome, so it must never end up somewhere the user
 * cannot see or reach. Panning the price axis past it re-anchors it to the last
 * traded price — the level it would have started at — and if that is off-screen
 * too it clamps to the nearest edge. A guide left outside the pane would pin the
 * `+` to a border with no relationship to the price it arms, which is the one
 * way this control can lie about what it is going to do.
 */
export function resolveGuidePrice(
  current: number | null,
  lastPrice: number | null,
  range: PriceRange,
): number | null {
  const { min, max } = range;
  // A degenerate range means the chart has no usable price transform yet; hold
  // whatever we had rather than inventing a level from garbage.
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return current;

  const inRange = (price: number | null): price is number =>
    isUsablePrice(price) && price >= min && price <= max;

  if (inRange(current)) return current;
  if (inRange(lastPrice)) return lastPrice;
  if (isUsablePrice(current)) return Math.min(max, Math.max(min, current));
  return (min + max) / 2;
}
