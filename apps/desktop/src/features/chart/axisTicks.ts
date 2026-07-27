import type { ChartInterval } from '@0dtetrader/shared-types';

/**
 * Tick selection for the floating chart axes.
 *
 * lightweight-charts computes its own tick marks, but it only exposes them by
 * drawing them into a price-scale or time-scale strip of its own — the gutters
 * the axes were moved out of. With the strips hidden the marks have to be
 * picked here instead, and the built-in grid is turned off with them so the
 * lines and the labels come from one source and cannot disagree.
 */

/** Steps a price axis walks, per decade. */
const PRICE_STEPS = [1, 2, 2.5, 5, 10];

export interface PriceTicks {
  values: number[];
  /** Decimals every label in `values` should be printed to. */
  decimals: number;
}

/**
 * Round price levels spanning `[min, max]`, roughly `target` of them.
 *
 * Each value is re-derived from its multiple of the step rather than
 * accumulated, so a fractional step (2.5) cannot walk a label off its round
 * number over a long span.
 */
export function priceTicks(min: number, max: number, target: number): PriceTicks {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || target < 1) {
    return { values: [], decimals: 2 };
  }
  const rough = (max - min) / target;
  const decade = 10 ** Math.floor(Math.log10(rough));
  const step = (PRICE_STEPS.find((candidate) => candidate * decade >= rough) ?? 10) * decade;
  const values: number[] = [];
  const first = Math.ceil(min / step);
  const last = Math.floor(max / step);
  for (let n = first; n <= last; n++) {
    values.push(Number((n * step).toFixed(10)));
  }
  return { values, decimals: Math.max(0, Math.min(8, -Math.floor(Math.log10(step)))) };
}

/**
 * Bar indices to print a time label at: roughly `target` of them, evenly
 * spaced across the visible window and clamped to the bars that exist.
 */
export function timeTickIndices(
  from: number,
  to: number,
  barCount: number,
  target: number,
): number[] {
  if (barCount < 1 || target < 1) return [];
  const first = Math.max(0, Math.ceil(from));
  const last = Math.min(barCount - 1, Math.floor(to));
  if (last < first) return [];
  const stride = Math.max(1, Math.round((last - first) / target));
  const indices: number[] = [];
  for (let index = first; index <= last; index += stride) {
    indices.push(index);
  }
  return indices;
}

/** Axis time label: clock time intraday, month/day on the daily interval. */
export function formatTick(timeSeconds: number, interval: ChartInterval): string {
  const date = new Date(timeSeconds * 1000);
  if (interval === '1d') {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
