/**
 * Pure layout and hit-testing for chart order lines. Kept out of the canvas
 * component so the button rows can be tested without a DOM: getting the pill
 * geometry wrong means a tap lands on "cancel" when the user aimed at "MID",
 * which is not something to discover by hand.
 */

/** Height of a button row. */
export const ROW_HEIGHT = 18;
/** Horizontal padding inside a pill. */
export const PILL_PAD_X = 6;
/** Gap between adjacent pills — also the hit-test seam between them. */
export const PILL_GAP = 2;
/** Distance from a line at which the line body (not a pill) is grabbable. */
export const LINE_HIT_DISTANCE = 7;
/** Margin between the row and the right edge of the pane. */
export const ROW_RIGHT_MARGIN = 8;
/** Gap between a row's buttons and the line resuming either side of them. */
export const ROW_LINE_GAP = 4;

export type PillKey = 'label' | 'quantity' | 'kind' | 'orderType' | 'pnl' | 'close';

export interface Pill {
  key: PillKey;
  label: string;
  /** Left edge, pane coordinates. */
  x: number;
  width: number;
}

export interface LineRow {
  id: string;
  /** Vertical centre in pane coordinates. */
  y: number;
  pills: Pill[];
  /** Left edge of the whole row, so the line is drawn up to it, not under it. */
  left: number;
}

/**
 * Lays a row out right-to-left from `rightEdge`, in the order given.
 *
 * Right-aligned because that is where the eye already is on a price chart, and
 * because the left edge here carries the price axis.
 */
export function layoutRow(
  labels: Array<{ key: PillKey; label: string }>,
  measure: (label: string) => number,
  rightEdge: number,
): Pill[] {
  const widths = labels.map(({ label }) => Math.ceil(measure(label)) + PILL_PAD_X * 2);
  const total = widths.reduce((sum, w) => sum + w, 0) + PILL_GAP * (labels.length - 1);
  let x = rightEdge - total;
  return labels.map((entry, index) => {
    const pill: Pill = { key: entry.key, label: entry.label, x, width: widths[index] };
    x += widths[index] + PILL_GAP;
    return pill;
  });
}

/**
 * Which pill (if any) a point lands on.
 *
 * Adjacent pills split the gap between them rather than each claiming slop on
 * both sides — otherwise the generous target that makes `MID` easy to hit would
 * eat the edge of `×` and cancel the order instead of flipping it.
 */
export function pillAt(row: LineRow, x: number, y: number, slopY = 0): PillKey | null {
  if (Math.abs(y - row.y) > ROW_HEIGHT / 2 + slopY) return null;
  for (const pill of row.pills) {
    // The label pill is a readout, not a control — transparent to pointers,
    // so the chart keeps pan/zoom underneath it (the iOS overlay does the
    // same). Claiming it here would dead-zone the chart under every entry
    // line's contract tag.
    if (pill.key === 'label') continue;
    // Each pill claims half the gap on either side: neighbours meet exactly at
    // the midpoint, so no point belongs to two of them.
    if (x >= pill.x - PILL_GAP / 2 && x <= pill.x + pill.width + PILL_GAP / 2) {
      return pill.key;
    }
  }
  return null;
}

/** Whether a point grabs the line body — the draggable part, clear of the row. */
export function onLineBody(row: LineRow, x: number, y: number): boolean {
  return Math.abs(y - row.y) <= LINE_HIT_DISTANCE && x < row.left - PILL_GAP;
}

/**
 * Hit-tests every rendered row, nearest-row-first so stacked lines resolve to
 * the one the pointer is actually over.
 */
export function hitRows(
  rows: LineRow[],
  x: number,
  y: number,
  slopY = 0,
): { row: LineRow; pill: PillKey | null } | null {
  const ordered = [...rows].sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y));
  for (const row of ordered) {
    const pill = pillAt(row, x, y, slopY);
    if (pill) return { row, pill };
    if (onLineBody(row, x, y)) return { row, pill: null };
  }
  return null;
}
