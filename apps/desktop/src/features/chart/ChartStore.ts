import type {
  Candle,
  ChartInterval,
  FreshOrderBookSnapshot,
  OrderBookIndicators,
  Quote,
  TickInterval,
} from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { errorMessage } from '../../core/api/ApiError';
import type { QuoteSocket } from '../../core/api/QuoteSocket';
import { parseDateTime } from '../../core/models/dates';
import { Store } from '../../core/observable';
import type { SettingsStore } from '../../core/storage/SettingsStore';
import {
  loadTickState,
  saveTickState,
  type StoredTickState,
  type TickAccumulatorState,
} from '../../core/storage/tickStorage';
import type { ChartDisplayPreferences, IndicatorSettingsState } from '@0dtetrader/shared-types';
import {
  DEFAULT_CHART_DISPLAY,
  DEFAULT_INDICATOR_SETTINGS_STATE,
  validateIndicatorSettingsState,
} from './indicatorRegistry';
import type { OptionsAnalyticsSettings } from './optionsAnalytics/optionsAnalyticsSettings';
import type { TwcHeatmapSettings } from './twc/twcSettings';
import type { UsrSettings } from './ultimateSupportResistance/usrSettings';
import { validateUsrSettings } from './ultimateSupportResistance/usrSettings';
import {
  UNINITIALIZED_VISIBLE_CANDLE_VIEWPORT,
  type VisibleCandleViewport,
} from './candleViewport';
import { validateEnabledIndicatorGeometries } from './indicatorRuntimeValidation';

export const CHART_INTERVALS: ChartInterval[] = [
  '1m',
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
  '1d',
  '1w',
  '10t',
  '25t',
  '50t',
  '100t',
  '250t',
];

// Keyboard-hint labels shown next to each interval in its picker menu.
export const INTERVAL_HINTS: Partial<Record<ChartInterval, string>> = {
  '1m': '1',
  '5m': '5',
  '15m': '3',
  '30m': '0',
  '1h': '⇧H',
  '4h': '4',
  '1d': '⇧D',
  '1w': '⇧W',
};

export const TICK_INTERVALS: TickInterval[] = ['10t', '25t', '50t', '100t', '250t'];

export function isTickInterval(interval: ChartInterval): interval is TickInterval {
  return interval.endsWith('t');
}

export function tickSize(interval: TickInterval): number {
  return parseInt(interval, 10);
}

export function intervalSeconds(interval: ChartInterval): number {
  if (isTickInterval(interval)) return tickSize(interval);
  switch (interval) {
    case '1m':
      return 60;
    case '5m':
      return 300;
    case '15m':
      return 900;
    case '30m':
      return 1800;
    case '1h':
      return 3600;
    case '4h':
      return 14400;
    case '1d':
      return 86400;
    case '1w':
      return 604800;
  }
}

/** 1970-01-01 is a Thursday; shift 4 days so weekly buckets start Monday 00:00 UTC. */
const MONDAY_EPOCH_OFFSET = 345600;

/** Live-quote bucket start — must match the server's candle-aggregation math
 *  so streamed quotes append to the buckets REST history produced. */
export function bucketStartSeconds(epochSeconds: number, interval: ChartInterval): number {
  const seconds = intervalSeconds(interval);
  if (interval === '1w') {
    return (
      Math.floor((epochSeconds - MONDAY_EPOCH_OFFSET) / seconds) * seconds + MONDAY_EPOCH_OFFSET
    );
  }
  return Math.floor(epochSeconds / seconds) * seconds;
}

/** Chart candle with epoch-seconds time, ready for lightweight-charts. */
export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function toChartCandles(dtos: Candle[]): ChartCandle[] {
  const candles: ChartCandle[] = [];
  for (const dto of dtos) {
    const ms = parseDateTime(dto.time);
    if (ms === null) continue;
    candles.push({
      time: Math.floor(ms / 1000),
      open: dto.open,
      high: dto.high,
      low: dto.low,
      close: dto.close,
      volume: dto.volume,
    });
  }
  return candles;
}

export interface ChartStoreState {
  symbol: string;
  interval: ChartInterval;
  candles: ChartCandle[];
  quote: Quote | null;
  isLoading: boolean;
  errorMessage: string | null;
  /** Quote socket is not connected: displayed prices may be frozen. */
  isStale: boolean;
  /** Independent depth state. Unavailable is explicit and never represented by zero values. */
  l2:
    | {
        kind: 'available';
        snapshot: FreshOrderBookSnapshot;
        indicators: OrderBookIndicators;
      }
    | { kind: 'unavailable'; reason: string; isStale: boolean };
  /** Tick intervals only: quotes accumulated toward the next candle. */
  tickProgress: { count: number; size: number } | null;
  indicatorSettings: IndicatorSettingsState;
  chartDisplay: ChartDisplayPreferences;
  twcSettings: TwcHeatmapSettings;
  usrSettings: UsrSettings;
  optionsAnalytics: OptionsAnalyticsSettings;
  /** Price the chart is asked to keep in view ("Show on chart"); null = none.
   *  CandleChart's autoscale merges it into the range while it is set. */
  revealPrice: number | null;
  /** Visible price domain as last painted, reported by CandleChart; null until
   *  the first paint (or when the chart cannot read one). */
  visiblePriceRange: { min: number; max: number } | null;
  /** Initialization/empty/range state for candles intersecting the viewport. */
  visibleCandleViewport: VisibleCandleViewport;
}

/**
 * Slice of ChartStoreState a screen that only needs chart chrome (symbol,
 * settings, error banner) can subscribe to via `useStore(chartStore,
 * chartChromeSlice, shallowEqual)` — skips a re-render on every live-quote
 * tick, which only ever touches `candles`/`quote`/`tickProgress`/`isStale`.
 * `visiblePriceRange` rides along for the workspace's "Show on chart"
 * affordance; `setVisiblePriceRange` drops sub-epsilon jitter, so it does not
 * reintroduce the per-tick re-render this slice exists to avoid.
 */
export function chartChromeSlice(state: ChartStoreState) {
  return {
    symbol: state.symbol,
    errorMessage: state.errorMessage,
    indicatorSettings: state.indicatorSettings,
    chartDisplay: state.chartDisplay,
    twcSettings: state.twcSettings,
    usrSettings: state.usrSettings,
    optionsAnalytics: state.optionsAnalytics,
    visiblePriceRange: state.visiblePriceRange,
  };
}

/** Upper bound on rendered candles so live appends stay cheap. */
const MAX_CANDLES = 600;

/** Tick-state persistence debounce: coalesces bursty in-progress-candle
 *  writes without risking more than this much accumulator state on an
 *  unclean exit. */
const TICK_SAVE_DEBOUNCE_MS = 2_000;

/**
 * Owns the chart (ChartViewModel.swift analog): candle history via REST, live
 * quotes via the socket, symbol/interval switching, indicator settings.
 */
export class ChartStore extends Store<ChartStoreState> {
  /** Invalidates in-flight candle loads when a newer one starts — the same
   *  generation guard ChainStore uses for chain loads. */
  private loadGeneration = 0;
  private tickAccumulator: TickAccumulatorState | null = null;
  /** Coalesces live-quote candle updates to one `set` per animation frame.
   *  A quote socket can push several ticks per frame; each `set` triggers a
   *  React render and, downstream, a full indicator/TWC recompute over every
   *  candle (ChartView's `useMemo`s key on the `candles` array identity) —
   *  expensive work that has no reason to run more than once per paint. */
  private pendingCandlePatch: Partial<ChartStoreState> | null = null;
  private candleFlushHandle: number | null = null;
  /** Debounces tick-state persistence: `handleTickQuote` fires up to once a
   *  second, and each save opens an IndexedDB connection and serializes up
   *  to 600 candles — no reason to pay that on every quote when only the
   *  in-progress accumulator changed. A completed candle (the write that
   *  actually matters for "resume where the chart left off") flushes
   *  immediately instead of waiting out the debounce. */
  private tickSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTickSave: {
    symbol: string;
    interval: TickInterval;
    state: StoredTickState;
  } | null = null;

  constructor(
    private readonly apiClient: ApiClient,
    private readonly socket: QuoteSocket,
    private readonly settingsStore: SettingsStore,
  ) {
    const indicatorSettings = validateIndicatorSettingsState(
      settingsStore.indicatorSettings,
      DEFAULT_INDICATOR_SETTINGS_STATE,
    ).value;
    const storedDisplay = settingsStore.chartDisplay;
    const chartDisplay =
      storedDisplay && typeof storedDisplay.volumeEnabled === 'boolean'
        ? storedDisplay
        : DEFAULT_CHART_DISPLAY;
    super({
      symbol: settingsStore.lastSymbol ?? 'SPY',
      interval: '1m',
      candles: [],
      quote: null,
      isLoading: false,
      errorMessage: null,
      isStale: socket.getState().connectionState !== 'connected',
      l2: {
        kind: 'unavailable',
        reason: socket.l2CapabilityEnabled
          ? 'Waiting for Level 2 data'
          : 'Level 2 capability is disabled',
        isStale: false,
      },
      tickProgress: null,
      indicatorSettings,
      chartDisplay,
      twcSettings: settingsStore.twcSettings,
      usrSettings: settingsStore.usrSettings,
      optionsAnalytics: settingsStore.optionsAnalytics,
      revealPrice: null,
      visiblePriceRange: null,
      visibleCandleViewport: UNINITIALIZED_VISIBLE_CANDLE_VIEWPORT,
    });
    socket.onQuote((quote) => this.handleLiveQuote(quote));
    socket.onL2Update?.((update) => {
      const symbol = this.getState().symbol;
      const updateSymbol =
        update.kind === 'available' ? update.snapshot.symbol : update.status.symbol;
      if (updateSymbol !== symbol) return;
      if (update.kind === 'available') {
        this.set({ l2: update });
      } else {
        this.set({
          l2: {
            kind: 'unavailable',
            reason: update.status.message,
            isStale: update.status.freshness === 'stale' || update.status.reason === 'stale',
          },
        });
      }
    });
    // Mirror the socket's connection state so the header can flag frozen
    // prices (reconnect + re-subscribe are owned by QuoteSocket itself).
    socket.subscribe(() => {
      const stale = socket.getState().connectionState !== 'connected';
      if (stale !== this.getState().isStale) this.set({ isStale: stale });
      if (stale && socket.l2CapabilityEnabled) {
        this.set({
          l2: { kind: 'unavailable', reason: 'Level 2 stream disconnected', isStale: true },
        });
      }
    });
  }

  /** Initial load + subscription. Called when the trade screen appears. */
  async start(): Promise<void> {
    this.socket.subscribeSymbols([this.getState().symbol]);
    this.socket.subscribeL2?.(this.getState().symbol, 50);
    await this.loadCandles();
  }

  async loadCandles(): Promise<void> {
    const generation = ++this.loadGeneration;
    this.cancelPendingCandlePatch();
    // A debounced tick-state save for the chart being left behind must not
    // be silently dropped — it's still the most recent accumulator state
    // for that symbol/interval, and the debounce only exists to reduce
    // write frequency, not to discard writes.
    this.flushTickSave();
    const { symbol, interval } = this.getState();

    if (isTickInterval(interval)) {
      this.tickAccumulator = null;
      this.set({ isLoading: true, errorMessage: null, tickProgress: null });
      const stored = await loadTickState(symbol, interval);
      if (generation !== this.loadGeneration) return;
      this.tickAccumulator = stored.accumulator;
      let candles = stored.candles;
      if (candles.length === 0) {
        // Never show a blank chart while ticks accumulate (a 250t candle takes
        // ~4 min of 1/sec quotes): seed with recent 1m history.
        try {
          const from = new Date(Date.now() - 60 * 60 * 1000);
          const dtos = await this.apiClient.candles(symbol, '1m', from);
          if (generation !== this.loadGeneration) return;
          candles = toChartCandles(dtos);
        } catch {
          // Seeding is best-effort; the chart fills from live ticks.
        }
      }
      this.set({
        candles,
        isLoading: false,
        tickProgress: { count: stored.accumulator?.count ?? 0, size: tickSize(interval) },
      });
      return;
    }

    this.set({ isLoading: true, errorMessage: null, tickProgress: null });
    try {
      const from = new Date(Date.now() - intervalSeconds(interval) * 400 * 1000);
      const dtos = await this.apiClient.candles(symbol, interval, from);
      if (generation !== this.loadGeneration) return;
      this.set({ candles: toChartCandles(dtos) });
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      if (generation === this.loadGeneration) this.set({ isLoading: false });
    }
  }

  selectSymbol(newSymbol: string): void {
    const normalized = newSymbol.toUpperCase().trim();
    const { symbol } = this.getState();
    if (!normalized || normalized === symbol) return;
    this.socket.unsubscribeSymbols([symbol]);
    this.socket.unsubscribeL2?.(symbol);
    this.settingsStore.lastSymbol = normalized;
    this.tickAccumulator = null;
    this.cancelPendingCandlePatch();
    // A reveal and a visible range are levels on the old symbol's scale;
    // neither means anything on the new one.
    this.set({
      symbol: normalized,
      quote: null,
      candles: [],
      tickProgress: null,
      revealPrice: null,
      visiblePriceRange: null,
      visibleCandleViewport: UNINITIALIZED_VISIBLE_CANDLE_VIEWPORT,
      l2: {
        kind: 'unavailable',
        reason: this.socket.l2CapabilityEnabled
          ? 'Waiting for Level 2 data'
          : 'Level 2 capability is disabled',
        isStale: false,
      },
    });
    this.socket.subscribeSymbols([normalized]);
    this.socket.subscribeL2?.(normalized, 50);
    void this.loadCandles();
  }

  selectInterval(newInterval: ChartInterval): void {
    if (newInterval === this.getState().interval) return;
    this.tickAccumulator = null;
    this.set({
      interval: newInterval,
      visibleCandleViewport: UNINITIALIZED_VISIBLE_CANDLE_VIEWPORT,
    });
    void this.loadCandles();
  }

  setIndicatorSettings(settings: IndicatorSettingsState): void {
    const result = validateIndicatorSettingsState(settings, this.getState().indicatorSettings);
    if (!result.ok) return;
    const candles = this.getState().candles.map((candle) => ({
      ...candle,
      timestamp: candle.time * 1000,
    }));
    if (!validateEnabledIndicatorGeometries(result.value, candles).ok) return;
    this.settingsStore.indicatorSettings = result.value;
    this.set({ indicatorSettings: result.value });
  }

  setChartDisplay(chartDisplay: ChartDisplayPreferences): void {
    if (typeof chartDisplay.volumeEnabled !== 'boolean') return;
    this.settingsStore.chartDisplay = chartDisplay;
    this.set({ chartDisplay });
  }

  setTwcSettings(settings: TwcHeatmapSettings): void {
    this.settingsStore.twcSettings = settings;
    this.set({ twcSettings: settings });
  }

  setUsrSettings(candidate: UsrSettings): void {
    try {
      const settings = validateUsrSettings(candidate);
      this.settingsStore.usrSettings = settings;
      this.set({ usrSettings: settings });
    } catch {
      // Reject malformed persisted/UI state without destabilizing live charting.
    }
  }

  setOptionsAnalytics(settings: OptionsAnalyticsSettings): void {
    this.settingsStore.optionsAnalytics = settings;
    this.set({ optionsAnalytics: settings });
  }

  /** "Show on chart": asks the chart to keep `price` in view; null clears the
   *  reveal, which lets the previous viewport come back. */
  setRevealPrice(price: number | null): void {
    if (price === this.getState().revealPrice) return;
    this.set({ revealPrice: price });
  }

  /**
   * CandleChart reports the pane's price domain here after every repaint-worthy
   * change. Moves under half a percent of the current span are dropped: live
   * autoscale jitter re-reports on every tick, every `set` notifies every
   * subscriber, and the only consumer (is a given line in view?) does not turn
   * on a fraction of a percent.
   */
  setVisiblePriceRange(range: { min: number; max: number } | null): void {
    const current = this.getState().visiblePriceRange;
    if (range === null || current === null) {
      if (range !== current) this.set({ visiblePriceRange: range });
      return;
    }
    const epsilon = (current.max - current.min) * 0.005;
    if (
      Math.abs(range.min - current.min) <= epsilon &&
      Math.abs(range.max - current.max) <= epsilon
    ) {
      return;
    }
    this.set({ visiblePriceRange: range });
  }

  setVisibleCandleViewport(viewport: VisibleCandleViewport): void {
    const current = this.getState().visibleCandleViewport;
    if (current.kind !== viewport.kind) {
      this.set({ visibleCandleViewport: viewport });
      return;
    }
    if (current.kind !== 'range' || viewport.kind !== 'range') return;
    if (current.from === viewport.from && current.to === viewport.to) return;
    this.set({ visibleCandleViewport: viewport });
  }

  // MARK: - Live updates

  /** Reads the candle array as of the last call, including any patch still
   *  pending in this frame's coalesced flush — so per-tick logic (tick
   *  accumulator, bucket boundaries) always sees the latest value even
   *  though the React-visible `set` hasn't run yet. */
  private get liveCandles(): ChartCandle[] {
    const pending = this.pendingCandlePatch?.candles;
    return pending ?? this.getState().candles;
  }

  /** Merges a patch into the pending frame instead of setting immediately;
   *  `quote` updates (cheap: header price/bid/ask) still land right away. */
  private setCandlePatch(patch: Partial<ChartStoreState>): void {
    this.pendingCandlePatch = { ...this.pendingCandlePatch, ...patch };
    if (this.candleFlushHandle !== null) return;
    this.candleFlushHandle = requestAnimationFrame(() => {
      this.candleFlushHandle = null;
      const patchToApply = this.pendingCandlePatch;
      this.pendingCandlePatch = null;
      if (patchToApply) this.set(patchToApply);
    });
  }

  /** Discards any coalesced live-quote patch not yet flushed — a symbol or
   *  interval switch replaces `candles` outright, and a stale tick-derived
   *  patch landing a frame later would clobber it with the old symbol's
   *  data. */
  private cancelPendingCandlePatch(): void {
    if (this.candleFlushHandle !== null) {
      cancelAnimationFrame(this.candleFlushHandle);
      this.candleFlushHandle = null;
    }
    this.pendingCandlePatch = null;
  }

  /** Debounces `saveTickState`: replaces whatever write was pending (only
   *  the latest state is worth persisting) and restarts the timer, so a
   *  burst of same-second quotes collapses into one IndexedDB write. */
  private scheduleTickSave(symbol: string, interval: TickInterval, state: StoredTickState): void {
    this.pendingTickSave = { symbol, interval, state };
    if (this.tickSaveTimer !== null) clearTimeout(this.tickSaveTimer);
    this.tickSaveTimer = setTimeout(() => this.flushTickSave(), TICK_SAVE_DEBOUNCE_MS);
  }

  /** Writes the pending tick-state save now, bypassing the debounce — used
   *  when a candle just completed (the write that actually matters) and
   *  when switching away from a tick-interval chart. */
  private flushTickSave(): void {
    if (this.tickSaveTimer !== null) {
      clearTimeout(this.tickSaveTimer);
      this.tickSaveTimer = null;
    }
    const pending = this.pendingTickSave;
    this.pendingTickSave = null;
    if (pending) void saveTickState(pending.symbol, pending.interval, pending.state);
  }

  private handleLiveQuote(quote: Quote): void {
    const { symbol, interval } = this.getState();
    if (quote.symbol !== symbol) return;
    this.set({ quote });

    if (isTickInterval(interval)) {
      this.handleTickQuote(quote);
      return;
    }

    const candles = this.liveCandles;
    if (candles.length === 0) return;

    const timestampMs = parseDateTime(quote.timestamp);
    if (timestampMs === null) return;
    const bucketStart = bucketStartSeconds(timestampMs / 1000, interval);
    const last = candles[candles.length - 1];

    if (bucketStart === last.time) {
      const updated: ChartCandle = {
        ...last,
        close: quote.last,
        high: Math.max(last.high, quote.last),
        low: Math.min(last.low, quote.last),
      };
      this.setCandlePatch({ candles: [...candles.slice(0, -1), updated] });
    } else if (bucketStart > last.time) {
      const appended: ChartCandle = {
        time: bucketStart,
        open: last.close,
        high: Math.max(last.close, quote.last),
        low: Math.min(last.close, quote.last),
        close: quote.last,
        volume: 0,
      };
      let next = [...candles, appended];
      if (next.length > MAX_CANDLES) {
        next = next.slice(next.length - MAX_CANDLES);
      }
      this.setCandlePatch({ candles: next });
    }
  }

  private handleTickQuote(quote: Quote): void {
    const { interval, symbol } = this.getState();
    if (!isTickInterval(interval)) return;
    const candles = this.liveCandles;
    const size = tickSize(interval);
    const price = quote.last;
    const timestampMs = parseDateTime(quote.timestamp);
    if (timestampMs === null) return;
    const timestampSeconds = Math.floor(timestampMs / 1000);

    if (!this.tickAccumulator) {
      this.tickAccumulator = {
        count: 1,
        open: price,
        high: price,
        low: price,
        close: price,
        firstTimestamp: timestampSeconds,
      };
    } else {
      this.tickAccumulator.count += 1;
      this.tickAccumulator.close = price;
      this.tickAccumulator.high = Math.max(this.tickAccumulator.high, price);
      this.tickAccumulator.low = Math.min(this.tickAccumulator.low, price);
    }

    let next = candles;
    if (this.tickAccumulator.count >= size) {
      const previous = candles[candles.length - 1];
      const candle: ChartCandle = {
        // lightweight-charts requires strictly ascending times; a 1m seed
        // candle can share the same second as the first live tick candle.
        time:
          previous && this.tickAccumulator.firstTimestamp <= previous.time
            ? previous.time + 1
            : this.tickAccumulator.firstTimestamp,
        open: this.tickAccumulator.open,
        high: this.tickAccumulator.high,
        low: this.tickAccumulator.low,
        close: this.tickAccumulator.close,
        volume: 0,
      };
      next = [...candles, candle];
      if (next.length > MAX_CANDLES) {
        next = next.slice(next.length - MAX_CANDLES);
      }
      this.tickAccumulator = null;
      this.setCandlePatch({ candles: next, tickProgress: { count: 0, size } });
      // A completed candle is the write that actually matters for "resume
      // where the chart left off" — flush immediately rather than waiting
      // out the debounce below, which exists only for the in-progress
      // accumulator churning on every quote.
      this.scheduleTickSave(symbol, interval, { candles: next, accumulator: this.tickAccumulator });
      this.flushTickSave();
    } else {
      this.set({ tickProgress: { count: this.tickAccumulator.count, size } });
      // In-progress accumulator only: debounced, so a burst of same-second
      // quotes doesn't open an IndexedDB connection and serialize up to 600
      // candles on every one of them.
      this.scheduleTickSave(symbol, interval, { candles: next, accumulator: this.tickAccumulator });
    }
  }
}
