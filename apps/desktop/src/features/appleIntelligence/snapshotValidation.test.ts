import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OptionContract, Position, Quote } from '@0dtetrader/shared-types';
import type { ChartCandle } from '../chart/ChartStore';
import { buildAnalysisSnapshot } from './AnalysisSnapshotBuilder';
import { evaluateAnalysisEligibility } from './snapshotValidation';
import type { AnalysisSnapshot } from './types';

const VALID_CANDLES: ChartCandle[] = [
  { time: 1, open: 578, high: 579, low: 577, close: 578.5, volume: 1000 },
  { time: 2, open: 578.5, high: 579.2, low: 578.1, close: 578.9, volume: 900 },
];

const contract: OptionContract = {
  symbol: 'SPY260731C00579000',
  underlying: 'SPY',
  expiration: '2026-07-31',
  strike: 579,
  optionType: 'call',
  bid: 1.8,
  ask: 1.9,
  last: 1.85,
};

const position: Position = {
  symbol: contract.symbol,
  assetClass: 'option',
  quantity: 1,
  avgPrice: 1.8,
  markPrice: 1.85,
  unrealizedPnl: 5,
  multiplier: 100,
};

function makeQuote(fields: { last: number; bid: number; ask: number }): Quote {
  return {
    symbol: 'SPY',
    bidSize: 100,
    askSize: 100,
    volume: 1_000_000,
    timestamp: '2026-07-29T15:00:00.000Z',
    ...fields,
  };
}

function makeSnapshot(
  overrides: Partial<{
    quote: Quote | null;
    candles: ChartCandle[];
    selectedContract: OptionContract | null;
    positions: Position[];
  }> = {},
): AnalysisSnapshot {
  const quote =
    'quote' in overrides
      ? (overrides.quote ?? null)
      : makeQuote({ last: 578.5, bid: 578.4, ask: 578.6 });
  return buildAnalysisSnapshot({
    chart: {
      symbol: 'SPY',
      interval: '5m',
      candles: overrides.candles ?? VALID_CANDLES,
      quote,
      isStale: false,
    },
    positions: overrides.positions ?? [],
    selectedContract: overrides.selectedContract ?? null,
    now: () => new Date('2026-07-29T15:00:00.000Z'),
  });
}

describe('evaluateAnalysisEligibility', () => {
  // Wed 11:00 ET — regular trading hours, matching other appleIntelligence
  // test files' convention. deriveMarketSessionState reads the real system
  // clock (correct for production; the market-session gate has no snapshot-
  // supplied `now`), so tests asserting `mode` must pin it.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T15:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts a fully valid snapshot', () => {
    const result = evaluateAnalysisEligibility(makeSnapshot());
    expect(result.eligible).toBe(true);
  });

  it('rejects a missing underlying quote', () => {
    const result = evaluateAnalysisEligibility(makeSnapshot({ quote: null }));
    expect(result).toMatchObject({ eligible: false, reason: 'missing-underlying-quote' });
  });

  it('rejects bid strictly exceeding ask', () => {
    const result = evaluateAnalysisEligibility(
      makeSnapshot({ quote: makeQuote({ last: 578.5, bid: 579, ask: 578 }) }),
    );
    expect(result).toMatchObject({ eligible: false, reason: 'invalid-underlying-quote' });
  });

  it('rejects an implausibly wide bid/ask spread relative to last', () => {
    // The reported bug: Bid 722.25 / Ask 766.98 against Last 746.79 — a
    // ~44-point spread on a ~747 last price, far beyond any real market.
    const result = evaluateAnalysisEligibility(
      makeSnapshot({ quote: makeQuote({ last: 746.79, bid: 722.25, ask: 766.98 }) }),
    );
    expect(result).toMatchObject({ eligible: false, reason: 'invalid-underlying-quote' });
  });

  it('rejects a non-finite last price', () => {
    const result = evaluateAnalysisEligibility(
      makeSnapshot({ quote: makeQuote({ last: Number.NaN, bid: 1, ask: 2 }) }),
    );
    expect(result).toMatchObject({ eligible: false, reason: 'invalid-underlying-quote' });
  });

  it('rejects missing candles', () => {
    const result = evaluateAnalysisEligibility(makeSnapshot({ candles: [] }));
    expect(result).toMatchObject({ eligible: false, reason: 'missing-candles' });
  });

  it('rejects a malformed candle (non-finite value)', () => {
    const result = evaluateAnalysisEligibility(
      makeSnapshot({
        candles: [{ time: 1, open: 1, high: 2, low: 0.5, close: Number.NaN, volume: 100 }],
      }),
    );
    expect(result).toMatchObject({ eligible: false, reason: 'invalid-candle-data' });
  });

  it('rejects a candle with inconsistent OHLC (low above open/close/high)', () => {
    const result = evaluateAnalysisEligibility(
      makeSnapshot({
        candles: [{ time: 1, open: 5, high: 6, low: 7, close: 5.5, volume: 100 }],
      }),
    );
    expect(result).toMatchObject({ eligible: false, reason: 'invalid-candle-data' });
  });

  it('rejects a candle with negative volume', () => {
    const result = evaluateAnalysisEligibility(
      makeSnapshot({
        candles: [{ time: 1, open: 5, high: 6, low: 4, close: 5.5, volume: -1 }],
      }),
    );
    expect(result).toMatchObject({ eligible: false, reason: 'invalid-candle-data' });
  });

  it('rejects candle timestamps that are not strictly increasing', () => {
    const result = evaluateAnalysisEligibility(
      makeSnapshot({
        candles: [
          { time: 2, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
          { time: 2, open: 1.5, high: 2, low: 1, close: 1.8, volume: 10 },
        ],
      }),
    );
    expect(result).toMatchObject({ eligible: false, reason: 'invalid-candle-data' });
  });

  it('rejects an invalid selected-contract quote (bid exceeds ask)', () => {
    const badContract = { ...contract, bid: 2.0, ask: 1.9 };
    const result = evaluateAnalysisEligibility(makeSnapshot({ selectedContract: badContract }));
    expect(result).toMatchObject({ eligible: false, reason: 'invalid-selected-contract-quote' });
  });

  it('accepts a valid selected-contract quote', () => {
    const result = evaluateAnalysisEligibility(makeSnapshot({ selectedContract: contract }));
    expect(result.eligible).toBe(true);
  });

  it('rejects invalid position data (non-finite quantity)', () => {
    const badPosition: Position = { ...position, quantity: Number.NaN };
    const result = evaluateAnalysisEligibility(
      makeSnapshot({ selectedContract: contract, positions: [badPosition] }),
    );
    expect(result).toMatchObject({ eligible: false, reason: 'snapshot-mismatch' });
  });

  it('accepts valid position data', () => {
    const result = evaluateAnalysisEligibility(
      makeSnapshot({ selectedContract: contract, positions: [position] }),
    );
    expect(result.eligible).toBe(true);
  });

  it('reports live mode during regular trading hours', () => {
    const result = evaluateAnalysisEligibility(makeSnapshot());
    expect(result).toMatchObject({ eligible: true, mode: 'live' });
  });
});
