import { Candle, CandleInterval } from '@0dtetrader/shared-types';

/**
 * Pure candle-aggregation math shared by every data path that must build a
 * timeframe its provider cannot serve natively (Coinbase 30m/4h, Webull 1w,
 * Tradier index intraday). Bucket alignment MUST match the clients' live-quote
 * bucketing (desktop ChartStore / iOS ChartViewModel) so streamed quotes
 * append to the same buckets the server produced.
 */

export const WEEK_SECONDS = 604_800;
/** 1970-01-01 is a Thursday; shift 4 days so weekly buckets start Monday 00:00 UTC. */
export const MONDAY_EPOCH_OFFSET = 345_600;

const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1_800,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
  '1w': WEEK_SECONDS,
};

export function intervalSeconds(interval: CandleInterval): number {
  return INTERVAL_SECONDS[interval];
}

export function bucketStartSeconds(epochSeconds: number, interval: CandleInterval): number {
  if (interval === '1w') {
    return (
      Math.floor((epochSeconds - MONDAY_EPOCH_OFFSET) / WEEK_SECONDS) * WEEK_SECONDS +
      MONDAY_EPOCH_OFFSET
    );
  }
  const seconds = INTERVAL_SECONDS[interval];
  return Math.floor(epochSeconds / seconds) * seconds;
}

/** Source interval to fetch (and how many source bars per target bar) when a
 *  provider lacks the target timeframe. */
export const AGGREGATION_PLANS: Partial<
  Record<CandleInterval, { source: CandleInterval; factor: number }>
> = {
  '30m': { source: '15m', factor: 2 },
  '4h': { source: '1h', factor: 4 },
  '1w': { source: '1d', factor: 7 },
};

/**
 * Aggregates ascending source candles into target-interval buckets:
 * open = first, high = max, low = min, close = last, volume = sum.
 * The trailing partial bucket is included; buckets with no source bars are
 * skipped, never fabricated. Output is ascending with time = bucket start.
 */
export function aggregateCandles(source: Candle[], target: CandleInterval): Candle[] {
  const result: Candle[] = [];
  let bucketStart = Number.NaN;
  let current: Candle | null = null;
  for (const candle of source) {
    const epochSeconds = Date.parse(candle.time) / 1000;
    if (!Number.isFinite(epochSeconds)) continue;
    const start = bucketStartSeconds(epochSeconds, target);
    if (current === null || start !== bucketStart) {
      if (current !== null) result.push(current);
      bucketStart = start;
      current = {
        time: new Date(start * 1000).toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      };
    } else {
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
      current.volume += candle.volume;
    }
  }
  if (current !== null) result.push(current);
  return result;
}
