import { describe, expect, it } from 'vitest';
import type { Quote } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import type { QuoteSocket } from '../../core/api/QuoteSocket';
import type { SettingsStore } from '../../core/storage/SettingsStore';
import { ChartStore, type ChartCandle } from './ChartStore';

const BUCKET = 1_784_298_600; // 2026-07-17T14:30:00Z, on a 1m boundary

function quote(timestamp: string, last = 501.5): Quote {
  return {
    symbol: 'SPY',
    bid: last - 0.02,
    ask: last + 0.02,
    last,
    bidSize: 1,
    askSize: 1,
    volume: 0,
    timestamp,
  };
}

function makeStore(): ChartStore {
  const socket = {
    onQuote: () => () => undefined,
    subscribe: () => () => undefined,
    getState: () => ({ connectionState: 'connected' }),
    subscribeSymbols: () => undefined,
    unsubscribeSymbols: () => undefined,
  } as unknown as QuoteSocket;
  const settingsStore = {
    lastSymbol: 'SPY',
    indicatorSettings: {},
  } as unknown as SettingsStore;
  const store = new ChartStore({} as ApiClient, socket, settingsStore);
  const seeded: ChartCandle[] = [
    { time: BUCKET, open: 501, high: 501.4, low: 500.9, close: 501.2, volume: 100 },
  ];
  (store as unknown as { set(patch: object): void }).set({ candles: seeded });
  return store;
}

function liveQuote(store: ChartStore, q: Quote): void {
  (store as unknown as { handleLiveQuote(quote: Quote): void }).handleLiveQuote(q);
}

describe('ChartStore.handleLiveQuote', () => {
  it('updates the current candle for an in-bucket quote', () => {
    const store = makeStore();
    liveQuote(store, quote('2026-07-17T14:30:30Z', 501.9));

    const last = store.getState().candles.at(-1)!;
    expect(last.close).toBe(501.9);
    expect(last.high).toBe(501.9);
    expect(store.getState().quote?.last).toBe(501.9);
  });

  it('drops a quote with an unparseable timestamp from bucketing but keeps the quote', () => {
    const store = makeStore();
    const before = store.getState().candles;
    liveQuote(store, quote('not-a-timestamp', 999));

    expect(store.getState().candles).toEqual(before);
    expect(store.getState().quote?.last).toBe(999);
  });

  it('appends a new candle for a next-bucket quote', () => {
    const store = makeStore();
    liveQuote(store, quote('2026-07-17T14:31:05Z', 502.1));

    const candles = store.getState().candles;
    expect(candles).toHaveLength(2);
    expect(candles.at(-1)!.time).toBe(BUCKET + 60);
    expect(candles.at(-1)!.open).toBe(501.2);
  });
});
