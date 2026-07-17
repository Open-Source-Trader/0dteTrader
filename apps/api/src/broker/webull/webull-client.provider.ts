import { Injectable } from '@nestjs/common';
import { WebullCredentialsInput } from '@0dtetrader/shared-types';
import { BrokerError, brokerErrors } from '../../common/broker-error';
import { CredentialsService } from '../../credentials/credentials.service';
import { WebullHttpClient, WebullRequestOptions } from './webull-http.client';
import {
  WebullBar,
  WebullFuturesInstrument,
  WebullOrder,
  WebullPosition,
  WebullSnapshot,
} from './webull-mappers';
import { TtlCache } from './webull-cache';
import { WebullTokenStore } from './webull-token.store';

/** Option snapshot queries accept at most 20 OCC symbols (60 req/min). */
const OPTION_SNAPSHOT_BATCH = 20;
/** Stock/futures snapshot queries accept up to 100 symbols. */
const SNAPSHOT_BATCH = 100;

const QUOTE_CACHE_MS = 1_000; // survives the 1s polling in stream.gateway
const INSTRUMENT_CACHE_MS = 5 * 60_000;

/** Tolerant unwrap — Webull list responses are either bare arrays or wrapped. */
function asArray<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === 'object') {
    for (const value of Object.values(res)) {
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
}

function asObject<T>(res: unknown): T {
  if (Array.isArray(res)) return (res[0] ?? {}) as T;
  return (res ?? {}) as T;
}

/**
 * Per-user Webull OpenAPI facade (docs/WEBULL-INTEGRATION.md §3): resolves
 * decrypted credentials + API token, retries once on token invalidation, and
 * micro-caches hot market data to stay inside Webull's rate limits.
 */
@Injectable()
export class WebullClientProvider {
  private readonly snapshotCache = new TtlCache<WebullSnapshot>();
  private readonly instrumentCache = new TtlCache<WebullFuturesInstrument[]>();

  constructor(
    private readonly http: WebullHttpClient,
    private readonly tokens: WebullTokenStore,
    private readonly credentials: CredentialsService,
  ) {}

  async accountId(userId: string): Promise<string> {
    return (await this.creds(userId)).accountId;
  }

  // -------------------------------------------------------------------------
  // Market data
  // -------------------------------------------------------------------------

  async getStockSnapshots(
    userId: string,
    symbols: string[],
  ): Promise<WebullSnapshot[]> {
    return this.snapshots(userId, symbols, 'US_STOCK', '/openapi/market-data/stock/snapshot', SNAPSHOT_BATCH);
  }

  async getOptionSnapshots(
    userId: string,
    occSymbols: string[],
  ): Promise<WebullSnapshot[]> {
    return this.snapshots(userId, occSymbols, 'US_OPTION', '/openapi/market-data/option/snapshot', OPTION_SNAPSHOT_BATCH);
  }

  async getFuturesSnapshots(
    userId: string,
    symbols: string[],
  ): Promise<WebullSnapshot[]> {
    return this.snapshots(userId, symbols, 'US_FUTURES', '/openapi/market-data/futures/snapshot', SNAPSHOT_BATCH);
  }

  async getBars(
    userId: string,
    symbol: string,
    category: 'US_STOCK' | 'US_OPTION' | 'US_FUTURES',
    timespan: string,
    count: number,
    startTime?: number,
    endTime?: number,
  ): Promise<WebullBar[]> {
    const path =
      category === 'US_OPTION'
        ? '/openapi/market-data/option/bars'
        : category === 'US_FUTURES'
          ? '/openapi/market-data/futures/bars'
          : '/openapi/market-data/stock/bars';
    const res = await this.call(userId, {
      method: 'GET',
      path,
      hostKind: 'marketData',
      query: {
        symbol,
        category,
        timespan,
        count,
        start_time: startTime,
        end_time: endTime,
      },
    });
    return asArray<WebullBar>(res);
  }

  async getFuturesInstruments(
    userId: string,
    root: string,
  ): Promise<WebullFuturesInstrument[]> {
    const key = root.toUpperCase();
    const cached = this.instrumentCache.get(key);
    if (cached) return cached;
    const res = await this.call(userId, {
      method: 'GET',
      path: '/openapi/instrument/futures/list',
      query: { category: 'US_FUTURES', code: key },
    });
    const instruments = asArray<WebullFuturesInstrument>(res);
    this.instrumentCache.set(key, instruments, INSTRUMENT_CACHE_MS);
    return instruments;
  }

  // -------------------------------------------------------------------------
  // Account & trading
  // -------------------------------------------------------------------------

  async getBalance(userId: string): Promise<Record<string, unknown>> {
    const accountId = await this.accountId(userId);
    const res = await this.call(userId, {
      method: 'GET',
      path: '/openapi/assets/balance',
      query: { account_id: accountId },
    });
    return asObject(res);
  }

  async getPositions(userId: string): Promise<WebullPosition[]> {
    const accountId = await this.accountId(userId);
    const res = await this.call(userId, {
      method: 'GET',
      path: '/openapi/assets/positions',
      query: { account_id: accountId },
    });
    return asArray<WebullPosition>(res);
  }

  async previewOrder(
    userId: string,
    newOrder: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const accountId = await this.accountId(userId);
    const res = await this.call(userId, {
      method: 'POST',
      path: '/openapi/trade/order/preview',
      body: { account_id: accountId, new_orders: [newOrder] },
    });
    return asObject(res);
  }

  async placeOrder(
    userId: string,
    newOrder: Record<string, unknown>,
  ): Promise<WebullOrder> {
    const accountId = await this.accountId(userId);
    const res = await this.call(userId, {
      method: 'POST',
      path: '/openapi/trade/order/place',
      body: { account_id: accountId, new_orders: [newOrder] },
    });
    return asObject<WebullOrder>(res);
  }

  async cancelOrder(userId: string, clientOrderId: string): Promise<void> {
    const accountId = await this.accountId(userId);
    await this.call(userId, {
      method: 'POST',
      path: '/openapi/trade/order/cancel',
      body: { account_id: accountId, client_order_id: clientOrderId },
    });
  }

  async getOpenOrders(userId: string): Promise<WebullOrder[]> {
    const accountId = await this.accountId(userId);
    const orders: WebullOrder[] = [];
    let lastClientOrderId: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await this.call(userId, {
        method: 'GET',
        path: '/openapi/trade/order/open',
        query: {
          account_id: accountId,
          page_size: 100,
          last_client_order_id: lastClientOrderId,
        },
      });
      const batch = asArray<WebullOrder>(res);
      orders.push(...batch);
      if (batch.length < 100) break;
      lastClientOrderId = batch[batch.length - 1]?.client_order_id;
      if (!lastClientOrderId) break;
    }
    return orders;
  }

  async getOrderDetail(
    userId: string,
    clientOrderId: string,
  ): Promise<WebullOrder> {
    const accountId = await this.accountId(userId);
    const res = await this.call(userId, {
      method: 'GET',
      path: '/openapi/trade/order/detail',
      query: { account_id: accountId, client_order_id: clientOrderId },
    });
    return asObject<WebullOrder>(res);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async creds(userId: string): Promise<WebullCredentialsInput> {
    const creds = await this.credentials.getDecrypted(userId);
    if (!creds) {
      throw brokerErrors.authFailed(
        'Webull credentials not configured — set them via PUT /me/webull-credentials',
      );
    }
    return creds;
  }

  /**
   * Signs and sends one call; on an auth failure the cached token is dropped
   * and the call retried once with a fresh token.
   */
  private async call(
    userId: string,
    opts: Omit<WebullRequestOptions, 'appKey' | 'appSecret' | 'accessToken'>,
  ): Promise<unknown> {
    const creds = await this.creds(userId);
    const send = async (): Promise<unknown> =>
      this.http.request({
        ...opts,
        appKey: creds.appKey,
        appSecret: creds.appSecret,
        accessToken: await this.tokens.getToken(userId, creds),
      });
    try {
      return await send();
    } catch (err) {
      if (err instanceof BrokerError && err.code === 'BROKER_AUTH_FAILED') {
        await this.tokens.invalidate(userId);
        return send();
      }
      throw err;
    }
  }

  private async snapshots(
    userId: string,
    symbols: string[],
    category: string,
    path: string,
    batchSize: number,
  ): Promise<WebullSnapshot[]> {
    const bySymbol = new Map<string, WebullSnapshot>();
    const missing: string[] = [];
    for (const symbol of symbols) {
      const cached = this.snapshotCache.get(`${category}:${symbol}`);
      if (cached) bySymbol.set(symbol, cached);
      else missing.push(symbol);
    }
    for (let i = 0; i < missing.length; i += batchSize) {
      const batch = missing.slice(i, i + batchSize);
      const res = await this.call(userId, {
        method: 'GET',
        path,
        hostKind: 'marketData',
        query: { symbols: batch.join(','), category },
      });
      for (const snap of asArray<WebullSnapshot>(res)) {
        if (!snap.symbol) continue;
        this.snapshotCache.set(`${category}:${snap.symbol}`, snap, QUOTE_CACHE_MS);
        bySymbol.set(snap.symbol, snap);
      }
    }
    return symbols
      .map((s) => bySymbol.get(s))
      .filter((s): s is WebullSnapshot => s !== undefined);
  }
}
