import { Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { StreamServerMessage } from '@0dtetrader/shared-types';
import { BROKER_GATEWAY, BrokerGateway } from '../broker/broker-gateway.interface';
import { OrderEventsService, OrderUpdateEvent } from '../broker/order-events.service';
import { Subscription } from 'rxjs';
import { CryptoDataService } from './crypto-data.service';
import { IndexDataService } from './index-data.service';

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
  private readonly orderEventsSub: Subscription;

  constructor(
    @Inject(BROKER_GATEWAY) private readonly broker: BrokerGateway,
    private readonly crypto: CryptoDataService,
    private readonly index: IndexDataService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    orderEvents: OrderEventsService,
  ) {
    this.orderEventsSub = orderEvents.events$.subscribe((event) => this.pushOrderUpdate(event));
  }

  onModuleDestroy(): void {
    this.orderEventsSub.unsubscribe();
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
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

    this.clients.set(client, { userId, symbols: new Set() });
    client.on('message', (raw) => this.handleMessage(client, raw));
    client.on('close', () => this.handleDisconnect(client));
    client.on('error', () => this.handleDisconnect(client));
  }

  handleDisconnect(client: WebSocket): void {
    const state = this.clients.get(client);
    if (!state) return;
    for (const symbol of state.symbols) {
      this.removeSubscriber(symbol, client);
    }
    this.clients.delete(client);
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  private handleMessage(client: WebSocket, raw: unknown): void {
    let msg: { type?: string; symbols?: unknown };
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

    if (msg.type === 'subscribe') {
      for (const symbol of symbols) this.addSubscriber(symbol, client, state);
    } else if (msg.type === 'unsubscribe') {
      for (const symbol of symbols) this.removeSubscriber(symbol, client, state);
    } else {
      this.send(client, {
        type: 'error',
        error: {
          code: 'BAD_MESSAGE',
          message: 'type must be "subscribe" or "unsubscribe"',
        },
      });
    }
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

      // Index quotes (Tradier) are likewise user-independent.
      if (this.index.isIndexSymbol(symbol)) {
        try {
          this.broadcast(set, { type: 'quote', data: await this.index.getQuote(symbol) });
          this.tickWarnings.delete(symbol);
        } catch (err) {
          this.warnTickOnce(symbol, `quote tick failed for ${symbol}: ${(err as Error).message}`);
        }
        return;
      }

      // Broker quotes are fetched per user: gateways use per-user credentials,
      // so one subscriber's quote must never be served under another's account.
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
          const quote = await this.broker.getQuote(userId, symbol);
          for (const client of clients) this.send(client, { type: 'quote', data: quote });
          this.tickWarnings.delete(key);
        } catch (err) {
          this.warnTickOnce(
            key,
            `quote tick failed for ${symbol} (user ${userId}): ${(err as Error).message}`,
          );
        }
      }
    } finally {
      this.inFlightTicks.delete(symbol);
    }
  }

  /** Logs a quote-tick warning only when it differs from the last one logged
   *  for the same key — a persistent failure logs once, not every second. */
  private warnTickOnce(key: string, message: string): void {
    if (this.tickWarnings.get(key) === message) return;
    this.tickWarnings.set(key, message);
    this.logger.warn(message);
  }

  private pushOrderUpdate(event: OrderUpdateEvent): void {
    for (const [client, state] of this.clients) {
      if (state.userId === event.userId) {
        this.send(client, { type: 'orderUpdate', data: event.order });
      }
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

  private send(client: WebSocket, message: StreamServerMessage): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }
}
