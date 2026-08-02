import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Quote } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import type { QuoteSocket } from '../../core/api/QuoteSocket';
import type { SettingsStore } from '../../core/storage/SettingsStore';
import { loadTickState, saveTickState } from '../../core/storage/tickStorage';
import { bucketStartSeconds, chartChromeSlice, ChartStore, type ChartCandle } from './ChartStore';

vi.mock('../../core/storage/tickStorage', () => ({
  loadTickState: vi.fn(async () => ({ candles: [], accumulator: null })),
  saveTickState: vi.fn(async () => undefined),
}));

/** ChartStore coalesces live-quote candle updates via requestAnimationFrame,
 *  absent in this suite's node test environment. Stub it to run the queued
 *  callback synchronously so `handleLiveQuote` still applies its patch
 *  within the same tick — the tests below assert on `getState()` right
 *  after calling it. */
let rafId = 0;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return ++rafId;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

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

function makeStore(apiClient: ApiClient = {} as ApiClient): ChartStore {
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
  const store = new ChartStore(apiClient, socket, settingsStore);
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

  it('coalesces several same-frame quotes into a single notify, applying only the latest', () => {
    // Override the module-level synchronous rAF stub: queue callbacks and
    // flush them by hand, so multiple quotes can land before a frame fires —
    // the exact scenario a bursty quote socket produces.
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queued.push(cb);
      return queued.length;
    });
    const store = makeStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    liveQuote(store, quote('2026-07-17T14:30:10Z', 501.6));
    liveQuote(store, quote('2026-07-17T14:30:20Z', 501.7));
    liveQuote(store, quote('2026-07-17T14:30:30Z', 501.9));
    // `quote` (header price) still notifies immediately per tick; the
    // candle-array patch itself has not flushed yet.
    expect(notifications).toBe(3);
    expect(store.getState().candles.at(-1)!.close).toBe(501.2);

    expect(queued).toHaveLength(1); // one frame requested for all three ticks
    queued[0](0);

    expect(notifications).toBe(4);
    const last = store.getState().candles.at(-1)!;
    expect(last.close).toBe(501.9); // only the latest tick's values applied
    expect(last.high).toBe(501.9);
  });
});

describe('weekly bucketing', () => {
  // Same fixture week as the API's candle-aggregation.spec.ts.
  const MONDAY = Date.parse('2026-07-13T00:00:00.000Z') / 1000;

  it('aligns weekly buckets to Monday 00:00 UTC, not the Thursday epoch', () => {
    const friday = Date.parse('2026-07-17T19:59:00.000Z') / 1000;
    expect(bucketStartSeconds(friday, '1w')).toBe(MONDAY);
    const sunday = Date.parse('2026-07-12T23:00:00.000Z') / 1000;
    expect(bucketStartSeconds(sunday, '1w')).toBe(MONDAY - 604800);
  });

  it('updates the Monday-keyed candle for a Friday quote', () => {
    const store = makeStore();
    const weekly: ChartCandle[] = [
      { time: MONDAY, open: 500, high: 505, low: 498, close: 503, volume: 100 },
    ];
    (store as unknown as { set(patch: object): void }).set({ interval: '1w', candles: weekly });
    liveQuote(store, quote('2026-07-17T19:59:00Z', 506));

    const candles = store.getState().candles;
    expect(candles).toHaveLength(1);
    expect(candles[0].time).toBe(MONDAY);
    expect(candles[0].close).toBe(506);
    expect(candles[0].high).toBe(506);
  });

  it('opens a new Monday bucket after Sunday midnight UTC', () => {
    const store = makeStore();
    const weekly: ChartCandle[] = [
      { time: MONDAY, open: 500, high: 505, low: 498, close: 503, volume: 100 },
    ];
    (store as unknown as { set(patch: object): void }).set({ interval: '1w', candles: weekly });
    liveQuote(store, quote('2026-07-20T00:00:30Z', 507));

    const candles = store.getState().candles;
    expect(candles).toHaveLength(2);
    expect(candles.at(-1)!.time).toBe(MONDAY + 604800);
    expect(candles.at(-1)!.open).toBe(503);
  });
});

describe('tick charts', () => {
  it('restores a persisted accumulator, reports progress, and completes the candle', async () => {
    (loadTickState as Mock).mockResolvedValueOnce({
      candles: [{ time: 1_784_298_000, open: 1, high: 1, low: 1, close: 1, volume: 0 }],
      accumulator: { count: 8, open: 1, high: 2, low: 1, close: 2, firstTimestamp: 1_784_298_500 },
    });
    const store = makeStore();
    (store as unknown as { set(patch: object): void }).set({ interval: '10t', candles: [] });
    await store.loadCandles();
    expect(store.getState().tickProgress).toEqual({ count: 8, size: 10 });

    liveQuote(store, quote('2026-07-17T14:30:01Z', 501));
    expect(store.getState().tickProgress).toEqual({ count: 9, size: 10 });
    liveQuote(store, quote('2026-07-17T14:30:02Z', 502));

    const state = store.getState();
    expect(state.candles).toHaveLength(2);
    expect(state.candles.at(-1)!.close).toBe(502);
    expect(state.tickProgress).toEqual({ count: 0, size: 10 });
    // A completed candle flushes its save immediately (bypassing the
    // debounce) so a restart resumes with the freshly reset accumulator.
    expect(saveTickState).toHaveBeenCalledWith(
      'SPY',
      '10t',
      expect.objectContaining({ accumulator: null }),
    );
  });

  it('bumps a completed tick candle sharing a second with the last seed candle', async () => {
    const seedTime = Math.floor(Date.parse('2026-07-17T14:30:00Z') / 1000);
    (loadTickState as Mock).mockResolvedValueOnce({
      candles: [{ time: seedTime, open: 1, high: 1, low: 1, close: 1, volume: 0 }],
      accumulator: { count: 9, open: 1, high: 2, low: 1, close: 2, firstTimestamp: seedTime },
    });
    const store = makeStore();
    (store as unknown as { set(patch: object): void }).set({ interval: '10t', candles: [] });
    await store.loadCandles();
    liveQuote(store, quote('2026-07-17T14:30:00Z', 502));

    const candles = store.getState().candles;
    expect(candles).toHaveLength(2);
    // Strictly ascending: the collision with the seed candle is bumped by 1s.
    expect(candles.at(-1)!.time).toBe(seedTime + 1);
  });

  it('debounces an in-progress accumulator save instead of writing every quote', async () => {
    (loadTickState as Mock).mockResolvedValueOnce({ candles: [], accumulator: null });
    vi.useFakeTimers();
    try {
      const store = makeStore();
      (store as unknown as { set(patch: object): void }).set({ interval: '10t', candles: [] });
      await store.loadCandles();
      const callsBefore = (saveTickState as Mock).mock.calls.length;

      // Three ticks in quick succession, none completing the (size 10)
      // candle — each should restart the debounce, not write immediately.
      liveQuote(store, quote('2026-07-17T14:30:01Z', 501));
      liveQuote(store, quote('2026-07-17T14:30:02Z', 502));
      liveQuote(store, quote('2026-07-17T14:30:03Z', 503));
      expect((saveTickState as Mock).mock.calls.length).toBe(callsBefore);

      await vi.advanceTimersByTimeAsync(2_000);
      expect((saveTickState as Mock).mock.calls.length).toBe(callsBefore + 1);
      expect(saveTickState).toHaveBeenLastCalledWith(
        'SPY',
        '10t',
        expect.objectContaining({ accumulator: expect.objectContaining({ count: 3, close: 503 }) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes a pending tick save immediately when switching symbols', async () => {
    (loadTickState as Mock).mockResolvedValueOnce({ candles: [], accumulator: null });
    vi.useFakeTimers();
    try {
      const store = makeStore();
      (store as unknown as { set(patch: object): void }).set({ interval: '10t', candles: [] });
      await store.loadCandles();
      const callsBefore = (saveTickState as Mock).mock.calls.length;

      liveQuote(store, quote('2026-07-17T14:30:01Z', 501));
      expect((saveTickState as Mock).mock.calls.length).toBe(callsBefore);

      (loadTickState as Mock).mockResolvedValueOnce({ candles: [], accumulator: null });
      store.selectSymbol('QQQ');
      await vi.runOnlyPendingTimersAsync();

      // The debounced write for SPY landed even though the 2s window never
      // elapsed — a symbol switch must not silently drop it.
      expect((saveTickState as Mock).mock.calls.length).toBeGreaterThan(callsBefore);
      expect(saveTickState).toHaveBeenCalledWith(
        'SPY',
        '10t',
        expect.objectContaining({ accumulator: expect.objectContaining({ count: 1 }) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('seeds an empty tick chart from recent 1m history', async () => {
    (loadTickState as Mock).mockResolvedValueOnce({ candles: [], accumulator: null });
    const apiClient = {
      candles: vi.fn(async () => [
        { time: '2026-07-17T14:30:00Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
      ]),
    } as unknown as ApiClient;
    const store = makeStore(apiClient);
    (store as unknown as { set(patch: object): void }).set({ interval: '25t', candles: [] });
    await store.loadCandles();

    expect(apiClient.candles).toHaveBeenCalledWith('SPY', '1m', expect.any(Date));
    expect(store.getState().candles).toHaveLength(1);
    expect(store.getState().tickProgress).toEqual({ count: 0, size: 25 });
  });

  it('does not seed when persisted tick candles exist', async () => {
    (loadTickState as Mock).mockResolvedValueOnce({
      candles: [{ time: 1_784_298_000, open: 1, high: 1, low: 1, close: 1, volume: 0 }],
      accumulator: null,
    });
    const apiClient = { candles: vi.fn() } as unknown as ApiClient;
    const store = makeStore(apiClient);
    (store as unknown as { set(patch: object): void }).set({ interval: '10t', candles: [] });
    await store.loadCandles();

    expect(apiClient.candles).not.toHaveBeenCalled();
    expect(store.getState().candles).toHaveLength(1);
  });
});

describe('chartChromeSlice', () => {
  it('omits candles/quote/tickProgress/isStale — the fields a live tick changes', () => {
    const store = makeStore();
    liveQuote(store, quote('2026-07-17T14:30:30Z', 501.9));

    const before = chartChromeSlice(store.getState());
    liveQuote(store, quote('2026-07-17T14:30:31Z', 502.5));
    const after = chartChromeSlice(store.getState());

    // The candle/quote genuinely changed on the underlying state...
    expect(store.getState().quote?.last).toBe(502.5);
    // ...but the slice a chrome-only subscriber reads did not.
    expect(after).toEqual(before);
  });

  it('includes symbol/errorMessage/settings — what chart chrome actually renders', () => {
    const store = makeStore();
    const slice = chartChromeSlice(store.getState());
    expect(Object.keys(slice).sort()).toEqual(
      [
        'errorMessage',
        'indicatorSettings',
        'optionsAnalytics',
        'symbol',
        'twcSettings',
        'visiblePriceRange',
      ].sort(),
    );
  });
});

describe('ChartStore price reveal ("Show on chart")', () => {
  it('stores the reveal price and clears it, with the visible range, on a symbol switch', () => {
    const store = makeStore();
    store.setRevealPrice(497.5);
    store.setVisiblePriceRange({ min: 500, max: 510 });
    expect(store.getState().revealPrice).toBe(497.5);
    expect(store.getState().visiblePriceRange).toEqual({ min: 500, max: 510 });

    store.selectSymbol('QQQ');

    expect(store.getState().revealPrice).toBeNull();
    expect(store.getState().visiblePriceRange).toBeNull();
  });

  it('clearing the reveal is what lets the chart restore its viewport', () => {
    const store = makeStore();
    store.setRevealPrice(497.5);
    store.setRevealPrice(null);
    expect(store.getState().revealPrice).toBeNull();
  });

  it('drops sub-epsilon visible-range jitter without notifying subscribers', () => {
    const store = makeStore();
    store.setVisiblePriceRange({ min: 100, max: 110 });
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    // 0.1% of the span: the per-tick autoscale wobble this gate exists for.
    store.setVisiblePriceRange({ min: 100.01, max: 110.01 });
    expect(notifications).toBe(0);
    expect(store.getState().visiblePriceRange).toEqual({ min: 100, max: 110 });

    // A real pan lands.
    store.setVisiblePriceRange({ min: 102, max: 112 });
    expect(notifications).toBe(1);
    expect(store.getState().visiblePriceRange).toEqual({ min: 102, max: 112 });

    // The chart tearing down reports null, which must always land.
    store.setVisiblePriceRange(null);
    expect(store.getState().visiblePriceRange).toBeNull();
  });
});

describe('ChartStore options analytics settings', () => {
  it('loads and persists the renamed settings contract', () => {
    const socket = {
      onQuote: () => () => undefined,
      subscribe: () => () => undefined,
      getState: () => ({ connectionState: 'connected' }),
      subscribeSymbols: () => undefined,
      unsubscribeSymbols: () => undefined,
    } as unknown as QuoteSocket;
    const optionsAnalytics = {
      enabled: false,
      showImpliedRange: true,
      showGammaProfile: true,
      showMarkedOi: false,
      showLiquidity: false,
      showDealerProxy: false,
      refreshSeconds: 45,
      profileStrikeCount: 12,
    };
    const settingsStore = {
      lastSymbol: 'SPY',
      indicatorSettings: {},
      twcSettings: {},
      optionsAnalytics,
    } as unknown as SettingsStore;
    const store = new ChartStore({} as ApiClient, socket, settingsStore);

    expect(
      (store.getState() as unknown as { optionsAnalytics: typeof optionsAnalytics })
        .optionsAnalytics,
    ).toEqual(optionsAnalytics);
    const enabled = { ...optionsAnalytics, enabled: true };
    (
      store as unknown as {
        setOptionsAnalytics(settings: typeof optionsAnalytics): void;
      }
    ).setOptionsAnalytics(enabled);
    expect(
      (settingsStore as unknown as { optionsAnalytics: typeof optionsAnalytics }).optionsAnalytics,
    ).toEqual(enabled);
  });
});
