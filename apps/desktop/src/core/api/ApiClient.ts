import type {
  AuthTokens,
  Candle,
  CandleInterval,
  FuturesContract,
  Me,
  OptionsChain,
  OrderPreview,
  OrderRequest,
  OrderResult,
  Position,
  Quote,
  TradeHistory,
  WebullCredentialsInput,
} from '@0dtetrader/shared-types';
import { ApiError, parseErrorEnvelope } from './ApiError';
import type { SessionStore } from './SessionStore';

interface Endpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  requiresAuth?: boolean;
  body?: unknown;
}

/**
 * Typed REST client (APIClient.swift analog):
 * attaches the Bearer token, refreshes once on 401 and retries once, and
 * maps non-2xx responses through the `{error:{code,message}}` envelope.
 */
export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly sessionStore: SessionStore,
  ) {}

  private async perform(endpoint: Endpoint, allowRetry: boolean): Promise<Response> {
    const url = new URL(`${this.baseUrl}/${endpoint.path}`);
    for (const [name, value] of Object.entries(endpoint.query ?? {})) {
      url.searchParams.set(name, value);
    }
    const requiresAuth = endpoint.requiresAuth !== false;
    const headers: Record<string, string> = { ...endpoint.headers };
    if (requiresAuth) {
      const token = this.sessionStore.currentAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (endpoint.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(url, {
        method: endpoint.method,
        headers,
        body: endpoint.body !== undefined ? JSON.stringify(endpoint.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ApiError({
        kind: 'network',
        underlying: error instanceof Error ? error.message : String(error),
      });
    }

    if (response.status === 401 && requiresAuth && allowRetry) {
      // Refresh throws `unauthorized` when the session is unrecoverable.
      await this.sessionStore.refreshAccessToken();
      return this.perform(endpoint, false);
    }

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const envelope = parseErrorEnvelope(body);
      if (envelope) {
        throw new ApiError({
          kind: 'server',
          code: envelope.code,
          message: envelope.message,
          status: response.status,
        });
      }
      throw new ApiError({ kind: 'httpStatus', status: response.status });
    }
    return response;
  }

  private async request<T>(endpoint: Endpoint): Promise<T> {
    const response = await this.perform(endpoint, true);
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError({ kind: 'decoding' });
    }
  }

  private async requestVoid(endpoint: Endpoint): Promise<void> {
    await this.perform(endpoint, true);
  }

  // MARK: - Typed endpoints (docs/API-SPEC.md)

  register(email: string, password: string): Promise<AuthTokens> {
    return this.request({
      method: 'POST',
      path: 'v1/auth/register',
      requiresAuth: false,
      body: { email, password },
    });
  }

  login(email: string, password: string): Promise<AuthTokens> {
    return this.request({
      method: 'POST',
      path: 'v1/auth/login',
      requiresAuth: false,
      body: { email, password },
    });
  }

  me(): Promise<Me> {
    return this.request({ method: 'GET', path: 'v1/me' });
  }

  putWebullCredentials(credentials: WebullCredentialsInput): Promise<{ webullConfigured: true }> {
    return this.request({ method: 'PUT', path: 'v1/me/webull-credentials', body: credentials });
  }

  deleteWebullCredentials(): Promise<void> {
    return this.requestVoid({ method: 'DELETE', path: 'v1/me/webull-credentials' });
  }

  quote(symbol: string): Promise<Quote> {
    return this.request({ method: 'GET', path: 'v1/market/quote', query: { symbol } });
  }

  candles(symbol: string, interval: CandleInterval, from?: Date, to?: Date): Promise<Candle[]> {
    const query: Record<string, string> = { symbol, interval };
    if (from) query.from = from.toISOString();
    if (to) query.to = to.toISOString();
    return this.request({ method: 'GET', path: 'v1/market/candles', query });
  }

  optionsChain(symbol: string, expiration?: string): Promise<OptionsChain> {
    const query: Record<string, string> = { symbol };
    if (expiration) query.expiration = expiration;
    return this.request({ method: 'GET', path: 'v1/market/options-chain', query });
  }

  futures(root: string): Promise<FuturesContract[]> {
    return this.request({ method: 'GET', path: 'v1/market/futures', query: { root } });
  }

  previewOrder(order: OrderRequest): Promise<OrderPreview> {
    return this.request({ method: 'POST', path: 'v1/orders/preview', body: order });
  }

  placeOrder(order: OrderRequest, idempotencyKey: string): Promise<OrderResult> {
    return this.request({
      method: 'POST',
      path: 'v1/orders',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: order,
    });
  }

  openOrders(): Promise<OrderResult[]> {
    return this.request({ method: 'GET', path: 'v1/orders' });
  }

  cancelOrder(orderId: string): Promise<void> {
    return this.requestVoid({ method: 'DELETE', path: `v1/orders/${orderId}` });
  }

  positions(): Promise<Position[]> {
    return this.request({ method: 'GET', path: 'v1/positions' });
  }

  orderHistory(): Promise<TradeHistory> {
    return this.request({ method: 'GET', path: 'v1/orders/history' });
  }
}
