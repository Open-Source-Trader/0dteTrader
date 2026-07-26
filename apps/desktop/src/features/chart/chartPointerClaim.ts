/**
 * Which pointer presses a chart layer has already taken responsibility for.
 *
 * `DrawingLayer` and `OrderLineLayer` both listen on the same chart container in
 * the capture phase, so neither can learn from propagation alone whether the
 * other claimed a press: `stopPropagation` does not stop a sibling listener
 * registered on the same element. The order layer needs that answer to decide
 * whether a release was a click on genuinely empty space — a click that landed
 * on a trend line, or drew one, is not an invitation to summon the placement
 * guide. It only needs the answer at `pointerup`, by which time every
 * `pointerdown` handler has run, so claiming is enough and ordering is not.
 *
 * A `WeakSet` rather than a flag on the event object: nothing has to be reset
 * between gestures, and each entry dies with the event it describes.
 */
const claimed = new WeakSet<PointerEvent>();

/** Marks a press as handled by a chart layer. */
export function claimPointer(event: PointerEvent): void {
  claimed.add(event);
}

/** Whether some chart layer took this press. */
export function isPointerClaimed(event: PointerEvent): boolean {
  return claimed.has(event);
}
