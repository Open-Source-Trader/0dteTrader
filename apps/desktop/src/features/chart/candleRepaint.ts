/**
 * True when two regime-color arrays match in every element except possibly the
 * last (the still-forming candle). Used by the candle chart to avoid a full
 * series repaint on every tick when only the live bar's color is changing.
 */
export function sameColorsExceptLast(
  a: (string | null)[] | null,
  b: (string | null)[] | null,
): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length - 1; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
