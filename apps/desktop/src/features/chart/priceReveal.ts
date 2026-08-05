/** Padding a revealed price gets, as a fraction of the resulting span. */
const REVEAL_PADDING = 0.04;

/**
 * Extends [min, max] to include `price`, padded by a few percent of the
 * resulting span so a revealed line sits inside the viewport rather than
 * pinned to its edge. Returns the input untouched when the price is already
 * inside — which is what makes clearing a reveal restore the original range.
 *
 * Used by CandleChart's `autoscaleInfoProvider` ("Show on chart"): the merge
 * into the autoscale range is the sanctioned route to a price outside the
 * data's own range, since lightweight-charts has no price-axis scroll API.
 */
export function extendPriceRange(
  min: number,
  max: number,
  price: number,
): { min: number; max: number } {
  if (price >= min && price <= max) return { min, max };
  const pad = (Math.max(max, price) - Math.min(min, price)) * REVEAL_PADDING;
  return {
    min: price < min ? price - pad : min,
    max: price > max ? price + pad : max,
  };
}
