import {
  FreshOrderBookSnapshot,
  OrderBookStatus,
  StreamL2SnapshotMessage,
  StreamL2StatusMessage,
} from '@0dtetrader/shared-types';
import { Logger } from '@nestjs/common';
import { isRegularMarketSessionOpen } from '../broker/expiration-calendar';
import { deriveOrderBookIndicators } from './order-book-indicators';
import { OrderBookProvider, OrderBookProviderResult } from './order-book.provider';

type OrderBookMessage = StreamL2SnapshotMessage | StreamL2StatusMessage;
type Listener = (message: OrderBookMessage) => void;

interface Subscriber {
  levels: number;
  listener: Listener;
}

interface SymbolState {
  generation: number;
  subscribers: Map<unknown, Subscriber>;
  history: FreshOrderBookSnapshot[];
  lastObservationAt: number | null;
  pollTimer: NodeJS.Timeout | null;
  staleTimer: NodeJS.Timeout | null;
  inFlight: boolean;
  staleSent: boolean;
  retryAttempt: number;
  sessionId: string;
  latestMessage: OrderBookMessage | null;
  abortController: AbortController;
}

interface OperationalLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface OrderBookServiceOptions {
  pollMs?: number;
  staleMs?: number;
  maxSymbols?: number;
  maxHistory?: number;
  maxLevels?: number;
  maxRetryMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
  cleanupGraceMs?: number;
  logger?: OperationalLogger;
}

export interface OrderBookServiceMetrics {
  activeSymbolGauge: number;
  requests: number;
  coalesced: number;
  unavailable: number;
  stale: number;
  snapshots: number;
  payloadBytes: number;
  teardowns: number;
  throttleDelayMs: number;
  providerLatencyMs: number;
  providerErrors: number;
  rateLimiterErrors: number;
  entitlementUnavailable: number;
  subscriberGauge: number;
  rateGrants: number;
  rateDenials: number;
  decoderTimeMs: number;
  cleanupLeaks: number;
  sessionResets: number;
}

export class OrderBookService {
  private readonly states = new Map<string, SymbolState>();
  private readonly pollMs: number;
  private readonly staleMs: number;
  private readonly maxSymbols: number;
  private readonly maxHistory: number;
  private readonly maxLevels: number;
  private readonly maxRetryMs: number;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly cleanupGraceMs: number;
  private readonly logger: OperationalLogger;
  private sessionTimer: NodeJS.Timeout | null = null;
  private readonly cleanupPending = new Set<string>();
  private readonly cleanupTimers = new Map<string, NodeJS.Timeout>();
  readonly metrics: OrderBookServiceMetrics = {
    activeSymbolGauge: 0,
    requests: 0,
    coalesced: 0,
    unavailable: 0,
    stale: 0,
    snapshots: 0,
    payloadBytes: 0,
    teardowns: 0,
    throttleDelayMs: 0,
    providerLatencyMs: 0,
    providerErrors: 0,
    rateLimiterErrors: 0,
    entitlementUnavailable: 0,
    subscriberGauge: 0,
    rateGrants: 0,
    rateDenials: 0,
    decoderTimeMs: 0,
    cleanupLeaks: 0,
    sessionResets: 0,
  };

  constructor(
    private readonly provider: OrderBookProvider,
    private readonly limiter: {
      acquire(
        appKey: string,
        signal?: AbortSignal,
        onDenied?: (count?: number) => void,
      ): Promise<number | void | { waitedMs: number; denials: number }>;
    },
    options: OrderBookServiceOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 1_000;
    this.staleMs = options.staleMs ?? 5_000;
    this.maxSymbols = options.maxSymbols ?? 500;
    this.maxHistory = options.maxHistory ?? 23_400;
    this.maxLevels = options.maxLevels ?? 50;
    this.maxRetryMs = options.maxRetryMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.cleanupGraceMs = options.cleanupGraceMs ?? 1_000;
    this.logger = options.logger ?? new Logger(OrderBookService.name);
  }

  subscribe(
    clientId: unknown,
    symbolInput: string,
    requestedLevels: number,
    listener: Listener,
  ): void {
    const symbol = symbolInput.trim().toUpperCase();
    const levels = Math.max(1, Math.min(this.maxLevels, Math.trunc(requestedLevels) || 1));
    let state = this.states.get(symbol);
    if (!state) {
      if (this.states.size >= this.maxSymbols) {
        listener(this.status(symbol, 'no_data', 'Server Level 2 capacity is reached.', false));
        this.metrics.unavailable += 1;
        this.log('warn', 'l2_capacity_rejected', { symbol, activeSymbols: this.states.size });
        return;
      }
      state = {
        generation: 1,
        subscribers: new Map(),
        history: [],
        lastObservationAt: null,
        pollTimer: null,
        staleTimer: null,
        inFlight: false,
        staleSent: false,
        retryAttempt: 0,
        sessionId: nySession(new Date(this.now()).toISOString()),
        latestMessage: null,
        abortController: new AbortController(),
      };
      this.states.set(symbol, state);
      this.metrics.activeSymbolGauge += 1;
      this.armSessionBoundary();
    }
    const isNewSubscriber = !state.subscribers.has(clientId);
    state.subscribers.set(clientId, { levels, listener });
    if (isNewSubscriber) {
      this.metrics.subscriberGauge += 1;
      this.log('log', 'l2_subscribed', {
        symbol,
        levels,
        subscribers: state.subscribers.size,
      });
    }
    if (state.latestMessage) listener(state.latestMessage);
    if (state.inFlight) {
      this.metrics.coalesced += 1;
      this.log('log', 'l2_coalesced', { symbol, subscribers: state.subscribers.size });
    } else if (!state.pollTimer) {
      void this.refresh(symbol, state);
    }
  }

  unsubscribe(clientId: unknown, symbolInput: string): void {
    const symbol = symbolInput.trim().toUpperCase();
    const state = this.states.get(symbol);
    if (!state) return;
    if (state.subscribers.delete(clientId)) {
      this.metrics.subscriberGauge -= 1;
      this.log('log', 'l2_unsubscribed', {
        symbol,
        reason: 'unsubscribe',
        subscribers: state.subscribers.size,
      });
    }
    if (state.subscribers.size === 0) this.teardown(symbol, state, 'last_unsubscribe');
  }

  disconnect(clientId: unknown): void {
    for (const [symbol, state] of [...this.states]) {
      if (state.subscribers.delete(clientId)) {
        this.metrics.subscriberGauge -= 1;
        this.log('log', 'l2_unsubscribed', {
          symbol,
          reason: 'disconnect',
          subscribers: state.subscribers.size,
        });
      }
      if (state.subscribers.size === 0) this.teardown(symbol, state, 'disconnect');
    }
  }

  destroy(): void {
    for (const [symbol, state] of [...this.states]) this.teardown(symbol, state, 'shutdown');
    this.cancelSessionBoundaryIfIdle();
  }

  diagnostics(): {
    symbols: number;
    subscribers: number;
    timers: number;
    inFlight: number;
    historySamples: number;
    cleanupPending: number;
  } {
    let subscribers = 0;
    let timers = 0;
    let inFlight = 0;
    let historySamples = 0;
    for (const state of this.states.values()) {
      subscribers += state.subscribers.size;
      if (state.pollTimer) timers += 1;
      if (state.staleTimer) timers += 1;
      if (state.inFlight) inFlight += 1;
      historySamples += state.history.length;
    }
    timers += this.sessionTimer ? 1 : 0;
    inFlight += this.cleanupPending.size;
    return {
      symbols: this.states.size,
      subscribers,
      timers,
      inFlight,
      historySamples,
      cleanupPending: this.cleanupPending.size,
    };
  }

  private async refresh(symbol: string, state: SymbolState): Promise<void> {
    if (this.states.get(symbol) !== state || state.subscribers.size === 0) return;
    if (state.inFlight) {
      this.metrics.coalesced += 1;
      this.log('log', 'l2_coalesced', { symbol, subscribers: state.subscribers.size });
      return;
    }
    state.inFlight = true;
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
    const generation = state.generation;
    let phase: 'limiter' | 'provider' = 'limiter';
    let providerStartedAt: number | null = null;
    try {
      const preflight = this.provider.preflight?.(symbol);
      if (preflight) {
        this.metrics.unavailable += 1;
        this.publish(state, { type: 'l2Status', data: preflight.status });
        if (preflight.status.reason === 'entitlement_missing') {
          this.metrics.entitlementUnavailable += 1;
          this.log('warn', 'l2_entitlement_unavailable', {
            symbol,
            phase: 'preflight',
          });
        }
        if (preflight.status.retryable) {
          state.retryAttempt += 1;
        } else {
          this.teardown(symbol, state, 'terminal_provider_failure');
        }
        return;
      }
      if (!isRegularMarketSessionOpen(new Date(this.now()))) {
        state.retryAttempt += 1;
        this.metrics.unavailable += 1;
        this.publish(
          state,
          this.status(symbol, 'market_closed', 'The New York regular session is closed.', true),
        );
        return;
      }
      const waitedMs = await this.limiter.acquire(
        this.provider.appKey,
        state.abortController.signal,
        (count = 1) => {
          this.metrics.rateDenials += count;
        },
      );
      let measuredWaitMs = 0;
      let measuredDenials = 0;
      if (typeof waitedMs === 'number') {
        this.metrics.throttleDelayMs += waitedMs;
        this.metrics.rateGrants += 1;
        measuredWaitMs = waitedMs;
      } else if (waitedMs && typeof waitedMs === 'object') {
        this.metrics.throttleDelayMs += waitedMs.waitedMs;
        this.metrics.rateGrants += 1;
        measuredWaitMs = waitedMs.waitedMs;
        measuredDenials = waitedMs.denials;
      } else {
        this.metrics.rateGrants += 1;
      }
      this.log('log', 'l2_rate_wait', {
        symbol,
        waitedMs: measuredWaitMs,
        denials: measuredDenials,
      });
      if (!this.isCurrent(symbol, state, generation)) return;
      if (!isRegularMarketSessionOpen(new Date(this.now()))) {
        state.retryAttempt += 1;
        this.metrics.unavailable += 1;
        this.publish(
          state,
          this.status(symbol, 'market_closed', 'The New York regular session is closed.', true),
        );
        return;
      }
      this.metrics.requests += 1;
      phase = 'provider';
      providerStartedAt = this.monotonicNow();
      const result = await this.provider.fetch(
        symbol,
        this.requestedDepth(state),
        state.abortController.signal,
      );
      this.metrics.providerLatencyMs += Math.max(0, this.monotonicNow() - providerStartedAt);
      providerStartedAt = null;
      if (!this.isCurrent(symbol, state, generation)) return;
      this.metrics.decoderTimeMs += result.decoderTimeMs ?? 0;
      if (result.availability === 'unavailable') {
        this.metrics.unavailable += 1;
        if (result.status.reason === 'entitlement_missing') {
          this.metrics.entitlementUnavailable += 1;
          this.log('warn', 'l2_entitlement_unavailable', {
            symbol,
            phase: 'provider',
          });
        } else {
          this.metrics.providerErrors += 1;
        }
        this.publish(state, { type: 'l2Status', data: result.status });
        if (!result.status.retryable) {
          this.teardown(symbol, state, 'terminal_provider_failure');
          return;
        }
        state.retryAttempt += 1;
      } else if (!isRegularMarketSessionOpen(new Date(result.snapshot.timestamp))) {
        this.metrics.unavailable += 1;
        state.retryAttempt += 1;
        this.publish(
          state,
          this.status(
            symbol,
            'market_closed',
            'The provider timestamp is outside the New York regular session.',
            true,
          ),
        );
      } else {
        state.retryAttempt = 0;
        this.acceptSnapshot(symbol, state, result.snapshot);
      }
    } catch (error) {
      if (!this.isCurrent(symbol, state, generation)) return;
      if (providerStartedAt !== null) {
        this.metrics.providerLatencyMs += Math.max(0, this.monotonicNow() - providerStartedAt);
      }
      this.metrics.unavailable += 1;
      state.retryAttempt += 1;
      if (phase === 'provider') {
        this.metrics.providerErrors += 1;
        this.publish(
          state,
          this.status(symbol, 'provider_error', 'Webull Level 2 is unavailable.', true),
        );
        this.log('warn', 'l2_provider_error', {
          symbol,
          message: error instanceof Error ? error.message : String(error),
        });
      } else {
        this.metrics.rateLimiterErrors += 1;
        this.publish(
          state,
          this.status(
            symbol,
            'rate_limiter_unavailable',
            'The distributed Level 2 rate limiter is unavailable.',
            true,
          ),
        );
        this.log('warn', 'l2_rate_limiter_error', {
          symbol,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (this.isCurrent(symbol, state, generation)) {
        state.inFlight = false;
        this.schedulePoll(symbol, state, generation);
      }
      this.settleCleanup(symbol, generation);
    }
  }

  private acceptSnapshot(
    symbol: string,
    state: SymbolState,
    snapshot: Extract<OrderBookProviderResult, { availability: 'available' }>['snapshot'],
  ): void {
    const session = nySession(snapshot.timestamp);
    if (state.sessionId !== session) {
      state.history = [];
      state.lastObservationAt = null;
      state.staleSent = false;
      state.sessionId = session;
      this.publish(
        state,
        this.status(symbol, 'no_data', 'Level 2 state reset for the new New York session.', true),
      );
    }
    const indicators = deriveOrderBookIndicators(
      snapshot,
      state.history,
      this.requestedDepth(state),
    );
    state.history.push(snapshot);
    if (state.history.length > this.maxHistory)
      state.history.splice(0, state.history.length - this.maxHistory);
    state.lastObservationAt = Date.parse(snapshot.timestamp);
    state.staleSent = false;
    const message: StreamL2SnapshotMessage = {
      type: 'l2Snapshot',
      data: { snapshot, indicators },
    };
    this.metrics.snapshots += 1;
    this.metrics.payloadBytes += Buffer.byteLength(JSON.stringify(message));
    this.publish(state, message);
    this.log('log', 'l2_snapshot_published', {
      symbol,
      depth: snapshot.depth,
      payloadBytes: Buffer.byteLength(JSON.stringify(message)),
    });
    this.armStale(symbol, state);
  }

  private schedulePoll(symbol: string, state: SymbolState, generation: number): void {
    if (!this.isCurrent(symbol, state, generation) || state.pollTimer) return;
    const retryDelay =
      state.retryAttempt === 0
        ? this.pollMs
        : Math.min(this.pollMs * 2 ** (state.retryAttempt - 1), this.maxRetryMs);
    state.pollTimer = setTimeout(() => {
      state.pollTimer = null;
      void this.refresh(symbol, state);
    }, retryDelay);
  }

  private armStale(symbol: string, state: SymbolState): void {
    if (state.staleTimer) clearTimeout(state.staleTimer);
    const generation = state.generation;
    const delay = Math.max(0, (state.lastObservationAt ?? this.now()) + this.staleMs - this.now());
    state.staleTimer = setTimeout(() => {
      state.staleTimer = null;
      if (!this.isCurrent(symbol, state, generation) || state.staleSent) return;
      if (
        state.lastObservationAt !== null &&
        this.now() - state.lastObservationAt >= this.staleMs
      ) {
        state.staleSent = true;
        this.metrics.stale += 1;
        this.publish(state, this.status(symbol, 'stale', 'Level 2 data is stale.', true));
        this.log('warn', 'l2_stale', {
          symbol,
          sourceTimestamp: new Date(state.lastObservationAt).toISOString(),
        });
      }
    }, delay);
  }

  private requestedDepth(state: SymbolState): number {
    let depth = 1;
    for (const subscriber of state.subscribers.values()) depth = Math.max(depth, subscriber.levels);
    return Math.min(this.maxLevels, depth);
  }

  private isCurrent(symbol: string, state: SymbolState, generation: number): boolean {
    return (
      this.states.get(symbol) === state &&
      state.generation === generation &&
      state.subscribers.size > 0
    );
  }

  private teardown(symbol: string, state: SymbolState, reason: string): void {
    if (this.states.get(symbol) !== state) return;
    const generation = state.generation;
    state.generation += 1;
    state.abortController.abort();
    if (state.pollTimer) clearTimeout(state.pollTimer);
    if (state.staleTimer) clearTimeout(state.staleTimer);
    state.pollTimer = null;
    state.staleTimer = null;
    this.metrics.subscriberGauge -= state.subscribers.size;
    state.subscribers.clear();
    state.history = [];
    state.latestMessage = null;
    this.states.delete(symbol);
    this.metrics.activeSymbolGauge -= 1;
    this.metrics.teardowns += 1;
    this.log('log', 'l2_teardown', { symbol, reason, generation });
    if (state.inFlight) this.trackCleanup(symbol, generation);
    this.cancelSessionBoundaryIfIdle();
  }

  private armSessionBoundary(): void {
    if (this.sessionTimer || this.states.size === 0) return;
    const delay = Math.max(1, nextNewYorkSessionBoundary(this.now()) - this.now());
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null;
      this.resetForNewSession();
      this.armSessionBoundary();
    }, delay);
    this.sessionTimer.unref?.();
  }

  private cancelSessionBoundaryIfIdle(): void {
    if (this.states.size > 0 || !this.sessionTimer) return;
    clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
  }

  private resetForNewSession(): void {
    const sessionId = nySession(new Date(this.now()).toISOString());
    for (const [symbol, state] of [...this.states]) {
      const generation = state.generation;
      state.generation += 1;
      state.abortController.abort();
      if (state.pollTimer) clearTimeout(state.pollTimer);
      if (state.staleTimer) clearTimeout(state.staleTimer);
      if (state.inFlight) this.trackCleanup(symbol, generation);
      state.history = [];
      state.lastObservationAt = null;
      state.pollTimer = null;
      state.staleTimer = null;
      state.inFlight = false;
      state.staleSent = false;
      state.retryAttempt = 0;
      state.sessionId = sessionId;
      state.latestMessage = null;
      state.abortController = new AbortController();
      this.metrics.sessionResets += 1;
      this.publish(
        state,
        this.status(symbol, 'no_data', 'Level 2 state reset for the new New York session.', true),
      );
      this.log('log', 'l2_session_reset', { symbol, sessionId });
      if (state.subscribers.size > 0) void this.refresh(symbol, state);
      else this.teardown(symbol, state, 'session_reset_empty');
    }
  }

  private trackCleanup(symbol: string, generation: number): void {
    const key = `${symbol}:${generation}`;
    if (this.cleanupPending.has(key)) return;
    this.cleanupPending.add(key);
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(key);
      if (!this.cleanupPending.has(key)) return;
      this.metrics.cleanupLeaks += 1;
      this.log('warn', 'l2_cleanup_pending', { symbol, generation });
    }, this.cleanupGraceMs);
    timer.unref?.();
    this.cleanupTimers.set(key, timer);
  }

  private settleCleanup(symbol: string, generation: number): void {
    const key = `${symbol}:${generation}`;
    if (!this.cleanupPending.delete(key)) return;
    const timer = this.cleanupTimers.get(key);
    if (timer) clearTimeout(timer);
    this.cleanupTimers.delete(key);
  }

  private log(
    level: 'log' | 'warn' | 'error',
    event: string,
    fields: Record<string, unknown>,
  ): void {
    this.logger[level](JSON.stringify({ event, ...fields }));
  }

  private broadcast(state: SymbolState, message: OrderBookMessage): void {
    for (const { listener } of state.subscribers.values()) listener(message);
  }

  private publish(state: SymbolState, message: OrderBookMessage): void {
    state.latestMessage = message;
    this.broadcast(state, message);
  }

  private status(
    symbol: string,
    reason: Extract<OrderBookStatus, { availability: 'unavailable' }>['reason'],
    message: string,
    retryable: boolean,
  ): StreamL2StatusMessage {
    return {
      type: 'l2Status',
      data: {
        availability: 'unavailable',
        symbol,
        provider: 'webull',
        capability: 'nasdaq_totalview_non_display',
        freshness: reason === 'stale' ? 'stale' : null,
        reason,
        message,
        retryable,
      },
    };
  }
}

const sessionFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function nySession(timestamp: string): string {
  return sessionFormatter.format(Date.parse(timestamp));
}

/** Finds the next New York calendar boundary without assuming a 24-hour DST day. */
export function nextNewYorkSessionBoundary(nowMs: number): number {
  const current = nySession(new Date(nowMs).toISOString());
  let low = nowMs;
  let high = nowMs + 30 * 60 * 60 * 1_000;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (nySession(new Date(middle).toISOString()) === current) low = middle;
    else high = middle;
  }
  return high;
}
