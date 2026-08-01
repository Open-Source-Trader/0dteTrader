import { describe, expect, it } from 'vitest';
import type { CandleCloseEvent } from '../chart/ChartStore';
import { connectCandleCloseAnalysis, type CandleCloseWiringDeps } from './candleCloseWiring';
import type { AnalysisSnapshot } from './types';

function makeHarness(availability: 'ready' | 'unavailable' = 'ready') {
  const listeners = new Set<(event: CandleCloseEvent) => void>();
  const submitted: AnalysisSnapshot[] = [];

  const deps: CandleCloseWiringDeps = {
    chartStore: {
      onCandleClose: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getState: () =>
        ({
          symbol: 'SPY',
          interval: '1m',
          candles: [
            { time: 1_784_298_600, open: 501, high: 502, low: 500, close: 501.5, volume: 9 },
          ],
          quote: null,
          isLoading: false,
          errorMessage: null,
          isStale: false,
          tickProgress: null,
          indicatorSettings: {},
          twcSettings: {},
          optionsAnalytics: {},
          // Wiring only reads the snapshot-builder subset of ChartStoreState.
        }) as unknown as ReturnType<CandleCloseWiringDeps['chartStore']['getState']>,
    },
    analysisStore: {
      getState: () =>
        ({ availability: { state: availability } }) as unknown as ReturnType<
          CandleCloseWiringDeps['analysisStore']['getState']
        >,
      submitCandleClose: async (snapshot: AnalysisSnapshot) => {
        submitted.push(snapshot);
      },
    },
    getPositions: () => [],
  };

  const emit = (event: CandleCloseEvent) => listeners.forEach((listener) => listener(event));
  return { deps, emit, submitted, listeners };
}

const CLOSE: CandleCloseEvent = { symbol: 'SPY', interval: '1m', closeTime: 1_784_298_600 };

describe('connectCandleCloseAnalysis', () => {
  it('submits a candle-close snapshot when the model is ready', () => {
    const { deps, emit, submitted } = makeHarness('ready');
    connectCandleCloseAnalysis(deps);

    emit(CLOSE);

    expect(submitted).toHaveLength(1);
    expect(submitted[0].trigger).toEqual({
      kind: 'candle-close',
      priority: 'candle-close',
      reason: expect.stringContaining('candle closed at 1784298600'),
    });
    expect(submitted[0].identity.symbol).toBe('SPY');
  });

  it('does nothing while the model is not ready', () => {
    const { deps, emit, submitted } = makeHarness('unavailable');
    connectCandleCloseAnalysis(deps);

    emit(CLOSE);

    expect(submitted).toEqual([]);
  });

  it('fires at most once per distinct candle close', () => {
    const { deps, emit, submitted } = makeHarness('ready');
    connectCandleCloseAnalysis(deps);

    emit(CLOSE);
    emit(CLOSE);
    emit({ ...CLOSE, closeTime: CLOSE.closeTime + 60 });

    expect(submitted).toHaveLength(2);
  });

  it('tracks dedupe state per symbol+timeframe independently', () => {
    const { deps, emit, submitted } = makeHarness('ready');
    connectCandleCloseAnalysis(deps);

    emit(CLOSE);
    emit({ ...CLOSE, symbol: 'QQQ' });
    emit({ ...CLOSE, interval: '5m' });

    expect(submitted).toHaveLength(3);
  });

  it('stops firing after disconnect', () => {
    const { deps, emit, submitted } = makeHarness('ready');
    const disconnect = connectCandleCloseAnalysis(deps);
    disconnect();

    emit(CLOSE);

    expect(submitted).toEqual([]);
  });
});
