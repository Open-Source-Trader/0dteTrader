import { describe, expect, it } from 'vitest';
import { buildAnalysisSnapshot } from './AnalysisSnapshotBuilder';
import { computeSnapshotContentHash } from './snapshotContentHash';
import type { ChartCandle } from '../chart/ChartStore';
import type { OptionContract } from '@0dtetrader/shared-types';

function candle(overrides: Partial<ChartCandle> = {}): ChartCandle {
  return {
    time: 1700000000,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
    ...overrides,
  };
}

describe('computeSnapshotContentHash', () => {
  it('is stable across two captures of identical market state', () => {
    const base = {
      chart: {
        symbol: 'SPY',
        interval: '5m' as const,
        candles: [candle()],
        quote: null,
        isStale: false,
      },
      positions: [],
    };
    const first = buildAnalysisSnapshot({
      ...base,
      now: () => new Date('2026-07-31T12:00:00.000Z'),
    });
    const second = buildAnalysisSnapshot({
      ...base,
      now: () => new Date('2026-07-31T12:05:00.000Z'),
    });

    // Different capturedAt/snapshotSequence/snapshotId (bookkeeping that
    // changes on every call), but identical semantic content.
    expect(first.identity.snapshotId).not.toBe(second.identity.snapshotId);
    expect(first.identity.snapshotSequence).not.toBe(second.identity.snapshotSequence);
    expect(computeSnapshotContentHash(first)).toBe(computeSnapshotContentHash(second));
  });

  it('changes when candles differ', () => {
    const base = { positions: [], now: () => new Date('2026-07-31T12:00:00.000Z') };
    const first = buildAnalysisSnapshot({
      ...base,
      chart: { symbol: 'SPY', interval: '5m', candles: [candle()], quote: null, isStale: false },
    });
    const second = buildAnalysisSnapshot({
      ...base,
      chart: {
        symbol: 'SPY',
        interval: '5m',
        candles: [candle({ close: 200 })],
        quote: null,
        isStale: false,
      },
    });
    expect(computeSnapshotContentHash(first)).not.toBe(computeSnapshotContentHash(second));
  });

  it('changes when the selected contract differs', () => {
    const base = {
      chart: {
        symbol: 'SPY',
        interval: '5m' as const,
        candles: [candle()],
        quote: null,
        isStale: false,
      },
      positions: [],
      now: () => new Date('2026-07-31T12:00:00.000Z'),
    };
    const withoutContract = buildAnalysisSnapshot(base);
    const selectedContract: OptionContract = {
      symbol: 'SPY260731C00580000',
      underlying: 'SPY',
      expiration: '2026-07-31',
      strike: 580,
      optionType: 'call',
      bid: 1.8,
      ask: 1.85,
      last: 1.82,
    };
    const withContract = buildAnalysisSnapshot({ ...base, selectedContract });
    expect(computeSnapshotContentHash(withoutContract)).not.toBe(
      computeSnapshotContentHash(withContract),
    );
  });
});
