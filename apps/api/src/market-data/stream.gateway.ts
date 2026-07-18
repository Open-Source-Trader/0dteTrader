import {
  Inject,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { StreamServerMessage } from '@0dtetrader/shared-types';
import {
  BROKER_GATEWAY,
  BrokerGateway,
} from '../broker/broker-gateway.interface';
import {
  OrderEventsService,
  OrderUpdateEvent,
} from '../broker/order-events.service';
import { Subscription } from 'rxjs';
import { CryptoDataService } from './crypto-data.service';

const QUOTE_TICK_MS = 1000;

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
export class StreamGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(StreamGateway.name);
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly subscribers = new Map<string, Set<WebSocket>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly orderEventsSub: Subscription;

  constructor(
    @Inject(BROKER_GATEWAY) private readonly broker: BrokerGateway,
    private readonly crypto: CryptoDataService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    orderEvents: OrderEventsService,
  ) {
    this.orderEventsSub = orderEvents.events$.subscribe((event) =>
      this.pushOrderUpdate(event),
    );
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
      ? msg.symbols.filter((s): s is string => typeof s === 'string')
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

  private addSubscriber(
    symbol: string,
    client: WebSocket,
    state: ClientState,
  ): void {
    if (state.symbols.has(symbol)) return;
    state.symbols.add(symbol);
    let set = this.subscribers.get(symbol);
    if (!set) {
      set = new Set();
      this.subscribers.set(symbol, set);
    }
    set.add(client);
    if (!this.timers.has(symbol)) {
      this.timers.set(
        symbol,
        setInterval(() => void this.tickSymbol(symbol), QUOTE_TICK_MS),
      );
      // Emit an immediate first tick so subscribers do not wait a full second.
      void this.tickSymbol(symbol);
    }
  }

  private removeSubscriber(
    symbol: string,
    client: WebSocket,
    state?: ClientState,
  ): void {
    state?.symbols.delete(symbol);
    const set = this.subscribers.get(symbol);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) {
      this.subscribers.delete(symbol);
      const timer = this.timers.get(symbol);
      if (timer) clearInterval(timer);
      this.timers.delete(symbol);
    }
  }

  private async tickSymbol(symbol: string): Promise<void> {
    const set = this.subscribers.get(symbol);
    if (!set || set.size === 0) return;
    const anyClient = set.values().next().value as WebSocket;
    const state = this.clients.get(anyClient);
    if (!state) return;
    try {
      const quote = this.crypto.isCryptoSymbol(symbol)
        ? await this.crypto.getQuote(symbol)
        : await this.broker.getQuote(state.userId, symbol);
      this.broadcast(set, { type: 'quote', data: quote });
    } catch (err) {
      this.logger.warn(`quote tick failed for ${symbol}: ${(err as Error).message}`);
    }
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
