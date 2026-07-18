import type { OrderResult, Quote, StreamServerMessage } from '@0dtetrader/shared-types';
import { Store } from '../observable';

export type SocketConnectionState = 'disconnected' | 'connecting' | 'connected';

interface QuoteSocketState {
  connectionState: SocketConnectionState;
  quotes: Record<string, Quote>;
  lastQuote: Quote | null;
  lastErrorMessage: string | null;
}

/**
 * WebSocket client for `/v1/stream?token=<accessToken>` (QuoteSocketClient.swift
 * analog): subscribe/unsubscribe, auto-reconnect with exponential backoff +
 * jitter, fresh token per attempt, re-subscribe after reconnect.
 *
 * Deviation from iOS: browsers cannot send WebSocket ping *frames* and the
 * server rejects any non-subscribe JSON, so the 20s ping loop is replaced by a
 * 20s receive-watchdog — the server ticks quotes every 1s, so 20s of silence
 * while subscribed means the link is dead and we close + reconnect.
 */
export class QuoteSocket extends Store<QuoteSocketState> {
  private ws: WebSocket | null = null;
  private subscribedSymbols = new Set<string>();
  private shouldBeConnected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private orderUpdateListeners = new Set<(update: OrderResult) => void>();
  private quoteListeners = new Set<(quote: Quote) => void>();

  constructor(
    private readonly streamUrl: string,
    private readonly tokenProvider: () => Promise<string>,
  ) {
    super({ connectionState: 'disconnected', quotes: {}, lastQuote: null, lastErrorMessage: null });
  }

  onOrderUpdate(listener: (update: OrderResult) => void): () => void {
    this.orderUpdateListeners.add(listener);
    return () => this.orderUpdateListeners.delete(listener);
  }

  onQuote(listener: (quote: Quote) => void): () => void {
    this.quoteListeners.add(listener);
    return () => this.quoteListeners.delete(listener);
  }

  // MARK: - Lifecycle

  connect(): void {
    this.shouldBeConnected = true;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.openConnection();
  }

  disconnect(): void {
    this.shouldBeConnected = false;
    this.clearReconnectTimer();
    this.teardownConnection();
    this.set({ connectionState: 'disconnected' });
  }

  /** Called when the page becomes visible again: reconnect if dropped. */
  reconnectIfNeeded(): void {
    if (!this.shouldBeConnected) return;
    if (this.getState().connectionState !== 'disconnected') return;
    if (this.reconnectTimer !== null) return;
    this.reconnectAttempt = 0;
    this.openConnection();
  }

  // MARK: - Subscriptions

  subscribe(symbols: string[]): void {
    const newSymbols = symbols.filter((symbol) => !this.subscribedSymbols.has(symbol));
    symbols.forEach((symbol) => this.subscribedSymbols.add(symbol));
    if (this.getState().connectionState === 'connected' && newSymbols.length > 0) {
      this.send({ type: 'subscribe', symbols: newSymbols });
    }
  }

  unsubscribe(symbols: string[]): void {
    const removed = symbols.filter((symbol) => this.subscribedSymbols.has(symbol));
    symbols.forEach((symbol) => this.subscribedSymbols.delete(symbol));
    if (removed.length > 0) {
      const quotes = { ...this.getState().quotes };
      removed.forEach((symbol) => delete quotes[symbol]);
      this.set({ quotes });
      if (this.getState().connectionState === 'connected') {
        this.send({ type: 'unsubscribe', symbols: removed });
      }
    }
  }

  // MARK: - Connection management

  private openConnection(): void {
    const { connectionState } = this.getState();
    if (connectionState === 'connected' || connectionState === 'connecting') return;
    this.set({ connectionState: 'connecting' });
    void (async () => {
      let token: string;
      try {
        token = await this.tokenProvider();
      } catch (error) {
        this.set({
          connectionState: 'disconnected',
          lastErrorMessage: error instanceof Error ? error.message : String(error),
        });
        this.scheduleReconnect();
        return;
      }
      // disconnect() may have fired while we were fetching a token.
      if (!this.shouldBeConnected) {
        this.set({ connectionState: 'disconnected' });
        return;
      }
      const url = new URL(this.streamUrl);
      url.searchParams.set('token', token);
      const ws = new WebSocket(url.toString());
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.set({ connectionState: 'connected' });
        this.reconnectAttempt = 0;
        if (this.subscribedSymbols.size > 0) {
          this.send({ type: 'subscribe', symbols: [...this.subscribedSymbols] });
        }
        this.resetWatchdog();
      };
      ws.onmessage = (event) => {
        if (this.ws !== ws) return;
        this.resetWatchdog();
        this.handleMessage(String(event.data));
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.handleUnexpectedDisconnect();
      };
      ws.onerror = () => {
        // onclose always follows; nothing to do here.
      };
    })();
  }

  private handleUnexpectedDisconnect(): void {
    this.teardownConnection();
    this.set({ connectionState: 'disconnected' });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.shouldBeConnected || this.reconnectTimer !== null) return;
    const attempt = this.reconnectAttempt;
    this.reconnectAttempt += 1;
    const backoff = Math.min(0.5 * Math.pow(2, attempt), 30);
    const delay = backoff + Math.random() * 0.3;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldBeConnected) return;
      this.openConnection();
    }, delay * 1000);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private resetWatchdog(): void {
    if (this.watchdogTimer !== null) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.subscribedSymbols.size > 0 && this.getState().connectionState === 'connected') {
        this.handleUnexpectedDisconnect();
      }
    }, 20_000);
  }

  private teardownConnection(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000);
      } catch {
        // Already closed.
      }
    }
  }

  // MARK: - Wire protocol

  private send(message: { type: 'subscribe' | 'unsubscribe'; symbols: string[] }): void {
    try {
      this.ws?.send(JSON.stringify(message));
    } catch (error) {
      this.set({ lastErrorMessage: error instanceof Error ? error.message : String(error) });
    }
  }

  private handleMessage(raw: string): void {
    let message: StreamServerMessage;
    try {
      message = JSON.parse(raw) as StreamServerMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case 'quote': {
        const quote = message.data;
        this.set({
          quotes: { ...this.getState().quotes, [quote.symbol]: quote },
          lastQuote: quote,
        });
        this.quoteListeners.forEach((listener) => listener(quote));
        break;
      }
      case 'orderUpdate':
        this.orderUpdateListeners.forEach((listener) => listener(message.data));
        break;
      case 'error':
        this.set({ lastErrorMessage: message.error.message });
        break;
      default:
        break;
    }
  }
}
