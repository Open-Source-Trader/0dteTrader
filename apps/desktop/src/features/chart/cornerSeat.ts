/**
 * The one description of a control parked in the chart card's bottom-right
 * corner, shared by the reset button and the placement guide's `+` handle.
 *
 * The two stand in the same column, so their left and right borders have to
 * agree exactly — and two hand-tuned constants that happen to match today are
 * two constants that silently stop matching. Both read their size and their
 * distance from the right border from here.
 *
 * Mirrors `ChartMetrics.cornerControl*` in
 * `apps/ios/0dteTrader/Features/Chart/ChartStyle.swift`.
 */

/** Corner cut on the chart card (`--hud-chamfer`). */
const CARD_CHAMFER = 10;

export const CORNER_CONTROL_SIZE = 24;
export const CORNER_CONTROL_RADIUS = 4;

/**
 * Inset that seats a corner control equally off both borders and the diagonal.
 *
 * The bottom-right chamfer is the line `x + y = W + H - c`. A corner point `m`
 * in from both borders sits at `(W - m, H - m)`, a perpendicular `(2m - c) / √2`
 * from it, so equal spacing on all three edges is `m = c / (2 - √2)`. A corner
 * rounded by `r` reaches `r` closer to the diagonal than its bounding box does,
 * so the inset owes that back. With c = 10 and r = 4 this is 13.07.
 */
export const CORNER_CONTROL_INSET = CARD_CHAMFER / (2 - Math.SQRT2) - CORNER_CONTROL_RADIUS;
