import { Inject, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import {
  ChartOrder,
  IVAlert,
  IVAlertConfiguration,
  IVAlertConfigurationState,
  OrderResult,
  Quote,
  StreamServerMessage,
} from '@0dtetrader/shared-types';
import { BROKER_GATEWAY, BrokerGateway } from '../broker/broker-gateway.interface';
import { DurableUserEvent, EventTransportService } from '../events/event-transport.service';
import { Subscription } from 'rxjs';
import { CryptoDataService } from './crypto-data.service';
import { IndexDataService } from './index-data.service';
import { OrderBookService } from './order-book.service';
import { IvAlertService } from '../options-analytics/iv-alert.service';

const QUOTE_TICK_MS = 1000;
/** Index quotes poll slower: Tradier allows ~120 market-data req/min shared
 *  with options analytics, so 3 indices at 5s cost only 36 req/min. */
const INDEX_QUOTE_TICK_MS = 5000;
/** Abuse guards: each subscribed symbol costs broker/API calls every second. */
const MAX_SUBSCRIPTIONS_PER_CLIENT = 50;
const MAX_TRACKED_SYMBOLS = 500;
const SYMBOL_PATTERN = /^[A-Za-z0-9.-]{1,32}$/;

interface ClientState {
  userId: string;
  symbols: Set<string>;
  l2Symbols: Set<string>;
  lastSequence: number;
  replaying: boolean;
  pending: DurableUserEvent[];
  deliveredLiveIvAlertIds?: Set<string>;
  lastIvAlertConfigurationUpdatedAt?: number;
}

export interface StreamGatewayMetrics {
  ivAlertDelivered: number;
  ivAlertDeliveryFailures: number;
  ivAlertConfigurationFanout: number;
}

/**
 * WebSocket streaming at /v1/stream (docs/API-SPEC.md).
 *
 * Auth: `?token=<accessToken>` query param at upgrade time.
 * Client → server: `{ "type": "subscribe"|"unsubscribe", "symbols": [...] }`.
 * Server → client: `quote` ticks every 1s per subscribed symbol, plus
 * `orderUpdate` events addressed to the owning user. Quote fan-out is one
 * timer per symbol per process regardless of subscriber count
 * (docs/WEBULL-INTEGRATION.md §3).
 */
@WebSocketGateway({ path: '/v1/stream' })
export class StreamGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(StreamGateway.name);
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly subscribers = new Map<string, Set<WebSocket>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Symbols with a tick currently in flight — prevents interval stacking. */
  private readonly inFlightTicks = new Set<string>();
  /** Last logged quote-tick warning per key — identical failures log once. */
  private readonly tickWarnings = new Map<string, string>();
  private readonly durableEventsSub: Subscription;
  readonly metrics: StreamGatewayMetrics = {
    ivAlertDelivered: 0,
    ivAlertDeliveryFailures: 0,
    ivAlertConfigurationFanout: 0,
  };

  constructor(
    @Inject(BROKER_GATEWAY) private readonly broker: BrokerGateway,
    private readonly crypto: CryptoDataService,
    private readonly index: IndexDataService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly eventTransport: EventTransportService,
    private readonly orderBooks: OrderBookService,
    @Optional() private readonly ivAlerts?: IvAlertService,
  ) {
    this.durableEventsSub = eventTransport.events$.subscribe((event) =>
      this.pushDurableEvent(event),
    );
  }

  onModuleDestroy(): void {
    this.durableEventsSub.unsubscribe();
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.orderBooks.destroy();
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  handleConnection(client: WebSocket, req: IncomingMessage): void {
    const token = this.extractToken(req);
    const userId = token ? this.verifyToken(token) : null;
    if (!userId) {
      this.send(client, {
        type: 'error',
        error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' },
      });
      client.close(1008, 'Unauthorized');
      return;
    }

    const cursor = this.extractCursor(req);
    const state: ClientState = {
      userId,
      symbols: new Set(),
      l2Symbols: new Set(),
      lastSequence: cursor ?? 0,
      replaying: true,
      pending: [],
    };
    this.clients.set(client, state);
    client.on('message', (raw) => this.handleMessage(client, raw));
    client.on('close', () => this.handleDisconnect(client));
    client.on('error', () => this.handleDisconnect(client));
    void this.sendInitialIvAlertConfiguration(client, state);
    void this.replayClient(client, userId, cursor);
  }

  handleDisconnect(client: WebSocket): void {
    const state = this.clients.get(client);
    if (!state) return;
    for (const symbol of state.symbols) {
      this.removeSubscriber(symbol, client);
    }
    this.orderBooks.disconnect(client);
    this.clients.delete(client);
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  private handleMessage(client: WebSocket, raw: unknown): void {
    let msg: {
      type?: string;
      symbols?: unknown;
      symbol?: unknown;
      levels?: unknown;
      data?: unknown;
    };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      this.send(client, {
        type: 'error',
        error: { code: 'BAD_MESSAGE', message: 'Message must be JSON' },
      });
      return;
    }

    const symbols = Array.isArray(msg.symbols)
      ? msg.symbols.filter((s): s is string => typeof s === 'string' && SYMBOL_PATTERN.test(s))
      : [];
    const state = this.clients.get(client);
    if (!state) return;

    if (msg.type === 'ivAlertConfigure') {
      void this.configureIvAlerts(client, state, msg.data);
      return;
    }

    if (msg.type === 'l2Subscribe') {
      if (
        typeof msg.symbol !== 'string' ||
        !SYMBOL_PATTERN.test(msg.symbol) ||
        !Number.isInteger(msg.levels) ||
        (msg.levels as number) < 1 ||
        (msg.levels as number) > 50
      ) {
        this.badMessage(
          client,
          'l2Subscribe requires a valid symbol and integer levels from 1 to 50',
        );
        return;
      }
      const symbol = msg.symbol.toUpperCase();
      if (!state.l2Symbols.has(symbol) && state.l2Symbols.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
        this.send(client, {
          type: 'error',
          error: {
            code: 'SUBSCRIPTION_LIMIT',
            message: `At most ${MAX_SUBSCRIPTIONS_PER_CLIENT} Level 2 symbols per connection`,
          },
        });
        return;
      }
      state.l2Symbols.add(symbol);
      this.orderBooks.subscribe(client, symbol, msg.levels as number, (message) => {
        this.send(client, message);
        if (message.type === 'l2Status' && message.data.availability === 'unavailable') {
          if (!message.data.retryable) state.l2Symbols.delete(symbol);
        }
      });
      return;
    }
    if (msg.type === 'l2Unsubscribe') {
      if (typeof msg.symbol !== 'string' || !SYMBOL_PATTERN.test(msg.symbol)) {
        this.badMessage(client, 'l2Unsubscribe requires a valid symbol');
        return;
      }
      const symbol = msg.symbol.toUpperCase();
      state.l2Symbols.delete(symbol);
      this.orderBooks.unsubscribe(client, symbol);
      return;
    }

    if (msg.type === 'subscribe') {
      for (const symbol of symbols) this.addSubscriber(symbol, client, state);
    } else if (msg.type === 'unsubscribe') {
      for (const symbol of symbols) this.removeSubscriber(symbol, client, state);
    } else {
      this.badMessage(
        client,
        'type must be subscribe, unsubscribe, l2Subscribe, l2Unsubscribe, or ivAlertConfigure',
      );
    }
  }

  private async configureIvAlerts(
    client: WebSocket,
    state: ClientState,
    data: unknown,
  ): Promise<void> {
    if (!this.ivAlerts || data === null || typeof data !== 'object' || Array.isArray(data)) {
      this.send(client, {
        type: 'error',
        error: {
          code: 'IV_ALERT_CONFIGURATION_INVALID',
          message: 'IV alert configuration is unavailable or invalid.',
        },
      });
      return;
    }
    try {
      const configured = await this.ivAlerts.configure(state.userId, data as IVAlertConfiguration);
      for (const [peer, peerState] of this.clients) {
        if (peerState.userId !== state.userId) continue;
        this.sendIvAlertConfiguration(peer, peerState, configured, true);
      }
    } catch (error) {
      if (this.clients.get(client) !== state) return;
      this.send(client, {
        type: 'error',
        error: {
          code: 'IV_ALERT_CONFIGURATION_INVALID',
          message: error instanceof Error ? error.message : 'Invalid IV alert configuration.',
        },
      });
    }
  }

  private async sendInitialIvAlertConfiguration(
    client: WebSocket,
    state: ClientState,
  ): Promise<void> {
    if (!this.ivAlerts) return;
    try {
      const configuration = await this.ivAlerts.getConfiguration(state.userId);
      if (this.clients.get(client) !== state) return;
      this.sendIvAlertConfiguration(client, state, configuration, false);
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'iv_alert_configuration_load_failed',
          userId: state.userId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private badMessage(client: WebSocket, message: string): void {
    this.send(client, { type: 'error', error: { code: 'BAD_MESSAGE', message } });
  }

  private addSubscriber(symbol: string, client: WebSocket, state: ClientState): void {
    if (state.symbols.has(symbol)) return;
    if (state.symbols.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
      this.send(client, {
        type: 'error',
        error: {
          code: 'SUBSCRIPTION_LIMIT',
          message: `At most ${MAX_SUBSCRIPTIONS_PER_CLIENT} symbols per connection`,
        },
      });
      return;
    }
    const isNewSymbol = !this.subscribers.has(symbol);
    if (isNewSymbol && this.subscribers.size >= MAX_TRACKED_SYMBOLS) {
      this.send(client, {
        type: 'error',
        error: {
          code: 'SUBSCRIPTION_LIMIT',
          message: 'Server symbol capacity reached — try again later',
        },
      });
      return;
    }
    state.symbols.add(symbol);
    let set = this.subscribers.get(symbol);
    if (!set) {
      set = new Set();
      this.subscribers.set(symbol, set);
    }
    set.add(client);
    if (!this.timers.has(symbol)) {
      const tickMs = this.index.isIndexSymbol(symbol) ? INDEX_QUOTE_TICK_MS : QUOTE_TICK_MS;
      this.timers.set(
        symbol,
        setInterval(() => void this.tickSymbol(symbol), tickMs),
      );
      // Emit an immediate first tick so subscribers do not wait a full second.
      void this.tickSymbol(symbol);
    }
  }

  private removeSubscriber(symbol: string, client: WebSocket, state?: ClientState): void {
    state?.symbols.delete(symbol);
    const set = this.subscribers.get(symbol);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) {
      this.subscribers.delete(symbol);
      const timer = this.timers.get(symbol);
      if (timer) clearInterval(timer);
      this.timers.delete(symbol);
      // Drop the symbol's tick-warning memory (both crypto and per-user keys).
      for (const key of [...this.tickWarnings.keys()]) {
        if (key === symbol || key.endsWith(`:${symbol}`)) {
          this.tickWarnings.delete(key);
        }
      }
    }
  }

  private async tickSymbol(symbol: string): Promise<void> {
    // Skip if the previous tick for this symbol is still running (broker
    // latency up to the 10s timeout would otherwise stack concurrent ticks).
    if (this.inFlightTicks.has(symbol)) return;
    const set = this.subscribers.get(symbol);
    if (!set || set.size === 0) return;
    this.inFlightTicks.add(symbol);
    try {
      // Crypto quotes are public and user-independent: one fetch for everyone.
      if (this.crypto.isCryptoSymbol(symbol)) {
        try {
          this.broadcast(set, { type: 'quote', data: await this.crypto.getQuote(symbol) });
          this.tickWarnings.delete(symbol);
        } catch (err) {
          this.warnTickOnce(symbol, `quote tick failed for ${symbol}: ${(err as Error).message}`);
        }
        return;
      }

      // Index quotes (Tradier) are fetched per user like broker quotes: a
      // user with a stored Tradier key streams from the same client their
      // REST candles come from, so the chart never mixes two feeds. Users
      // sharing a client scope collapse to one Tradier call via
      // IndexDataService's scope-keyed quote cache.
      if (this.index.isIndexSymbol(symbol)) {
        await this.fanOutPerUser(set, symbol, (userId) => this.index.getQuote(symbol, userId));
        return;
      }

      // Broker quotes are fetched per user: gateways use per-user credentials,
      // so one subscriber's quote must never be served under another's account.
      await this.fanOutPerUser(set, symbol, (userId) => this.broker.getQuote(userId, symbol));
    } finally {
      this.inFlightTicks.delete(symbol);
    }
  }

  /** Logs a quote-tick warning only when it differs from the last one logged
   *  for the same key — a persistent failure logs once, not every second. */
  /** Group a symbol's subscribers by user, fetch once per user (per-scope
   *  caches downstream dedupe same-credential users), and fan the quote out
   *  to each user's sockets. Failures are per-user so one broken credential
   *  never blanks the tick for everyone else. */
  private async fanOutPerUser(
    set: Set<WebSocket>,
    symbol: string,
    fetchQuote: (userId: string) => Promise<Quote>,
  ): Promise<void> {
    const byUser = new Map<string, WebSocket[]>();
    for (const client of set) {
      const state = this.clients.get(client);
      if (!state) continue;
      const list = byUser.get(state.userId);
      if (list) list.push(client);
      else byUser.set(state.userId, [client]);
    }
    for (const [userId, clients] of byUser) {
      const key = `${userId}:${symbol}`;
      try {
        const quote = await fetchQuote(userId);
        for (const client of clients) this.send(client, { type: 'quote', data: quote });
        this.tickWarnings.delete(key);
      } catch (err) {
        this.warnTickOnce(
          key,
          `quote tick failed for ${symbol} (user ${userId}): ${(err as Error).message}`,
        );
      }
    }
  }

  private warnTickOnce(key: string, message: string): void {
    if (this.tickWarnings.get(key) === message) return;
    this.tickWarnings.set(key, message);
    this.logger.warn(message);
  }

  private pushDurableEvent(event: DurableUserEvent): void {
    for (const [client, state] of this.clients) {
      if (state.userId !== event.userId) continue;
      if (state.replaying) state.pending.push(event);
      else this.sendDurable(client, state, event, true);
    }
  }

  private async replayClient(
    client: WebSocket,
    userId: string,
    cursor: number | null,
  ): Promise<void> {
    try {
      const state = this.clients.get(client);
      if (!state) return;
      if (cursor === null) {
        // A brand-new client has no gap to recover. Establish a baseline at
        // the current tail instead of replaying the user's entire lifetime of
        // events (and re-firing historical desktop notifications).
        const baseline = await this.eventTransport.latestSequence(userId);
        // Subscribe/buffering starts before this query, but another instance's
        // committed row may not have reached this process's polling Subject
        // yet. Force a transport drain before inspecting the buffer so a row
        // included in `baseline` cannot be silently checkpointed and dropped.
        await this.eventTransport.pollOnce();
        if (this.clients.get(client) !== state) return;
        // Events committed while the baseline query was in flight are also
        // queued by the live subscription. Keep the baseline immediately
        // before the first such event so none is mistaken for old history.
        const firstPending = state.pending.reduce(
          (lowest, event) => Math.min(lowest, event.sequence),
          Number.POSITIVE_INFINITY,
        );
        state.lastSequence = Number.isFinite(firstPending)
          ? Math.min(baseline, firstPending - 1)
          : baseline;
      } else {
        let after = cursor;
        for (;;) {
          const missed = await this.eventTransport.replay(userId, after, 1_000);
          if (this.clients.get(client) !== state) return;
          for (const event of missed) this.sendDurable(client, state, event, false);
          if (missed.length < 1_000) break;
          after = missed[missed.length - 1].sequence;
        }
      }
      if (this.clients.get(client) !== state) return;
      state.replaying = false;
      const pending = state.pending.splice(0).sort((a, b) => a.sequence - b.sequence);
      for (const event of pending) this.sendDurable(client, state, event, true);
      // A client that has never received a durable event still needs a saved
      // baseline. Without this handshake, reconnecting with local cursor 0
      // looks brand new and silently skips everything emitted while offline.
      this.send(client, { type: 'eventCursor', sequence: state.lastSequence });
    } catch (error) {
      const state = this.clients.get(client);
      // Do not switch to live fan-out after a failed catch-up: pending events
      // would either remain stranded or jump over the missing range. Closing
      // forces the client to reconnect with its last confirmed cursor.
      if (state) client.close(1011, 'Event replay failed');
      this.logger.warn(`event replay failed for user ${userId}: ${(error as Error).message}`);
    }
  }

  private sendDurable(
    client: WebSocket,
    state: ClientState,
    event: DurableUserEvent,
    live: boolean,
  ): void {
    if (event.type === 'ivAlert' && live) {
      const delivered = (state.deliveredLiveIvAlertIds ??= new Set<string>());
      if (delivered.has(event.id)) return;
      delivered.add(event.id);
      if (delivered.size > 2_048) {
        const oldest = delivered.values().next().value;
        if (oldest) delivered.delete(oldest);
      }
      state.lastSequence = Math.max(state.lastSequence, event.sequence);
      this.sendLiveIvAlert(client, event);
      return;
    }
    if (event.type === 'ivAlertConfiguration' && live) {
      state.lastSequence = Math.max(state.lastSequence, event.sequence);
      if (isIvAlertConfigurationState(event.payload)) {
        this.sendIvAlertConfiguration(client, state, event.payload, true);
      } else {
        this.logger.error(
          JSON.stringify({
            event: 'iv_alert_configuration_delivery_failed',
            userId: event.userId,
            eventId: event.id,
            reason: 'invalid_payload',
          }),
        );
      }
      return;
    }
    if (event.sequence <= state.lastSequence) return;
    state.lastSequence = event.sequence;
    if (event.type === 'orderUpdate') {
      this.send(client, {
        type: 'orderUpdate',
        eventId: event.id,
        sequence: event.sequence,
        data: event.payload as OrderResult,
      });
    } else if (event.type === 'chartOrder') {
      this.send(client, {
        type: 'chartOrder',
        eventId: event.id,
        sequence: event.sequence,
        data: event.payload as ChartOrder,
      });
    }
    // IV alerts and configuration updates are intentionally live-only. Their
    // historical rows still advance the cursor so reconnect replay terminates
    // without re-firing notifications or stale configuration updates.
  }

  private sendIvAlertConfiguration(
    client: WebSocket,
    state: ClientState,
    configuration: IVAlertConfigurationState,
    countFanout: boolean,
  ): boolean {
    const updatedAt = Date.parse(configuration.updatedAt);
    if (
      state.lastIvAlertConfigurationUpdatedAt !== undefined &&
      updatedAt <= state.lastIvAlertConfigurationUpdatedAt
    ) {
      return true;
    }
    if (!this.send(client, { type: 'ivAlertConfiguration', data: configuration })) return false;
    state.lastIvAlertConfigurationUpdatedAt = updatedAt;
    if (countFanout) this.metrics.ivAlertConfigurationFanout += 1;
    return true;
  }

  private sendLiveIvAlert(client: WebSocket, event: DurableUserEvent): void {
    if (isIvAlert(event.payload)) {
      if (this.send(client, { type: 'ivAlert', data: event.payload })) {
        this.metrics.ivAlertDelivered += 1;
        this.logger.log(
          JSON.stringify({
            event: 'iv_alert_delivered',
            userId: event.userId,
            eventId: event.id,
            symbol: event.payload.symbol,
          }),
        );
      } else {
        this.metrics.ivAlertDeliveryFailures += 1;
        this.logger.warn(
          JSON.stringify({
            event: 'iv_alert_delivery_failed',
            userId: event.userId,
            eventId: event.id,
            symbol: event.payload.symbol,
          }),
        );
      }
    } else {
      this.metrics.ivAlertDeliveryFailures += 1;
      this.logger.error(
        JSON.stringify({
          event: 'iv_alert_delivery_failed',
          userId: event.userId,
          eventId: event.id,
          reason: 'invalid_payload',
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private extractToken(req: IncomingMessage): string | null {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      return url.searchParams.get('token');
    } catch {
      return null;
    }
  }

  private extractCursor(req: IncomingMessage): number | null {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const raw = url.searchParams.get('cursor');
      if (raw === null) return null;
      const parsed = Number.parseInt(raw, 10);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  private verifyToken(token: string): string | null {
    try {
      const payload = this.jwt.verify<{ sub: string }>(token, {
        secret: this.config.getOrThrow<string>('jwt.accessSecret'),
      });
      return payload.sub ?? null;
    } catch {
      return null;
    }
  }

  private broadcast(set: Set<WebSocket>, message: StreamServerMessage): void {
    for (const client of set) this.send(client, message);
  }

  private send(client: WebSocket, message: StreamServerMessage): boolean {
    if (client.readyState !== WebSocket.OPEN) return false;
    try {
      client.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'websocket_send_failed',
          messageType: message.type,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return false;
    }
  }
}

function isIvAlert(value: unknown): value is IVAlert {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<IVAlert>;
  return (
    (candidate.symbol === 'SPX' || candidate.symbol === 'NDX' || candidate.symbol === 'RUT') &&
    (candidate.direction === 'expansion' || candidate.direction === 'crush') &&
    typeof candidate.timestamp === 'string' &&
    Number.isFinite(Date.parse(candidate.timestamp)) &&
    typeof candidate.currentIv === 'number' &&
    Number.isFinite(candidate.currentIv) &&
    typeof candidate.baselineIv === 'number' &&
    Number.isFinite(candidate.baselineIv) &&
    typeof candidate.zScore === 'number' &&
    Number.isFinite(candidate.zScore)
  );
}

function isIvAlertConfigurationState(value: unknown): value is IVAlertConfigurationState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<IVAlertConfigurationState>;
  const symbols = candidate.symbols;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.updatedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.updatedAt)) &&
    typeof candidate.enabled === 'boolean' &&
    Array.isArray(symbols) &&
    symbols.length >= 1 &&
    symbols.length <= 3 &&
    new Set(symbols).size === symbols.length &&
    symbols.every((symbol) => symbol === 'SPX' || symbol === 'NDX' || symbol === 'RUT') &&
    isBoundedInteger(candidate.lookbackMinutes, 5, 240) &&
    isBoundedNumber(candidate.thresholdK, 0.1, 20) &&
    isBoundedInteger(candidate.consecutiveBreaches, 1, 10) &&
    isBoundedInteger(candidate.warmupMinutes, 0, 60) &&
    isBoundedInteger(candidate.warmupSamples, 1, 240) &&
    isBoundedInteger(candidate.cooldownMinutes, 0, 1_440)
  );
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isBoundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}
