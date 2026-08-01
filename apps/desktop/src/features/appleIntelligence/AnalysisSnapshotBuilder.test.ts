import { describe, expect, it } from 'vitest';
import { buildAnalysisSnapshot } from './AnalysisSnapshotBuilder';
import type { ChartCandle } from '../chart/ChartStore';
import type { Position } from '@0dtetrader/shared-types';

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

function position(overrides: Partial<Position> = {}): Position {
  return {
    symbol: 'SPY',
    assetClass: 'option',
    quantity: 1,
    avgPrice: 1.5,
    markPrice: 1.6,
    unrealizedPnl: 10,
    multiplier: 100,
    ...overrides,
  };
}

const FIXED_NOW = () => new Date('2026-07-31T12:00:00.000Z');

describe('buildAnalysisSnapshot', () => {
  it('carries the symbol and timeframe straight from chart state', () => {
    const snapshot = buildAnalysisSnapshot({
      chart: { symbol: 'SPY', interval: '5m', candles: [candle()], quote: null, isStale: false },
      positions: [],
      now: FIXED_NOW,
    });
    expect(snapshot.identity.symbol).toBe('SPY');
    expect(snapshot.identity.timeframe).toBe('5m');
  });

  it('produces a strictly increasing snapshotSequence across calls', () => {
    const base = {
      chart: { symbol: 'SPY', interval: '5m' as const, candles: [], quote: null, isStale: false },
      positions: [],
      now: FIXED_NOW,
    };
    const first = buildAnalysisSnapshot(base);
    const second = buildAnalysisSnapshot(base);
    expect(second.identity.snapshotSequence).toBeGreaterThan(first.identity.snapshotSequence);
  });

  it('defaults to a manual trigger when none is supplied', () => {
    const snapshot = buildAnalysisSnapshot({
      chart: { symbol: 'SPY', interval: '5m', candles: [], quote: null, isStale: false },
      positions: [],
      now: FIXED_NOW,
    });
    expect(snapshot.trigger).toEqual({
      kind: 'manual',
      priority: 'manual',
      reason: 'user requested',
    });
  });

  it('carries an explicit trigger through unchanged', () => {
    const snapshot = buildAnalysisSnapshot({
      chart: { symbol: 'SPY', interval: '5m', candles: [], quote: null, isStale: false },
      positions: [],
      trigger: { kind: 'candle-close', priority: 'candle-close', reason: 'candle closed' },
      now: FIXED_NOW,
    });
    expect(snapshot.trigger.kind).toBe('candle-close');
  });

  it('includes only the position matching the chart symbol', () => {
    const snapshot = buildAnalysisSnapshot({
      chart: { symbol: 'SPY', interval: '5m', candles: [], quote: null, isStale: false },
      positions: [position({ symbol: 'QQQ' }), position({ symbol: 'SPY', quantity: 3 })],
      now: FIXED_NOW,
    });
    expect(snapshot.position).toEqual(expect.objectContaining({ quantity: 3 }));
  });

  it('omits position when none matches the chart symbol', () => {
    const snapshot = buildAnalysisSnapshot({
      chart: { symbol: 'SPY', interval: '5m', candles: [], quote: null, isStale: false },
      positions: [position({ symbol: 'QQQ' })],
      now: FIXED_NOW,
    });
    expect(snapshot.position).toBeUndefined();
  });

  it('declares a material omission when the quote stream is stale', () => {
    const snapshot = buildAnalysisSnapshot({
      chart: { symbol: 'SPY', interval: '5m', candles: [], quote: null, isStale: true },
      positions: [],
      now: FIXED_NOW,
    });
    expect(snapshot.omissions).toContainEqual(
      expect.objectContaining({ code: 'quote-stream-stale', material: true }),
    );
  });

  it('always declares the options-chain scope omission in this phase', () => {
    const snapshot = buildAnalysisSnapshot({
      chart: { symbol: 'SPY', interval: '5m', candles: [], quote: null, isStale: false },
      positions: [],
      now: FIXED_NOW,
    });
    expect(snapshot.omissions).toContainEqual(
      expect.objectContaining({ code: 'options-chain-not-supplied' }),
    );
  });

  it('caps recent candles at 50', () => {
    const candles = Array.from({ length: 200 }, (_, i) => candle({ time: 1700000000 + i * 300 }));
    const snapshot = buildAnalysisSnapshot({
      chart: { symbol: 'SPY', interval: '5m', candles, quote: null, isStale: false },
      positions: [],
      now: FIXED_NOW,
    });
    expect((snapshot.candles as { recent: unknown[] }).recent).toHaveLength(50);
    expect((snapshot.candles as { count: number }).count).toBe(200);
  });

  it('produces no candidate levels when there are no candles to derive VWAP from', () => {
    const snapshot = buildAnalysisSnapshot({
      chart: { symbol: 'SPY', interval: '5m', candles: [], quote: null, isStale: false },
      positions: [],
      now: FIXED_NOW,
    });
    expect(snapshot.levels).toEqual([]);
  });

  it('produces a VWAP candidate level once candles are present', () => {
    const candles = [candle(), candle({ time: 1700000300, close: 101 })];
    const snapshot = buildAnalysisSnapshot({
      chart: { symbol: 'SPY', interval: '5m', candles, quote: null, isStale: false },
      positions: [],
      now: FIXED_NOW,
    });
    expect(snapshot.levels).toHaveLength(1);
    expect(snapshot.levels[0].id).toBe('vwap');
  });

  it('is deterministic for the same input other than the sequence counter', () => {
    const input = {
      chart: {
        symbol: 'SPY',
        interval: '5m' as const,
        candles: [candle()],
        quote: null,
        isStale: false,
      },
      positions: [],
      now: FIXED_NOW,
    };
    const first = buildAnalysisSnapshot(input);
    const second = buildAnalysisSnapshot(input);
    const { identity: firstIdentity, ...firstRest } = first;
    const { identity: secondIdentity, ...secondRest } = second;
    expect(firstRest).toEqual(secondRest);
    expect(firstIdentity.symbol).toBe(secondIdentity.symbol);
  });
});
