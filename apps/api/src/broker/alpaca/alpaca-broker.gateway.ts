import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Candle,
  CandleInterval,
  CandleRequest,
  OptionsChain,
  OrderPreview,
  OrderRequest,
  OrderResult,
  Position,
  Quote,
  TradingMode,
} from '@0dtetrader/shared-types';
import { brokerErrors } from '../../common/broker-error';
import { AGGREGATION_PLANS, aggregateCandles } from '../../market-data/candle-aggregation';
import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  computeMid,
  estimateBuyingPower,
  parseOccSymbol,
  resolveAutoOtm,
} from '../contract-resolution';
import { BrokerGateway } from '../broker-gateway.interface';
import { optionExpirations } from '../expiration-calendar';
import { OrderEventsService } from '../order-events.service';
import {
  alpacaClientOrderId,
  AlpacaHosts,
  ALPACA_LIVE_HOSTS,
  ALPACA_PAPER_HOSTS,
  asArray,
  asObject,
  buildOptionOrder,
  EndpointKey,
  ResolvedOptionTerms,
  TIMEFRAME,
} from './alpaca-endpoints';
import { AlpacaClient, AlpacaSecrets, FetchImpl } from './alpaca-client';
import {
  AlpacaSnapshot,
  toCandle,
  toOptionContract,
  toOrderResult,
  toPosition,
  toQuote,
} from './alpaca-mappers';

/**
 * Alpaca v2 gateway. Alpaca is simpler than Webull: HTTP Basic auth (no HMAC
 * signer), no token lifecycle / SMS-2FA, no account-id discovery (orders and
 * positions are scoped to the API key's account), and a real options-chain
 * endpoint that replaces Webull's strike-grid probe.
 *
 * - Per-user AlpacaClient built from decrypted (apiKey, apiSecret) for the
 *   user's current trading mode (live → api.alpaca.markets, practice →
 *   paper-api.alpaca.markets); clients are cached per (user, mode) and
 *   rebuilt when credentials change.
 * - `reauthenticate` is a no-op: Alpaca keys are long-lived, so there is
 *   nothing to refresh.
 * - Order idempotency mirrors Webull exactly: client_order_id = md5(userId +
 *   idempotency key), and cancel operates on that id.
 */
@Injectable()
export class AlpacaBrokerGateway implements BrokerGateway, OnModuleDestroy {
  private readonly logger = new Logger(AlpacaBrokerGateway.name);
  private readonly clients = new Map<string, { fingerprint: string; client: AlpacaClient }>();
  private readonly pollTimers = new Map<string, NodeJS.Timeout>();
  /** Timespans the live API rejected or returned empty (native-first fallback
   *  memo for 30m/4h — see getCandles). */
  private readonly unsupportedTimespans = new Set<CandleInterval>();

  constructor(
    private readonly credentials: CredentialsService,
    private readonly config: ConfigService,
    private readonly events: OrderEventsService,
    private readonly prisma: PrismaService,
    private readonly fetchImpl?: FetchImpl,
  ) {}

  onModuleDestroy(): void {
    for (const timer of this.pollTimers.values()) clearTimeout(timer);
    this.pollTimers.clear();
  }

  /**
   * No-op for Alpaca: keys are long-lived and never expire, so there is no
   * token to refresh. Returns the user's current trading mode for parity with
   * the Webull reauthenticate contract (the app's Reconnect flow still works).
   */
  async reauthenticate(userId: string): Promise<TradingMode> {
    const mode = await this.tradingModeFor(userId);
    this.logger.log(`Alpaca reauthenticate (no-op) for ${userId} mode ${mode}`);
    return mode;
  }

  // -------------------------------------------------------------------------
  // Client factory (per-user, per-environment, credentials-aware)
  // -------------------------------------------------------------------------

  private async tradingModeFor(userId: string): Promise<TradingMode> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return user?.tradingMode === 'practice' ? 'practice' : 'live';
  }

  private async credentialsFor(userId: string, mode: TradingMode): Promise<AlpacaSecrets> {
    const stored = await this.credentials.getDecrypted(userId, 'alpaca', mode);
    if (!stored) {
      throw brokerErrors.authFailed(
        mode === 'practice'
          ? 'No Alpaca practice credentials — save your API key/secret in Profile first'
          : 'No Alpaca credentials — save your API key/secret in Profile first',
      );
    }
    if (stored.provider !== 'alpaca') {
      throw brokerErrors.authFailed('Stored credentials are not Alpaca credentials');
    }
    return stored as AlpacaSecrets;
  }

  private async clientFor(userId: string): Promise<AlpacaClient> {
    const mode = await this.tradingModeFor(userId);
    const secrets = await this.credentialsFor(userId, mode);
    const fingerprint = `${secrets.apiKey}:${secrets.apiSecret}`;
    const cacheKey = `${userId}:${mode}`;
    const existing = this.clients.get(cacheKey);
    if (existing && existing.fingerprint === fingerprint) {
      return existing.client;
    }
    const client = new AlpacaClient(secrets, {
      hosts: this.hosts(mode),
      fetchImpl: this.fetchImpl,
    });
    this.clients.set(cacheKey, { fingerprint, client });
    return client;
  }

  private hosts(mode: TradingMode): AlpacaHosts {
    if (mode === 'live') {
      const trading = this.config.get<string>('alpaca.tradingBaseUrl') || ALPACA_LIVE_HOSTS.trading;
      const data = this.config.get<string>('alpaca.dataBaseUrl') || ALPACA_LIVE_HOSTS.data;
      return { trading, data };
    }
    const trading =
      this.config.get<string>('alpaca.paperTradingBaseUrl') || ALPACA_PAPER_HOSTS.trading;
    const data = this.config.get<string>('alpaca.paperDataBaseUrl') || ALPACA_PAPER_HOSTS.data;
    return { trading, data };
  }

  // -------------------------------------------------------------------------
  // Market data
  // -------------------------------------------------------------------------

  async getQuote(userId: string, symbol: string): Promise<Quote> {
    const client = await this.clientFor(userId);
    const occ = parseOccSymbol(symbol);
    const key: EndpointKey = occ ? 'optionSnapshots' : 'stockSnapshots';
    const raw = await client.request(key, { query: { symbols: symbol } });
    // Stocks snapshots are keyed by symbol at the top level; options snapshots
    // (Alpaca v1beta1) are nested under a `snapshots` wrapper. Tolerate both.
    const obj = asObject(raw) as Record<string, unknown>;
    const snapMap = (obj.snapshots as Record<string, unknown> | undefined) ?? obj;
    const snap = snapMap[symbol] as AlpacaSnapshot | undefined;
    if (!snap) {
      throw brokerErrors.contractNotFound(
        occ ? `Unknown option: ${symbol}` : `Unknown symbol: ${symbol}`,
      );
    }
    return toQuote(symbol, snap);
  }

  async getCandles(userId: string, symbol: string, req: CandleRequest): Promise<Candle[]> {
    const client = await this.clientFor(userId);
    const occ = parseOccSymbol(symbol);
    const endpoint: EndpointKey = occ ? 'optionBars' : 'stockBars';

    const fetchBars = async (timeframe: string, count: number): Promise<Candle[]> => {
      const query: Record<string, string> = {
        timeframe,
        limit: String(count),
      };
      if (req.from) query.start = new Date(req.from).toISOString();
      if (req.to) query.end = new Date(req.to).toISOString();
      const buildOpts = (q: Record<string, string>) =>
        occ ? { query: { ...q, symbols: symbol } } : { query: q, pathParams: { symbol } };
      const requestOpts = buildOpts(query);
      const barsOf = (r: unknown): unknown => (occ ? optionBarsForSymbol(r, symbol) : r);
      let raw = await client.request(endpoint, requestOpts);
      // A window covering no session returns []; fall back to the latest bars.
      if (asArray(barsOf(raw)).length === 0 && (req.from || req.to)) {
        delete query.start;
        delete query.end;
        raw = await client.request(endpoint, buildOpts(query));
      }
      // Alpaca returns bars newest-first; chart clients require ascending.
      return asArray(barsOf(raw))
        .map((b) => toCandle(b as never))
        .sort((a, b) => a.time.localeCompare(b.time));
    };

    const fetchAggregated = async (
      source: Exclude<CandleInterval, '1w'>,
      count: number,
      target: CandleInterval,
    ): Promise<Candle[]> => {
      let bars: Candle[];
      try {
        bars = await fetchBars(TIMEFRAME[source], count);
      } catch (err) {
        if (count <= 200) throw err;
        this.logger.warn(
          `bars count=${count} rejected for ${symbol} ${source} — retrying with 200: ${(err as Error).message}`,
        );
        bars = await fetchBars(TIMEFRAME[source], 200);
      }
      return aggregateCandles(bars, target);
    };

    if (req.interval === '1w') {
      return fetchAggregated('1d', 600, '1w');
    }
    const plan = AGGREGATION_PLANS[req.interval];
    const planSource = plan?.source as Exclude<CandleInterval, '1w'> | undefined;
    if (!plan || !planSource) {
      return fetchBars(TIMEFRAME[req.interval], 200);
    }
    if (!this.unsupportedTimespans.has(req.interval)) {
      try {
        const native = await fetchBars(TIMEFRAME[req.interval], 200);
        if (native.length > 0) return native;
      } catch (err) {
        this.logger.warn(
          `native timeframe ${TIMEFRAME[req.interval]} failed for ${symbol} — aggregating from ${planSource}: ${(err as Error).message}`,
        );
      }
      this.unsupportedTimespans.add(req.interval);
    }
    return fetchAggregated(planSource, 200 * plan.factor, req.interval);
  }

  async getOptionsChain(
    userId: string,
    symbol: string,
    expiration?: string,
  ): Promise<OptionsChain> {
    const client = await this.clientFor(userId);
    const expirations = optionExpirations(symbol, new Date());
    const chosen = expiration ?? expirations[0];
    if (!expirations.includes(chosen)) {
      throw brokerErrors.contractNotFound(
        `No chain for expiration ${chosen}. Available: ${expirations.join(', ')}`,
      );
    }
    const raw = await client.request('optionChain', {
      query: { symbol, expiration_date: chosen },
    });
    const options = asArray(asObject(raw).options);
    const underlyingQuote = await this.getQuote(userId, symbol);
    const contracts = options
      .map((o) => toOptionContract(o as never, symbol, chosen))
      .filter((c) => c.symbol.length > 0);
    return {
      underlying: symbol.toUpperCase(),
      underlyingPrice: underlyingQuote.last,
      expirations,
      contracts,
    };
  }

  // -------------------------------------------------------------------------
  // Trading
  // -------------------------------------------------------------------------

  async previewOrder(userId: string, order: OrderRequest): Promise<OrderPreview> {
    const resolved = await this.resolveContract(userId, order);
    const price =
      order.orderType === 'market' ? resolved.last : computeMid(resolved.bid, resolved.ask);

    const warnings: string[] = [];
    if (resolved.optionTerms && resolved.optionTerms.expiration === tradingDay()) {
      warnings.push('0DTE contract — expires today');
    }
    if (order.assetClass === 'option' && order.orderType === 'market') {
      warnings.push('Market order on an option contract — fills at last price');
    }

    // Alpaca v2 has no preview endpoint that returns a buying-power effect;
    // fall back to a local estimate (mirrors Webull's local-estimate path).
    const estBuyingPower = estimateBuyingPower(order.quantity, price);

    return {
      resolved: {
        contractSymbol: resolved.contractSymbol,
        price,
        estBuyingPower: Math.round(estBuyingPower * 100) / 100,
      },
      warnings,
    };
  }

  async placeOrder(
    userId: string,
    order: OrderRequest,
    idempotencyKey: string,
  ): Promise<OrderResult> {
    const client = await this.clientFor(userId);
    const resolved = await this.resolveContract(userId, order);
    const limitPrice =
      order.orderType === 'market' ? undefined : computeMid(resolved.bid, resolved.ask);

    const clientOrderId = alpacaClientOrderId(userId, idempotencyKey);
    const newOrder = this.buildNewOrder(order, resolved, clientOrderId, limitPrice);
    const raw = await client.request('orders', {
      body: newOrder as unknown as Record<string, unknown>,
    });
    const placed = asObject(raw);

    const result: OrderResult = {
      // Cancel/replace operate on client_order_id, so that is our order id.
      orderId: (placed.client_order_id as string) ?? clientOrderId,
      status: 'submitted',
      contractSymbol: resolved.contractSymbol,
      side: order.side,
      quantity: order.quantity,
      orderType: order.orderType,
      limitPrice,
      timestamp: new Date().toISOString(),
    };
    this.events.emit(userId, result);
    this.startStatusPoll(userId, client, result);
    return result;
  }

  async cancelOrder(userId: string, orderId: string): Promise<void> {
    const client = await this.clientFor(userId);
    const open = await this.getOpenOrders(userId);
    const target = open.find((o) => o.orderId === orderId);
    if (!target) throw brokerErrors.orderNotFound(orderId);
    await client.request('orderCancelClient', { pathParams: { clientId: orderId } });
    this.stopStatusPoll(userId, orderId);
    this.events.emit(userId, { ...target, status: 'cancelled' });
  }

  async getPositions(userId: string): Promise<Position[]> {
    const client = await this.clientFor(userId);
    const raw = await client.request('positions');
    return asArray(raw)
      .map((p) => toPosition(p as never))
      .filter((p): p is Position => p !== null);
  }

  async getOpenOrders(userId: string): Promise<OrderResult[]> {
    const client = await this.clientFor(userId);
    const raw = await client.request('ordersOpen', { query: { status: 'open', limit: '100' } });
    return asArray(raw)
      .map((o) => toOrderResult(o as never))
      .filter((o) => o.status === 'submitted' || o.status === 'partially_filled');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildNewOrder(
    order: OrderRequest,
    resolved: ResolvedContract,
    clientOrderId: string,
    limitPrice?: number,
  ) {
    if (!resolved.optionTerms) {
      throw brokerErrors.orderRejected('Option contract terms were not resolved');
    }
    return buildOptionOrder(order, resolved.optionTerms, clientOrderId, limitPrice);
  }

  private async resolveContract(userId: string, order: OrderRequest): Promise<ResolvedContract> {
    const { optionType } = order.selection;
    if (!optionType) {
      throw brokerErrors.orderRejected('selection.optionType is required for option orders');
    }
    const chain = await this.getOptionsChain(userId, order.underlying, order.selection.expiration);
    const contract =
      order.selection.mode === 'auto_otm'
        ? resolveAutoOtm(chain.contracts, optionType, chain.underlyingPrice)
        : chain.contracts.find(
            (c) => c.optionType === optionType && c.strike === order.selection.strike,
          );
    if (!contract) {
      throw brokerErrors.contractNotFound(
        `No ${optionType} contract at strike ${order.selection.strike ?? '(auto)'} ` +
          `for ${order.underlying} ${chain.expirations[0]}`,
      );
    }
    return {
      contractSymbol: contract.symbol,
      bid: contract.bid,
      ask: contract.ask,
      last: contract.last,
      optionTerms: {
        underlying: order.underlying.toUpperCase(),
        expiration: contract.expiration,
        strike: contract.strike,
        optionType,
      },
    };
  }

  private startStatusPoll(userId: string, client: AlpacaClient, result: OrderResult): void {
    const key = `${userId}:${result.orderId}`;
    let attempts = 0;
    const tick = async (): Promise<void> => {
      this.pollTimers.delete(key);
      attempts += 1;
      try {
        const raw = await client.request('orderById', { pathParams: { id: result.orderId } });
        const detail = toOrderResult(raw as never);
        if (
          detail.status === 'filled' ||
          detail.status === 'cancelled' ||
          detail.status === 'rejected'
        ) {
          this.events.emit(userId, {
            ...result,
            status: detail.status,
            filledPrice: detail.filledPrice ?? result.filledPrice,
          });
          return;
        }
      } catch (err) {
        this.logger.debug(`status poll for ${result.orderId} failed: ${(err as Error).message}`);
      }
      if (attempts < STATUS_POLL_MAX_ATTEMPTS) {
        this.schedulePoll(key, tick);
      }
    };
    this.schedulePoll(key, tick);
  }

  private schedulePoll(key: string, tick: () => Promise<void>): void {
    const timer = setTimeout(() => void tick(), STATUS_POLL_INTERVAL_MS);
    timer.unref?.();
    this.pollTimers.set(key, timer);
  }

  private stopStatusPoll(userId: string, orderId: string): void {
    const key = `${userId}:${orderId}`;
    const timer = this.pollTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.pollTimers.delete(key);
    }
  }
}

interface ResolvedContract {
  contractSymbol: string;
  bid: number;
  ask: number;
  last: number;
  optionTerms?: ResolvedOptionTerms;
}

/**
 * Extract the bar array for one symbol from an Alpaca v1beta1 options-bars
 * response, which is `{ bars: { SYMBOL: [...] } }` (object keyed by symbol),
 * not a bare array like the stocks endpoint.
 */
function optionBarsForSymbol(raw: unknown, symbol: string): unknown {
  const bars = (asObject(raw).bars as Record<string, unknown> | undefined) ?? {};
  return bars[symbol] ?? [];
}

/** Today's date in the US options market timezone (0DTE warnings). */
function tradingDay(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const STATUS_POLL_INTERVAL_MS = 1_000;
const STATUS_POLL_MAX_ATTEMPTS = 60;
