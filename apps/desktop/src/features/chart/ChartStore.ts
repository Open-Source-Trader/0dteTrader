import type { CandleInterval, Quote } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { errorMessage } from '../../core/api/ApiError';
import type { QuoteSocket } from '../../core/api/QuoteSocket';
import { parseDateTime } from '../../core/models/dates';
import { Store } from '../../core/observable';
import type { SettingsStore } from '../../core/storage/SettingsStore';
import type { IndicatorSettings } from './indicatorSettings';

export const CHART_INTERVALS: CandleInterval[] = ['1m', '5m', '15m', '1h', '1d'];

export function intervalSeconds(interval: CandleInterval): number {
  switch (interval) {
    case '1m':
      return 60;
    case '5m':
      return 300;
    case '15m':
      return 900;
    case '1h':
      return 3600;
    case '1d':
      return 86400;
  }
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

interface ChartStoreState {
  symbol: string;
  interval: CandleInterval;
  candles: ChartCandle[];
  quote: Quote | null;
  isLoading: boolean;
  errorMessage: string | null;
  indicatorSettings: IndicatorSettings;
}

/** Upper bound on rendered candles so live appends stay cheap. */
const MAX_CANDLES = 600;

/**
 * Owns the chart (ChartViewModel.swift analog): candle history via REST, live
 * quotes via the socket, symbol/interval switching, indicator settings.
 */
export class ChartStore extends Store<ChartStoreState> {
  constructor(
    private readonly apiClient: ApiClient,
    private readonly socket: QuoteSocket,
    private readonly settingsStore: SettingsStore,
  ) {
    super({
      symbol: settingsStore.lastSymbol ?? 'SPY',
      interval: '1m',
      candles: [],
      quote: null,
      isLoading: false,
      errorMessage: null,
      indicatorSettings: settingsStore.indicatorSettings,
    });
    socket.onQuote((quote) => this.handleLiveQuote(quote));
  }

  /** Initial load + subscription. Called when the trade screen appears. */
  async start(): Promise<void> {
    this.socket.subscribe([this.getState().symbol]);
    await this.loadCandles();
  }

  async loadCandles(): Promise<void> {
    const { symbol, interval } = this.getState();
    this.set({ isLoading: true, errorMessage: null });
    try {
      const from = new Date(Date.now() - intervalSeconds(interval) * 400 * 1000);
      const dtos = await this.apiClient.candles(symbol, interval, from);
      const candles: ChartCandle[] = dtos.map((dto) => ({
        time: Math.floor((parseDateTime(dto.time) ?? 0) / 1000),
        open: dto.open,
        high: dto.high,
        low: dto.low,
        close: dto.close,
        volume: dto.volume,
      }));
      this.set({ candles });
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      this.set({ isLoading: false });
    }
  }

  selectSymbol(newSymbol: string): void {
    const normalized = newSymbol.toUpperCase().trim();
    const { symbol } = this.getState();
    if (!normalized || normalized === symbol) return;
    this.socket.unsubscribe([symbol]);
    this.settingsStore.lastSymbol = normalized;
    this.set({ symbol: normalized, quote: null, candles: [] });
    this.socket.subscribe([normalized]);
    void this.loadCandles();
  }

  selectInterval(newInterval: CandleInterval): void {
    if (newInterval === this.getState().interval) return;
    this.set({ interval: newInterval });
    void this.loadCandles();
  }

  setIndicatorSettings(settings: IndicatorSettings): void {
    this.settingsStore.indicatorSettings = settings;
    this.set({ indicatorSettings: settings });
  }

  // MARK: - Live updates

  private handleLiveQuote(quote: Quote): void {
    const { symbol, interval, candles } = this.getState();
    if (quote.symbol !== symbol) return;
    this.set({ quote });
    if (candles.length === 0) return;

    const timestampSeconds = (parseDateTime(quote.timestamp) ?? 0) / 1000;
    const seconds = intervalSeconds(interval);
    const bucketStart = Math.floor(timestampSeconds / seconds) * seconds;
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
}
