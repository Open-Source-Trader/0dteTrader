import { Candle } from '@0dtetrader/shared-types';
import { aggregateCandles, bucketStartSeconds, MONDAY_EPOCH_OFFSET } from './candle-aggregation';

function candle(time: string, values: Partial<Omit<Candle, 'time'>> = {}): Candle {
  return {
    time,
    open: values.open ?? 100,
    high: values.high ?? 110,
    low: values.low ?? 90,
    close: values.close ?? 105,
    volume: values.volume ?? 10,
  };
}

describe('bucketStartSeconds', () => {
  it('floors standard intervals on the epoch', () => {
    // 2026-07-13T14:47:00Z
    const ts = Date.parse('2026-07-13T14:47:00.000Z') / 1000;
    expect(bucketStartSeconds(ts, '30m')).toBe(Date.parse('2026-07-13T14:30:00.000Z') / 1000);
    expect(bucketStartSeconds(ts, '4h')).toBe(Date.parse('2026-07-13T12:00:00.000Z') / 1000);
  });

  it('aligns weekly buckets to Monday 00:00 UTC, not the Thursday epoch', () => {
    // Friday 2026-07-17 → week of Monday 2026-07-13.
    const friday = Date.parse('2026-07-17T19:59:00.000Z') / 1000;
    expect(bucketStartSeconds(friday, '1w')).toBe(Date.parse('2026-07-13T00:00:00.000Z') / 1000);
    // Sunday belongs to the previous Monday's week.
    const sunday = Date.parse('2026-07-12T23:00:00.000Z') / 1000;
    expect(bucketStartSeconds(sunday, '1w')).toBe(Date.parse('2026-07-06T00:00:00.000Z') / 1000);
  });

  it('handles pre-offset epochs (floor of negatives)', () => {
    // 1970-01-01 (Thursday) belongs to the week of Monday 1969-12-29.
    expect(bucketStartSeconds(0, '1w')).toBe(Date.parse('1969-12-29T00:00:00.000Z') / 1000);
    expect(bucketStartSeconds(MONDAY_EPOCH_OFFSET, '1w')).toBe(MONDAY_EPOCH_OFFSET);
  });
});

describe('aggregateCandles', () => {
  it('returns empty output for empty input', () => {
    expect(aggregateCandles([], '30m')).toEqual([]);
  });

  it('aggregates 15m bars into 30m with OHLCV semantics and a trailing partial', () => {
    const source = [
      candle('2026-07-13T14:00:00.000Z', { open: 1, high: 5, low: 1, close: 4, volume: 10 }),
      candle('2026-07-13T14:15:00.000Z', { open: 4, high: 9, low: 3, close: 8, volume: 20 }),
      candle('2026-07-13T14:30:00.000Z', { open: 8, high: 8, low: 6, close: 7, volume: 5 }),
    ];
    expect(aggregateCandles(source, '30m')).toEqual([
      { time: '2026-07-13T14:00:00.000Z', open: 1, high: 9, low: 1, close: 8, volume: 30 },
      // Trailing partial (only one 15m bar of the 14:30 bucket exists yet).
      { time: '2026-07-13T14:30:00.000Z', open: 8, high: 8, low: 6, close: 7, volume: 5 },
    ]);
  });

  it('aggregates 1h bars into UTC-aligned 4h buckets', () => {
    const source = [
      candle('2026-07-13T12:00:00.000Z', { open: 10, close: 11 }),
      candle('2026-07-13T13:00:00.000Z', { high: 200 }),
      candle('2026-07-13T15:00:00.000Z', { low: 1, close: 50, volume: 7 }),
      candle('2026-07-13T16:00:00.000Z', { open: 50, close: 51 }),
    ];
    const result = aggregateCandles(source, '4h');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      time: '2026-07-13T12:00:00.000Z',
      open: 10,
      high: 200,
      low: 1,
      close: 50,
      volume: 27,
    });
    expect(result[1].time).toBe('2026-07-13T16:00:00.000Z');
  });

  it('aggregates daily bars into Monday-aligned weekly bars', () => {
    const week = ['13', '14', '15', '16', '17'].map((day, i) =>
      candle(`2026-07-${day}T00:00:00.000Z`, {
        open: 100 + i,
        high: 110 + i,
        low: 90 - i,
        close: 105 + i,
        volume: 10,
      }),
    );
    const result = aggregateCandles(week, '1w');
    expect(result).toEqual([
      { time: '2026-07-13T00:00:00.000Z', open: 100, high: 114, low: 86, close: 109, volume: 50 },
    ]);
  });

  it('splits a Sunday crypto bar from the following Monday', () => {
    const source = [
      candle('2026-07-12T00:00:00.000Z', { close: 1 }),
      candle('2026-07-13T00:00:00.000Z', { open: 2 }),
    ];
    const result = aggregateCandles(source, '1w');
    expect(result.map((c) => c.time)).toEqual([
      '2026-07-06T00:00:00.000Z',
      '2026-07-13T00:00:00.000Z',
    ]);
  });

  it('skips empty buckets instead of fabricating them', () => {
    const source = [
      candle('2026-07-13T14:00:00.000Z'),
      // Gap: no bars between 14:30 and 20:00.
      candle('2026-07-13T20:00:00.000Z'),
    ];
    expect(aggregateCandles(source, '30m').map((c) => c.time)).toEqual([
      '2026-07-13T14:00:00.000Z',
      '2026-07-13T20:00:00.000Z',
    ]);
  });

  it('ignores rows with unparseable timestamps', () => {
    const source = [candle('not-a-date'), candle('2026-07-13T14:00:00.000Z')];
    expect(aggregateCandles(source, '30m')).toHaveLength(1);
  });
});
