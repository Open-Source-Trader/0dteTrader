import { Injectable, Logger } from '@nestjs/common';
import {
  Candle,
  CandleInterval,
  CandleRequest,
  OptionContract,
  OptionType,
  OptionsChain,
  OrderPreview,
  OrderRequest,
  OrderResult,
  Position,
  Quote,
  TradingMode,
} from '@0dtetrader/shared-types';
import { Alpaca, TimeFrame, TimeFrameUnit, timeFrame } from '@alpacahq/alpaca-trade-api';
import { createHash } from 'crypto';
import { BrokerError, brokerErrors } from '../../common/broker-error';
import { aggregateCandles } from '../../market-data/candle-aggregation';
import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  computeMid,
  estimateBuyingPower,
  parseOccSymbol,
  resolveAutoOtm,
} from '../contract-resolution';
import { BrokerGateway, MarketDataProvider } from '../broker-gateway.interface';
import { OrderEventsService } from '../order-events.service';
import { optionExpirations } from '../expiration-calendar';
import {
  AlpacaClientLike,
  AlpacaFactory,
  AlpacaSecrets,
  SdkBarsRequest,
  SdkOrderInput,
} from './alpaca-sdk.types';
import { toCandle, toOptionContract, toOrderResult, toPosition, toQuote } from './alpaca-mappers';

interface ResolvedContract {
  contractSymbol: string;
  bid: number;
  ask: number;
  last: number;
  optionTerms?: {
    underlying: string;
    expiration: string;
    strike: number;
    optionType: OptionType;
  };
}

const STATUS_POLL_INTERVAL_MS = 2500;
const STATUS_POLL_MAX_ATTEMPTS = 90;
/** Keep quote ticks responsive: the SDK's own retry/timeout protects GETs, but
 *  we bound it so a stalled option snapshot can't hang a streaming tick. */
const SDK_TIMEOUT_MS = 10_000;

/**
 * Alpaca broker adapter backed by the official `@alpacahq/alpaca-trade-api` SDK.
 *
 * The SDK owns all HTTP transport, endpoint paths, response parsing, auth, and
 * retry/rate-limit handling — replacing the hand-rolled client/endpoints/mappers
 * that previously drifted from Alpaca's real API (e.g. options market data lives
 * under `/v1beta1/options/*`, not `/v2/options/*`).
 */
@Injectable()
export class AlpacaBrokerGateway implements BrokerGateway, MarketDataProvider {
  private readonly logger = new Logger(AlpacaBrokerGateway.name);
  private readonly clients = new Map<string, { fingerprint: string; client: AlpacaClientLike }>();
  private readonly pollTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly credentials: CredentialsService,
    private readonly events: OrderEventsService,
    private readonly prisma: PrismaService,
    private readonly alpacaFactory: AlpacaFactory = (secrets, mode) =>
      new Alpaca({
        keyId: secrets.apiKey,
        secret: secrets.apiSecret,
        paper: mode === 'practice',
        timeoutMs: SDK_TIMEOUT_MS,
      }) as unknown as AlpacaClientLike,
  ) {}

  async onModuleDestroy(): Promise<void> {
    for (const timer of this.pollTimers.values()) clearTimeout(timer);
    this.pollTimers.clear();
  }

  // -- credential / client resolution ---------------------------------------

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
    return { apiKey: stored.apiKey, apiSecret: stored.apiSecret };
  }

  private async clientFor(userId: string): Promise<AlpacaClientLike> {
    const mode = await this.tradingModeFor(userId);
    const secrets = await this.credentialsFor(userId, mode);
    const fingerprint = `${secrets.apiKey}:${secrets.apiSecret}:${mode}`;
    const existing = this.clients.get(userId);
    if (existing && existing.fingerprint === fingerprint) return existing.client;
    const client = this.alpacaFactory(secrets, mode);
    this.clients.set(userId, { fingerprint, client });
    return client;
  }

  /** Wrap an SDK call so transport/API errors surface as typed BrokerErrors. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapSdkError(err);
    }
  }

  // -- market data ----------------------------------------------------------

  async getQuote(userId: string, symbol: string): Promise<Quote> {
    const client = await this.clientFor(userId);
    const occ = parseOccSymbol(symbol);
    if (occ) {
      const snaps = await this.guard(() =>
        client.marketData.collectOptionSnapshotsBySymbol({ symbols: [symbol] }),
      );
      const snap = snaps[symbol];
      if (!snap) throw brokerErrors.contractNotFound(`Unknown option: ${symbol}`);
      return toQuote(symbol, snap);
    }
    const snaps = await this.guard(() => client.marketData.stockSnapshots({ symbols: [symbol] }));
    const snap = snaps[symbol];
    if (!snap) throw brokerErrors.contractNotFound(`Unknown symbol: ${symbol}`);
    return toQuote(symbol, snap);
  }

  async getCandles(userId: string, symbol: string, req: CandleRequest): Promise<Candle[]> {
    const client = await this.clientFor(userId);
    const occ = parseOccSymbol(symbol);
    // Weekly bars are sparse from the API; aggregate from daily to stay stable.
    if (req.interval === '1w') {
      const daily = await this.fetchBars(client, occ, symbol, TimeFrame.Day, 600, {});
      return aggregateCandles(daily, '1w');
    }
    return this.fetchBars(client, occ, symbol, timeFrameFor(req.interval), 200, req);
  }

  private async fetchBars(
    client: AlpacaClientLike,
    occ: ReturnType<typeof parseOccSymbol>,
    symbol: string,
    timeframe: string,
    count: number,
    range: { from?: string; to?: string },
  ): Promise<Candle[]> {
    const query: SdkBarsRequest = { timeframe, limit: count };
    if (range.from) query.start = new Date(range.from);
    if (range.to) query.end = new Date(range.to);
    const get = () =>
      occ
        ? client.marketData.getOptionBarsFor(symbol, query)
        : client.marketData.getStockBarsFor(symbol, query);
    let raw = await this.guard(get);
    // If a window was requested but returned nothing, retry without the window
    // (Alpaca only serves a bounded lookback; out-of-range windows return empty).
    if (raw.length === 0 && (range.from || range.to)) {
      delete query.start;
      delete query.end;
      raw = await this.guard(get);
    }
    return raw.map(toCandle).sort((a, b) => a.time.localeCompare(b.time));
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
      throw brokerErrors.contractNotFound(`No options chain for ${symbol} on ${chosen}`);
    }
    const chain = await this.guard(() =>
      client.marketData.collectOptionChainBySymbol({
        underlyingSymbol: symbol,
        expirationDate: new Date(chosen),
      }),
    );
    const underlyingQuote = await this.getQuote(userId, symbol);
    const contracts: OptionContract[] = Object.entries(chain)
      .map(([occ, snap]) => toOptionContract(occ, snap))
      .filter((c) => c.symbol.length > 0);
    return {
      underlying: symbol.toUpperCase(),
      underlyingPrice: underlyingQuote.last,
      expirations,
      contracts,
    };
  }

  // -- trading --------------------------------------------------------------

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
    const input: SdkOrderInput = {
      type: order.orderType === 'market' ? 'market' : 'limit',
      symbol: resolved.contractSymbol,
      qty: order.quantity,
      side: order.side,
      assetClass: 'us_option',
      timeInForce: 'day',
      clientOrderId,
      ...(limitPrice !== undefined ? { limitPrice } : {}),
    };
    const placed = await this.guard(() => client.trading.orders.submit(input));
    const result: OrderResult = {
      ...toOrderResult(placed),
      orderId: placed.client_order_id ?? clientOrderId,
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
    const ord = await this.guard(() =>
      client.trading.orders.getOrderByClientOrderId({ clientOrderId: orderId }),
    );
    if (!ord.id) throw brokerErrors.orderNotFound(orderId);
    await this.guard(() => client.trading.orders.deleteOrderByOrderID({ orderId: ord.id! }));
    this.stopStatusPoll(userId, orderId);
    this.events.emit(userId, { ...target, status: 'cancelled' });
  }

  async getPositions(userId: string): Promise<Position[]> {
    const client = await this.clientFor(userId);
    const raw = await this.guard(() => client.trading.positions.getAllOpenPositions());
    return raw.map(toPosition).filter((p): p is Position => p !== null);
  }

  async getOpenOrders(userId: string): Promise<OrderResult[]> {
    const client = await this.clientFor(userId);
    const raw = await this.guard(() =>
      client.trading.orders.getAllOrders({ status: 'open', limit: 100 }),
    );
    return raw
      .map((o) => toOrderResult(o))
      .filter((o) => o.status === 'submitted' || o.status === 'partially_filled');
  }

  async reauthenticate(userId: string): Promise<TradingMode> {
    // Alpaca credentials are static API keys; no OAuth refresh needed.
    return this.tradingModeFor(userId);
  }

  // -- helpers --------------------------------------------------------------

  private async resolveContract(userId: string, order: OrderRequest): Promise<ResolvedContract> {
    const { optionType } = order.selection;
    if (!optionType)
      throw brokerErrors.orderRejected('selection.optionType is required for option orders');
    const chain = await this.getOptionsChain(userId, order.underlying, order.selection.expiration);
    const contract =
      order.selection.mode === 'auto_otm'
        ? resolveAutoOtm(chain.contracts, optionType, chain.underlyingPrice)
        : chain.contracts.find(
            (c) => c.optionType === optionType && c.strike === order.selection.strike,
          );
    if (!contract) {
      throw brokerErrors.contractNotFound(
        `No ${optionType} contract at strike ${order.selection.strike} for ${order.underlying}`,
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

  private startStatusPoll(userId: string, client: AlpacaClientLike, result: OrderResult): void {
    const key = `${userId}:${result.orderId}`;
    let attempts = 0;
    const tick = async (): Promise<void> => {
      this.pollTimers.delete(key);
      attempts += 1;
      try {
        const raw = await client.trading.orders.getOrderByClientOrderId({
          clientOrderId: result.orderId,
        });
        const detail = toOrderResult(raw);
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
      if (attempts < STATUS_POLL_MAX_ATTEMPTS) this.schedulePoll(key, tick);
    };
    this.schedulePoll(key, tick);
  }

  private schedulePoll(key: string, tick: () => void): void {
    this.pollTimers.set(
      key,
      setTimeout(() => void tick(), STATUS_POLL_INTERVAL_MS),
    );
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

function tradingDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function alpacaClientOrderId(userId: string, idempotencyKey: string): string {
  return createHash('sha256').update(`${userId}:${idempotencyKey}`).digest('hex').slice(0, 32);
}

/** Map an Alpaca SDK error (or any thrown error) to a typed BrokerError. */
function mapSdkError(err: unknown): BrokerError {
  if (err instanceof BrokerError) return err;
  const e = err as { status?: number; code?: string; message?: string };
  const status = e.status;
  const haystack = `${e.code ?? ''} ${e.message ?? ''}`.toUpperCase();
  if (status === 401 || status === 403) {
    return brokerErrors.authFailed(`Alpaca rejected credentials (${e.message ?? ''})`.trim());
  }
  if (status === 429) {
    return brokerErrors.rateLimited(`Alpaca rate limit (${e.message ?? ''})`.trim());
  }
  if (status === 404) {
    return brokerErrors.contractNotFound(e.message ?? 'Alpaca contract not found');
  }
  if (status === 400 || status === 422) {
    if (haystack.includes('INSUFFICIENT') || haystack.includes('BUYING_POWER')) {
      return brokerErrors.insufficientBuyingPower(e.message ?? 'Alpaca buying-power check failed');
    }
    return brokerErrors.orderRejected(e.message ?? 'Order rejected');
  }
  if (
    haystack.includes('MARKET_CLOSED') ||
    haystack.includes('NOT_TRADABLE') ||
    haystack.includes('OUTSIDE_REGULAR') ||
    haystack.includes('CLOSED')
  ) {
    return brokerErrors.marketClosed(e.message ?? 'Market closed');
  }
  return brokerErrors.unavailable(`Alpaca request failed: ${e.message ?? 'network error'}`);
}

function timeFrameFor(interval: CandleInterval): string {
  switch (interval) {
    case '1m':
      return TimeFrame.Minute;
    case '5m':
      return timeFrame(5, TimeFrameUnit.Minute);
    case '15m':
      return timeFrame(15, TimeFrameUnit.Minute);
    case '30m':
      return timeFrame(30, TimeFrameUnit.Minute);
    case '1h':
      return TimeFrame.Hour;
    case '4h':
      return timeFrame(4, TimeFrameUnit.Hour);
    case '1d':
      return TimeFrame.Day;
    case '1w':
      return TimeFrame.Week;
  }
}
