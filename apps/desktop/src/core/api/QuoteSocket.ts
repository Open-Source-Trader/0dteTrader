import type { ChartOrder, OrderResult, Quote, StreamServerMessage } from '@0dtetrader/shared-types';
import { Store } from '../observable';
import { timed } from '../timing';
import { DurableEventCursor } from './DurableEventCursor';

export type SocketConnectionState = 'disconnected' | 'connecting' | 'connected';

interface QuoteSocketState {
  connectionState: SocketConnectionState;
  lastQuote: Quote | null;
  lastErrorMessage: string | null;
}

type PendingDurableEvent =
  | { kind: 'order'; eventId?: string; sequence?: number; data: OrderResult }
  | { kind: 'chart'; eventId?: string; sequence?: number; data: ChartOrder };

const MAX_PENDING_DURABLE_EVENTS = 2_048;
const LEGACY_READY_FALLBACK_MS = 5_000;

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
  private legacyReadyTimer: ReturnType<typeof setTimeout> | null = null;
  private orderUpdateListeners = new Set<(update: OrderResult) => void>();
  private quoteListeners = new Set<(quote: Quote) => void>();
  private chartOrderListeners = new Set<(order: ChartOrder) => void>();
  private reconnectListeners = new Set<() => void>();
  private readonly durableCursor: DurableEventCursor;
  private pendingDurableEvents: PendingDurableEvent[] = [];
  private deferredServerCursor: number | null = null;
  private drainingDurableEvents = false;
  private connectionGeneration = 0;
  /** Whether a connection has already been established once, so the next
   *  `connected` transition is a RE-connection with a gap to make up. */
  private hasConnected = false;

  constructor(
    private readonly streamUrl: string,
    private readonly tokenProvider: () => Promise<string>,
  ) {
    super({ connectionState: 'disconnected', lastQuote: null, lastErrorMessage: null });
    this.durableCursor = new DurableEventCursor(localStorage, streamUrl);
  }

  onOrderUpdate(listener: (update: OrderResult) => void): () => void {
    this.orderUpdateListeners.add(listener);
    this.drainDurableEvents();
    return () => this.orderUpdateListeners.delete(listener);
  }

  onQuote(listener: (quote: Quote) => void): () => void {
    this.quoteListeners.add(listener);
    return () => this.quoteListeners.delete(listener);
  }

  /**
   * Fired when the socket comes back after having been connected before.
   * Durable events replay before this callback; listeners still re-read the
   * aggregate state as an inexpensive consistency check.
   */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  /** Server-side chart-order watcher fired, failed, or retired a line. */
  onChartOrder(listener: (order: ChartOrder) => void): () => void {
    this.chartOrderListeners.add(listener);
    this.drainDurableEvents();
    return () => {
      this.chartOrderListeners.delete(listener);
    };
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
    this.durableCursor.resetSession();
    this.hasConnected = false;
  }

  /** Called when the page becomes visible again: reconnect if dropped. */
  reconnectIfNeeded(): void {
    if (!this.shouldBeConnected) return;
    if (this.getState().connectionState !== 'disconnected') return;
    if (this.reconnectTimer !== null) return;
    this.reconnectAttempt = 0;
    this.openConnection();
  }

  /**
   * Force a fresh connection, re-subscribing the current symbols. Used after
   * the trading provider changes so live quotes immediately use the new
   * provider (the dispatcher resolves the provider per call, but an already
   * established subscription keeps serving the old one until re-connected).
   */
  reconnect(): void {
    if (!this.shouldBeConnected) return;
    this.teardownConnection();
    this.set({ connectionState: 'disconnected' });
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.openConnection();
  }

  // MARK: - Subscriptions

  subscribeSymbols(symbols: string[]): void {
    const newSymbols = symbols.filter((symbol) => !this.subscribedSymbols.has(symbol));
    symbols.forEach((symbol) => this.subscribedSymbols.add(symbol));
    if (this.ws?.readyState === WebSocket.OPEN && newSymbols.length > 0) {
      this.send({ type: 'subscribe', symbols: newSymbols });
      // Re-arm the receive watchdog: if it previously fired while nothing
      // was subscribed (no-op), the link's health is only re-checked when a
      // message arrives — without this, a half-open socket goes unnoticed.
      this.resetWatchdog();
    }
  }

  unsubscribeSymbols(symbols: string[]): void {
    const removed = symbols.filter((symbol) => this.subscribedSymbols.has(symbol));
    symbols.forEach((symbol) => this.subscribedSymbols.delete(symbol));
    if (removed.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'unsubscribe', symbols: removed });
    }
  }

  // MARK: - Connection management

  private openConnection(): void {
    const { connectionState } = this.getState();
    if (connectionState === 'connected' || connectionState === 'connecting') return;
    this.set({ connectionState: 'connecting' });
    const generation = ++this.connectionGeneration;
    void (async () => {
      let token: string;
      try {
        token = await this.tokenProvider();
      } catch (error) {
        if (generation !== this.connectionGeneration || !this.shouldBeConnected) return;
        this.set({
          connectionState: 'disconnected',
          lastErrorMessage: error instanceof Error ? error.message : String(error),
        });
        this.scheduleReconnect();
        return;
      }
      if (generation !== this.connectionGeneration || !this.shouldBeConnected) return;
      try {
        // Accessing localStorage itself can succeed while getItem still throws
        // (privacy/security policy, a disabled store, or a corrupted backing
        // store). Treat that like any other connection failure instead of
        // leaving this detached async attempt rejected in `connecting`.
        this.durableCursor.activate(token);
      } catch (error) {
        if (generation !== this.connectionGeneration || !this.shouldBeConnected) return;
        this.set({
          connectionState: 'disconnected',
          lastErrorMessage: error instanceof Error ? error.message : 'Event cursor storage failed',
        });
        this.scheduleReconnect();
        return;
      }
      let url: URL;
      try {
        url = new URL(this.streamUrl);
      } catch (error) {
        if (generation !== this.connectionGeneration || !this.shouldBeConnected) return;
        this.set({
          connectionState: 'disconnected',
          lastErrorMessage: error instanceof Error ? error.message : String(error),
        });
        this.scheduleReconnect();
        return;
      }
      url.searchParams.set('token', token);
      url.searchParams.delete('cursor');
      if (this.durableCursor.resumable) {
        url.searchParams.set('cursor', String(this.durableCursor.sequence));
      }
      let ws: WebSocket;
      try {
        ws = new WebSocket(url.toString());
      } catch (error) {
        if (generation !== this.connectionGeneration || !this.shouldBeConnected) return;
        this.set({
          connectionState: 'disconnected',
          lastErrorMessage: error instanceof Error ? error.message : String(error),
        });
        this.scheduleReconnect();
        return;
      }
      if (generation !== this.connectionGeneration || !this.shouldBeConnected) {
        ws.close(1000);
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws || generation !== this.connectionGeneration) return;
        if (this.subscribedSymbols.size > 0) {
          this.send({ type: 'subscribe', symbols: [...this.subscribedSymbols] });
        }
        // `open` only proves the TCP/WebSocket handshake. Stay connecting
        // until the server's eventCursor proves auth + replay catch-up. The
        // bounded fallback below keeps rolling deploys against a pre-cursor
        // API usable without manufacturing a resumable checkpoint.
        this.scheduleLegacyReadyFallback(ws, generation);
        this.resetWatchdog();
      };
      ws.onmessage = (event) => {
        if (this.ws !== ws || generation !== this.connectionGeneration) return;
        this.resetWatchdog();
        this.handleMessage(String(event.data));
      };
      ws.onclose = () => {
        if (this.ws !== ws || generation !== this.connectionGeneration) return;
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
      const state = this.getState().connectionState;
      if (
        this.ws !== null &&
        (state === 'connecting' || (state === 'connected' && this.subscribedSymbols.size > 0))
      ) {
        this.handleUnexpectedDisconnect();
      }
    }, 20_000);
  }

  private teardownConnection(): void {
    this.connectionGeneration += 1;
    this.pendingDurableEvents.length = 0;
    this.deferredServerCursor = null;
    if (this.legacyReadyTimer !== null) {
      clearTimeout(this.legacyReadyTimer);
      this.legacyReadyTimer = null;
    }
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
    timed('QuoteSocket.handleMessage', () => this.processMessage(raw));
  }

  private processMessage(raw: string): void {
    let message: StreamServerMessage;
    try {
      message = JSON.parse(raw) as StreamServerMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case 'quote': {
        const quote = message.data;
        this.set({ lastQuote: quote });
        this.quoteListeners.forEach((listener) => listener(quote));
        break;
      }
      case 'orderUpdate':
        this.enqueueDurable({
          kind: 'order',
          eventId: message.eventId,
          sequence: message.sequence,
          data: message.data,
        });
        break;
      case 'chartOrder':
        this.enqueueDurable({
          kind: 'chart',
          eventId: message.eventId,
          sequence: message.sequence,
          data: message.data,
        });
        break;
      case 'eventCursor':
        this.deferredServerCursor = Math.max(this.deferredServerCursor ?? 0, message.sequence);
        this.drainDurableEvents();
        break;
      case 'error':
        this.set({ lastErrorMessage: message.error.message });
        break;
      default:
        break;
    }
  }

  private enqueueDurable(event: PendingDurableEvent): void {
    if (this.pendingDurableEvents.length >= MAX_PENDING_DURABLE_EVENTS) {
      this.set({ lastErrorMessage: 'Durable event delivery backlog exceeded its safety limit' });
      this.handleUnexpectedDisconnect();
      return;
    }
    const hasMetadata =
      typeof event.eventId === 'string' &&
      Number.isSafeInteger(event.sequence) &&
      (event.sequence ?? 0) > 0;
    if (hasMetadata && !this.durableCursor.resumable) {
      try {
        // A fresh connection intentionally skips historical events, but a
        // live event can arrive before the UI has installed its consumer. Save
        // only the sequence immediately BEFORE that event. If the socket dies
        // while it is still queued, reconnect then resumes from this baseline
        // and the server replays the unseen payload instead of rebasing past it.
        this.durableCursor.establish(event.sequence! - 1);
      } catch (error) {
        this.set({
          lastErrorMessage: error instanceof Error ? error.message : String(error),
        });
        this.handleUnexpectedDisconnect();
        return;
      }
    }
    this.pendingDurableEvents.push(event);
    this.drainDurableEvents();
  }

  private drainDurableEvents(): void {
    if (this.drainingDurableEvents) return;
    this.drainingDurableEvents = true;
    try {
      while (this.pendingDurableEvents.length > 0) {
        const event = this.pendingDurableEvents[0];
        const hasMetadata =
          typeof event.eventId === 'string' && Number.isSafeInteger(event.sequence);
        if (hasMetadata) {
          const decision = this.durableCursor.begin(event.eventId!, event.sequence!);
          if (decision === 'duplicate') {
            this.pendingDurableEvents.shift();
            continue;
          }
          if (decision === 'gap') {
            this.set({ lastErrorMessage: `Durable event gap before sequence ${event.sequence}` });
            this.handleUnexpectedDisconnect();
            return;
          }
        }

        const listeners =
          event.kind === 'order' ? this.orderUpdateListeners : this.chartOrderListeners;
        // Never checkpoint a payload before a consumer exists to observe it.
        if (listeners.size === 0) return;
        try {
          if (event.kind === 'order') {
            for (const listener of listeners as Set<(update: OrderResult) => void>) {
              listener(event.data);
            }
          } else {
            for (const listener of listeners as Set<(order: ChartOrder) => void>) {
              listener(event.data);
            }
          }
          // Cursor persistence (localStorage included) belongs to the same
          // failure boundary as consumer delivery. If it throws, reconnect
          // from the last confirmed sequence and let replay redeliver.
          if (hasMetadata && !this.durableCursor.commit(event.eventId!, event.sequence!)) {
            throw new Error(`Could not commit durable event ${event.sequence}`);
          }
        } catch (error) {
          this.set({
            lastErrorMessage: error instanceof Error ? error.message : String(error),
          });
          this.handleUnexpectedDisconnect();
          return;
        }
        this.pendingDurableEvents.shift();
      }

      if (this.deferredServerCursor !== null) {
        try {
          this.durableCursor.establish(this.deferredServerCursor);
          this.deferredServerCursor = null;
          this.markStreamReady();
        } catch (error) {
          this.set({
            lastErrorMessage: error instanceof Error ? error.message : String(error),
          });
          this.handleUnexpectedDisconnect();
        }
      }
    } finally {
      this.drainingDurableEvents = false;
    }
  }

  private markStreamReady(): void {
    if (!this.shouldBeConnected || this.ws === null) return;
    if (this.getState().connectionState !== 'connecting') return;
    if (this.legacyReadyTimer !== null) {
      clearTimeout(this.legacyReadyTimer);
      this.legacyReadyTimer = null;
    }
    this.set({ connectionState: 'connected', lastErrorMessage: null });
    this.reconnectAttempt = 0;
    const reconnected = this.hasConnected;
    this.hasConnected = true;
    if (reconnected) {
      for (const listener of this.reconnectListeners) listener();
    }
    this.resetWatchdog();
  }

  private scheduleLegacyReadyFallback(ws: WebSocket, generation: number): void {
    if (this.legacyReadyTimer !== null) clearTimeout(this.legacyReadyTimer);
    this.legacyReadyTimer = setTimeout(() => {
      this.legacyReadyTimer = null;
      if (this.ws !== ws || generation !== this.connectionGeneration) return;
      // Receiving eventCursor proves this is a durable server. When its
      // checkpoint is deferred behind an event awaiting a consumer, remain
      // connecting; treating it as legacy would advertise readiness before
      // replay delivery completed.
      if (this.deferredServerCursor !== null) return;
      // Old servers have no eventCursor. Mark the transport usable after a
      // grace period, but deliberately do not establish/persist a cursor.
      this.markStreamReady();
    }, LEGACY_READY_FALLBACK_MS);
  }
}
