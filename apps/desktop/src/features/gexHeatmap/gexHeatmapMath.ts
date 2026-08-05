import type { GexCellStyle, GexHeatmapEntry } from './types';

/** Formats a GEX value as a dollar amount with an explicit sign; null renders as a dash. */
export function formatGexValue(value: number | null): string {
  if (value === null) return '-';
  const normalized = value === 0 ? 0 : value;
  let sign = '';
  if (normalized > 0) sign = '+';
  else if (normalized < 0) sign = '-';
  return `${sign}$${Math.abs(normalized).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

const POSITIVE_NEAR = { r: 8, g: 50, b: 27, a: 0.45 };
const POSITIVE_MID = { r: 10, g: 112, b: 42, a: 0.85 };
const POSITIVE_MAX = { r: 0, g: 220, b: 34, a: 1 };

const NEGATIVE_NEAR = { r: 45, g: 8, b: 14, a: 0.45 };
const NEGATIVE_MID = { r: 120, g: 8, b: 28, a: 0.85 };
const NEGATIVE_MAX = { r: 210, g: 20, b: 45, a: 1 };

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function toRgba({ r, g, b, a }: { r: number; g: number; b: number; a: number }): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
}

/** Interpolates between the near/mid/max stops of one polarity's color scale at the given intensity (0-1). */
function interpolateScale(
  near: typeof POSITIVE_NEAR,
  mid: typeof POSITIVE_MID,
  max: typeof POSITIVE_MAX,
  intensity: number,
): { r: number; g: number; b: number; a: number } {
  if (intensity <= 0.5) {
    const t = intensity / 0.5;
    return {
      r: lerp(near.r, mid.r, t),
      g: lerp(near.g, mid.g, t),
      b: lerp(near.b, mid.b, t),
      a: lerp(near.a, mid.a, t),
    };
  }
  const t = (intensity - 0.5) / 0.5;
  return {
    r: lerp(mid.r, max.r, t),
    g: lerp(mid.g, max.g, t),
    b: lerp(mid.b, max.b, t),
    a: lerp(mid.a, max.a, t),
  };
}

/** Computes a cell's background/border colors, scaling intensity by magnitude relative to the visible maximum. */
export function getGexCellStyle(value: number | null, maxAbsoluteValue: number): GexCellStyle {
  if (value === null || maxAbsoluteValue <= 0) {
    return { background: 'transparent', borderColor: 'rgba(255, 255, 255, 0.06)' };
  }
  const intensity = Math.min(Math.abs(value) / maxAbsoluteValue, 1);
  const isPositive = value >= 0;
  const color = isPositive
    ? interpolateScale(POSITIVE_NEAR, POSITIVE_MID, POSITIVE_MAX, intensity)
    : interpolateScale(NEGATIVE_NEAR, NEGATIVE_MID, NEGATIVE_MAX, intensity);
  const borderAlpha = Math.max(0.15, intensity * 0.6);
  const borderColor = isPositive
    ? `rgba(0, 220, 34, ${borderAlpha})`
    : `rgba(210, 20, 45, ${borderAlpha})`;
  return { background: toRgba(color), borderColor };
}

/** Returns entries sorted descending by strike (highest first) without mutating the input array. */
export function sortEntriesByStrikeDescending(
  entries: readonly GexHeatmapEntry[],
): readonly GexHeatmapEntry[] {
  return [...entries].sort((a, b) => b.strike - a.strike);
}

/** Largest absolute net-GEX value across every visible cell; 0 if none are numeric. */
export function getMaxAbsoluteValue(entries: readonly GexHeatmapEntry[]): number {
  let max = 0;
  for (const entry of entries) {
    for (const cell of entry.cells) {
      if (cell.netGex === null) continue;
      const abs = Math.abs(cell.netGex);
      if (abs > max) max = abs;
    }
  }
  return max;
}

/** Strike (from a list of entries) closest to the given spot price. */
export function getClosestStrike(
  entries: readonly GexHeatmapEntry[],
  spotPrice: number,
): number | null {
  if (entries.length === 0) return null;
  return entries.reduce(
    (closest, entry) =>
      Math.abs(entry.strike - spotPrice) < Math.abs(closest - spotPrice) ? entry.strike : closest,
    entries[0].strike,
  );
}

/** Returns the 21 strikes centered on spot (10 above, 10 below, plus spot's own strike). */
export function selectStrikesAroundSpot(
  entries: readonly GexHeatmapEntry[],
  spotPrice: number,
  windowSize = 10,
): readonly GexHeatmapEntry[] {
  const ascending = [...entries].sort((a, b) => a.strike - b.strike);
  if (ascending.length === 0) return ascending;
  let closestIndex = 0;
  for (let i = 1; i < ascending.length; i += 1) {
    if (
      Math.abs(ascending[i].strike - spotPrice) <
      Math.abs(ascending[closestIndex].strike - spotPrice)
    ) {
      closestIndex = i;
    }
  }
  const start = Math.max(0, closestIndex - windowSize);
  const end = Math.min(ascending.length, closestIndex + windowSize + 1);
  return ascending.slice(start, end);
}
