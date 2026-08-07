export type VisibleCandleViewport =
  { kind: 'uninitialized' } | { kind: 'empty' } | { kind: 'range'; from: number; to: number };

export const UNINITIALIZED_VISIBLE_CANDLE_VIEWPORT: VisibleCandleViewport = {
  kind: 'uninitialized',
};

export function normalizeVisibleCandleViewport(
  range: { from: number; to: number } | null,
  candleCount: number,
): VisibleCandleViewport {
  if (
    !range ||
    candleCount <= 0 ||
    !Number.isFinite(range.from) ||
    !Number.isFinite(range.to) ||
    range.from > range.to
  ) {
    return UNINITIALIZED_VISIBLE_CANDLE_VIEWPORT;
  }
  const from = Math.max(0, Math.floor(range.from));
  const to = Math.min(candleCount - 1, Math.ceil(range.to));
  return from <= to ? { kind: 'range', from, to } : { kind: 'empty' };
}
