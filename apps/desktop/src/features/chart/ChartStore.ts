import type { Candle, ChartInterval, TickInterval, Quote } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { errorMessage } from '../../core/api/ApiError';
import type { QuoteSocket } from '../../core/api/QuoteSocket';
import { parseDateTime } from '../../core/models/dates';
import { Store } from '../../core/observable';
import type { SettingsStore } from '../../core/storage/SettingsStore';
import {
  loadTickState,
  saveTickState,
  type TickAccumulatorState,
} from '../../core/storage/tickStorage';
import type { IndicatorSettings } from './indicatorSettings';
import { capSubPanes } from './indicatorSettings';
import type { OptionsAnalyticsSettings } from './optionsAnalytics/optionsAnalyticsSettings';
import type { TwcHeatmapSettings } from './twc/twcSettings';

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

interface ChartStoreState {
  symbol: string;
  interval: ChartInterval;
  candles: ChartCandle[];
  quote: Quote | null;
  isLoading: boolean;
  errorMessage: string | null;
  /** Quote socket is not connected: displayed prices may be frozen. */
  isStale: boolean;
  /** Tick intervals only: quotes accumulated toward the next candle. */
  tickProgress: { count: number; size: number } | null;
  indicatorSettings: IndicatorSettings;
  twcSettings: TwcHeatmapSettings;
  optionsAnalytics: OptionsAnalyticsSettings;
}

/** Upper bound on rendered candles so live appends stay cheap. */
const MAX_CANDLES = 600;

/**
 * Owns the chart (ChartViewModel.swift analog): candle history via REST, live
 * quotes via the socket, symbol/interval switching, indicator settings.
 */
export class ChartStore extends Store<ChartStoreState> {
  /** Invalidates in-flight candle loads when a newer one starts — the same
   *  generation guard ChainStore uses for chain loads. */
  private loadGeneration = 0;
  private tickAccumulator: TickAccumulatorState | null = null;

  constructor(
    private readonly apiClient: ApiClient,
    private readonly socket: QuoteSocket,
    private readonly settingsStore: SettingsStore,
  ) {
    // Persisted settings from before the sub-pane cap may exceed it; clamp
    // and write back so the stored state matches what's on screen.
    const indicatorSettings = capSubPanes(settingsStore.indicatorSettings);
    if (indicatorSettings !== settingsStore.indicatorSettings) {
      settingsStore.indicatorSettings = indicatorSettings;
    }
    super({
      symbol: settingsStore.lastSymbol ?? 'SPY',
      interval: '1m',
      candles: [],
      quote: null,
      isLoading: false,
      errorMessage: null,
      isStale: socket.getState().connectionState !== 'connected',
      tickProgress: null,
      indicatorSettings,
      twcSettings: settingsStore.twcSettings,
      optionsAnalytics: settingsStore.optionsAnalytics,
    });
    socket.onQuote((quote) => this.handleLiveQuote(quote));
    // Mirror the socket's connection state so the header can flag frozen
    // prices (reconnect + re-subscribe are owned by QuoteSocket itself).
    socket.subscribe(() => {
      const stale = socket.getState().connectionState !== 'connected';
      if (stale !== this.getState().isStale) this.set({ isStale: stale });
    });
  }

  /** Initial load + subscription. Called when the trade screen appears. */
  async start(): Promise<void> {
    this.socket.subscribeSymbols([this.getState().symbol]);
    await this.loadCandles();
  }

  async loadCandles(): Promise<void> {
    const generation = ++this.loadGeneration;
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
    this.settingsStore.lastSymbol = normalized;
    this.tickAccumulator = null;
    this.set({ symbol: normalized, quote: null, candles: [], tickProgress: null });
    this.socket.subscribeSymbols([normalized]);
    void this.loadCandles();
  }

  selectInterval(newInterval: ChartInterval): void {
    if (newInterval === this.getState().interval) return;
    this.tickAccumulator = null;
    this.set({ interval: newInterval });
    void this.loadCandles();
  }

  setIndicatorSettings(settings: IndicatorSettings): void {
    const capped = capSubPanes(settings);
    this.settingsStore.indicatorSettings = capped;
    this.set({ indicatorSettings: capped });
  }

  setTwcSettings(settings: TwcHeatmapSettings): void {
    this.settingsStore.twcSettings = settings;
    this.set({ twcSettings: settings });
  }

  setOptionsAnalytics(settings: OptionsAnalyticsSettings): void {
    this.settingsStore.optionsAnalytics = settings;
    this.set({ optionsAnalytics: settings });
  }

  // MARK: - Live updates

  private handleLiveQuote(quote: Quote): void {
    const { symbol, interval, candles } = this.getState();
    if (quote.symbol !== symbol) return;
    this.set({ quote });

    if (isTickInterval(interval)) {
      this.handleTickQuote(quote);
      return;
    }

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
      this.set({ candles: [...candles.slice(0, -1), updated] });
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
      this.set({ candles: next });
    }
  }

  private handleTickQuote(quote: Quote): void {
    const { interval, candles, symbol } = this.getState();
    if (!isTickInterval(interval)) return;
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
      const candle: ChartCandle = {
        time: this.tickAccumulator.firstTimestamp,
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
      this.set({ candles: next, tickProgress: { count: 0, size } });
    } else {
      this.set({ tickProgress: { count: this.tickAccumulator.count, size } });
    }
    // Persist candles and the in-progress accumulator on every quote (≤1/sec)
    // so a restart resumes the partial candle instead of losing it.
    void saveTickState(symbol, interval, { candles: next, accumulator: this.tickAccumulator });
  }
}
