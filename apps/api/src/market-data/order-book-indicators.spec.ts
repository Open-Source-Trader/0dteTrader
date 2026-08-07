import { OrderBookSnapshot } from '@0dtetrader/shared-types';
import { deriveOrderBookIndicators, validateOrderBook } from './order-book-indicators';

const at = (second: number): string => `2026-08-05T14:30:${String(second).padStart(2, '0')}.000Z`;

function book(
  second: number,
  bids: Array<[number, number]> = [[100, 10]],
  asks: Array<[number, number]> = [[102, 6]],
  depth = Math.min(bids.length, asks.length),
): OrderBookSnapshot {
  return {
    symbol: 'SPY',
    provider: 'webull',
    capability: 'nasdaq_totalview_non_display',
    freshness: 'fresh',
    timestamp: at(second),
    receivedAt: at(second),
    depth,
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
  };
}

describe('order-book validation and derived indicators', () => {
  it('computes spread, midpoint regime, top-book and N-level imbalance exactly', () => {
    const current = book(
      2,
      [
        [100, 10],
        [99, 5],
      ],
      [
        [102, 6],
        [103, 3],
      ],
      2,
    );
    const result = deriveOrderBookIndicators(
      current,
      [book(0, [[99, 8]], [[101, 8]]), book(1, [[100, 8]], [[101, 8]])],
      2,
    );

    expect(result.spreadAbs).toBe(2);
    expect(result.spreadBps).toBeCloseTo((2 / 101) * 10_000, 12);
    expect(result.spreadPercentile).toBe(75);
    expect(result.topBookImbalance).toBe(0.25);
    expect(result.depthImbalance).toBeCloseTo(6 / 24, 12);
  });

  it('uses trailing midpoint signs, cumulative N-level deltas, and touch depletion', () => {
    const history = [
      book(
        0,
        [
          [99, 10],
          [98, 10],
        ],
        [
          [101, 10],
          [102, 10],
        ],
        2,
      ),
      book(
        1,
        [
          [100, 8],
          [99, 10],
        ],
        [
          [102, 6],
          [103, 10],
        ],
        2,
      ),
    ];
    const current = book(
      2,
      [
        [100, 6],
        [99, 10],
      ],
      [
        [102, 3],
        [103, 9],
      ],
      2,
    );
    const result = deriveOrderBookIndicators(current, history, 2);

    expect(result.tickPressure).toBe(0.5); // up, then unchanged
    expect(result.cumulativePressure).toBeCloseTo(1 / 3, 12);
    expect(result.touchDepletion).toBe(0.2); // ask -3, bid -2 => (3-2)/(3+2)
  });

  it('treats unchanged mids as neutral, ties as zero, and first comparisons as unavailable', () => {
    const first = deriveOrderBookIndicators(book(0, [[100, 0]], [[102, 0]]), [], 5);
    expect(first.spreadPercentile).toBeNull();
    expect(first.topBookImbalance).toBeNull();
    expect(first.tickPressure).toBeNull();
    expect(first.cumulativePressure).toBeNull();
    expect(first.touchDepletion).toBeNull();

    const tied = deriveOrderBookIndicators(
      book(1, [[100, 5]], [[102, 5]]),
      [book(0, [[100, 5]], [[102, 5]])],
      50,
    );
    expect(tied.topBookImbalance).toBe(0);
    expect(tied.depthImbalance).toBe(0);
    expect(tied.tickPressure).toBe(0);
    expect(tied.cumulativePressure).toBe(0);
    expect(tied.touchDepletion).toBe(0);
  });

  it('ignores comparisons older than 60 seconds while keeping session spread percentile', () => {
    const old = {
      ...book(0),
      timestamp: '2026-08-05T14:29:00.000Z',
    };
    const current = book(2);
    const result = deriveOrderBookIndicators(current, [old], 1);
    expect(result.spreadPercentile).toBe(50);
    expect(result.tickPressure).toBeNull();
    expect(result.cumulativePressure).toBeNull();
    expect(result.touchDepletion).toBeNull();
  });

  it.each([
    ['2026-03-09T13:30:00.000Z', '2026-03-09T13:29:59.000Z'],
    ['2026-11-02T14:30:00.000Z', '2026-11-02T14:29:59.000Z'],
  ])('excludes premarket history at the DST-adjusted New York open', (currentAt, priorAt) => {
    const current = { ...book(0), timestamp: currentAt };
    const premarket = { ...book(0), timestamp: priorAt };

    const result = deriveOrderBookIndicators(current, [premarket], 1);

    expect(result.spreadPercentile).toBeNull();
    expect(result.tickPressure).toBeNull();
    expect(result.cumulativePressure).toBeNull();
    expect(result.touchDepletion).toBeNull();
  });

  it.each([
    book(0, [], []),
    book(0, [[0, 1]], [[1, 1]]),
    book(0, [[100, -1]], [[101, 1]]),
    book(
      0,
      [
        [99, 1],
        [100, 1],
      ],
      [[101, 1]],
    ),
    book(
      0,
      [[100, 1]],
      [
        [102, 1],
        [101, 1],
      ],
    ),
    book(0, [[102, 1]], [[101, 1]]),
    { ...book(0), timestamp: 'not-a-date' },
    { ...book(0), receivedAt: 'not-a-date' },
  ])('rejects malformed/crossed/empty books without fabricated zeroes', (candidate) => {
    expect(validateOrderBook(candidate)).toBe(false);
    expect(deriveOrderBookIndicators(candidate, [], 1)).toEqual({
      spreadAbs: null,
      spreadBps: null,
      spreadPercentile: null,
      topBookImbalance: null,
      tickPressure: null,
      depthImbalance: null,
      cumulativePressure: null,
      touchDepletion: null,
    });
  });
});
