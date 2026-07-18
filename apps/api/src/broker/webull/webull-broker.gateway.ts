import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  Candle,
  CandleRequest,
  FuturesContract,
  OptionsChain,
  OptionType,
  OrderPreview,
  OrderRequest,
  OrderResult,
  Position,
  Quote,
} from '@0dtetrader/shared-types';
import { brokerErrors } from '../../common/broker-error';
import { CredentialsService } from '../../credentials/credentials.service';
import {
  computeMid,
  estimateBuyingPower,
  parseOccSymbol,
  resolveAutoOtm,
} from '../contract-resolution';
import { BrokerGateway } from '../broker-gateway.interface';
import { mockOptionExpirations } from '../mock-broker.gateway';
import { OrderEventsService } from '../order-events.service';
import {
  asArray,
  asObject,
  buildFuturesOrder,
  buildOptionOrder,
  CATEGORY,
  formatOccSymbol,
  isFuturesSymbol,
  parseBuyingPower,
  parseFuturesInstruments,
  parsePlaceResult,
  parsePreviewCost,
  positionIntentFor,
  TIMESPAN,
  toClientOrderId,
  WEBULL_SANDBOX_HOSTS,
  WebullHosts,
} from './webull-endpoints';
import { FetchImpl, WebullClient } from './webull-client';
import {
  toCandle,
  toOptionContract,
  toOrderResult,
  toPosition,
  toProjectFuturesSymbol,
  toQuote,
  toWebullFuturesSymbol,
  WebullBar,
  WebullOrder,
  WebullPosition,
  WebullSnapshot,
} from './webull-mappers';

/** Chain probe span: ±12 strikes around the money, both types (50 symbols). */
const CHAIN_STRIKES_EACH_SIDE = 12;
/** Option snapshot accepts max 20 symbols per call [verified: SDK]. */
const SNAPSHOT_BATCH = 20;
/** Order-status polling after placement. */
const STATUS_POLL_INTERVAL_MS = 1_000;
const STATUS_POLL_MAX_ATTEMPTS = 60;

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

/**
 * Real Webull OpenAPI gateway (P4). Wire details live in webull-endpoints.ts
 * (paths/payloads), webull-mappers.ts (response→DTO) and webull-signer.ts;
 * this class maps them onto the BrokerGateway seam.
 *
 * - Per-user WebullClient built from decrypted, encrypted-at-rest credentials;
 *   clients are cached per user and rebuilt when credentials change.
 * - Option chains: the official API has NO chain endpoint (see
 *   webull-endpoints.ts header) — chains are probed by batch-requesting
 *   option snapshots for candidate OCC symbols [best-effort].
 * - Futures symbols: Webull uses 1-digit years ("ESZ6") on the wire; the app
 *   sees 2-digit years ("ESZ26"). Translation happens only here.
 * - Fills: Webull pushes order events over gRPC (out of scope for P4); the
 *   gateway polls order/detail after placement until a terminal status and
 *   emits orderUpdates, so the app still gets fill feedback.
 */
@Injectable()
export class WebullBrokerGateway implements BrokerGateway, OnModuleDestroy {
  private readonly logger = new Logger(WebullBrokerGateway.name);
  private readonly clients = new Map<
    string,
    { fingerprint: string; client: WebullClient }
  >();
  private readonly pollTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly credentials: CredentialsService,
    private readonly config: ConfigService,
    private readonly events: OrderEventsService,
    private readonly fetchImpl?: FetchImpl,
  ) {}

  onModuleDestroy(): void {
    for (const timer of this.pollTimers.values()) clearTimeout(timer);
    this.pollTimers.clear();
  }

  // -------------------------------------------------------------------------
  // Client factory (per-user, credentials-aware)
  // -------------------------------------------------------------------------

  private async clientFor(userId: string): Promise<WebullClient> {
    const creds = await this.credentials.getDecrypted(userId);
    if (!creds) {
      throw brokerErrors.authFailed(
        'No Webull credentials on file — save app key/secret in Profile first',
      );
    }
    const fingerprint = createHash('sha256')
      .update(`${creds.appKey}${creds.appSecret}${creds.accountId}`)
      .digest('hex');
    const existing = this.clients.get(userId);
    if (existing && existing.fingerprint === fingerprint) {
      return existing.client;
    }
    const client = new WebullClient(creds, {
      hosts: this.hosts(),
      fetchImpl: this.fetchImpl,
    });
    this.clients.set(userId, { fingerprint, client });
    return client;
  }

  private hosts(): WebullHosts {
    const api =
      this.config.get<string>('webull.apiBaseUrl') || WEBULL_SANDBOX_HOSTS.api;
    // Market data lives on a separate host family (api.* → data-api.*). An
    // explicit WEBULL_MARKET_DATA_BASE_URL always wins.
    if (process.env.WEBULL_MARKET_DATA_BASE_URL) {
      return { api, data: process.env.WEBULL_MARKET_DATA_BASE_URL };
    }
    return { api, data: api.replace(/^https:\/\/api\./, 'https://data-api.') };
  }

  // -------------------------------------------------------------------------
  // Market data
  // -------------------------------------------------------------------------

  async getQuote(userId: string, symbol: string): Promise<Quote> {
    const client = await this.clientFor(userId);
    const occ = parseOccSymbol(symbol);
    if (occ) {
      const rows = asArray(
        await client.request('optionSnapshot', {
          query: { symbols: symbol, category: CATEGORY.option },
        }),
      ) as WebullSnapshot[];
      const first = rows[0];
      if (!first) throw brokerErrors.contractNotFound(`Unknown option: ${symbol}`);
      return toQuote(symbol, first);
    }
    if (isFuturesSymbol(symbol)) {
      const webullSymbol = toWebullFuturesSymbol(symbol);
      const rows = asArray(
        await client.request('futuresSnapshot', {
          query: { symbols: webullSymbol, category: CATEGORY.futures },
        }),
      ) as WebullSnapshot[];
      const first = rows[0];
      if (!first) {
        throw brokerErrors.contractNotFound(`Unknown futures contract: ${symbol}`);
      }
      // The app keeps the project-format symbol.
      return toQuote(symbol, { ...first, symbol });
    }
    const rows = asArray(
      await client.request('stockSnapshot', {
        query: { symbols: symbol, category: CATEGORY.stock },
      }),
    ) as WebullSnapshot[];
    const first = rows[0];
    if (!first) throw brokerErrors.contractNotFound(`Unknown symbol: ${symbol}`);
    return toQuote(symbol, first);
  }

  async getCandles(
    userId: string,
    symbol: string,
    req: CandleRequest,
  ): Promise<Candle[]> {
    const client = await this.clientFor(userId);
    const occ = parseOccSymbol(symbol);
    const futures = !occ && isFuturesSymbol(symbol);
    const endpoint = occ ? 'optionBars' : futures ? 'futuresBars' : 'stockBars';
    const category = occ
      ? CATEGORY.option
      : futures
        ? CATEGORY.futures
        : CATEGORY.stock;
    const query: Record<string, string> = {
      symbol: futures ? toWebullFuturesSymbol(symbol) : symbol,
      category,
      timespan: TIMESPAN[req.interval],
      count: '200',
    };
    if (req.from) query.start_time = String(Date.parse(req.from));
    if (req.to) query.end_time = String(Date.parse(req.to));
    const raw = await client.request(endpoint, { query });
    return asArray(raw).map((b) => toCandle(b as WebullBar));
  }

  /**
   * [best-effort] No official chain endpoint exists: the chain is probed by
   * batch-querying option snapshots for a ±12-strike grid around the
   * underlying price. Contracts the snapshot endpoint returns are included;
   * the rest are treated as non-existent.
   */
  async getOptionsChain(
    userId: string,
    symbol: string,
    expiration?: string,
  ): Promise<OptionsChain> {
    const client = await this.clientFor(userId);
    const expirations = mockOptionExpirations(new Date());
    const chosen = expiration ?? expirations[0];
    if (!expirations.includes(chosen)) {
      throw brokerErrors.contractNotFound(
        `No chain for expiration ${chosen}. Available: ${expirations.join(', ')}`,
      );
    }
    const underlyingQuote = await this.getQuote(userId, symbol);
    const price = underlyingQuote.last;
    const increment = price < 250 ? 1 : 5;
    const atm = Math.round(price / increment) * increment;

    const candidates: { symbol: string; strike: number; optionType: OptionType }[] = [];
    for (let k = -CHAIN_STRIKES_EACH_SIDE; k <= CHAIN_STRIKES_EACH_SIDE; k++) {
      const strike = atm + k * increment;
      for (const optionType of ['call', 'put'] as OptionType[]) {
        candidates.push({
          symbol: formatOccSymbol(symbol, chosen, optionType, strike),
          strike,
          optionType,
        });
      }
    }

    const bySymbol = new Map<string, WebullSnapshot>();
    for (let i = 0; i < candidates.length; i += SNAPSHOT_BATCH) {
      const batch = candidates.slice(i, i + SNAPSHOT_BATCH);
      let rows: WebullSnapshot[];
      try {
        rows = asArray(
          await client.request('optionSnapshot', {
            query: {
              symbols: batch.map((c) => c.symbol).join(','),
              category: CATEGORY.option,
            },
          }),
        ) as WebullSnapshot[];
      } catch (err) {
        this.logger.warn(
          `option snapshot probe failed for ${symbol} ${chosen} batch ${i / SNAPSHOT_BATCH}: ${(err as Error).message}`,
        );
        continue;
      }
      for (const row of rows) {
        if (row.symbol) bySymbol.set(row.symbol, row);
      }
    }

    const contracts = candidates
      .filter((c) => bySymbol.has(c.symbol))
      .map((c) =>
        toOptionContract(
          c.symbol,
          symbol,
          chosen,
          c.strike,
          c.optionType,
          bySymbol.get(c.symbol)!,
        ),
      );
    return {
      underlying: symbol.toUpperCase(),
      underlyingPrice: price,
      expirations,
      contracts,
    };
  }

  async getFuturesContracts(
    userId: string,
    root: string,
  ): Promise<FuturesContract[]> {
    const client = await this.clientFor(userId);
    const raw = await client.request('futuresByCode', {
      query: {
        code: root.toUpperCase(),
        category: CATEGORY.futures,
        contract_type: 'MONTHLY',
      },
    });
    const instruments = parseFuturesInstruments(raw);
    if (instruments.length === 0) {
      throw brokerErrors.contractNotFound(
        `Unknown futures root: ${root} (or no monthly contracts)`,
      );
    }
    // Nearest expiry first; contracts without a parsable expiry go last.
    const sorted = [...instruments].sort((a, b) =>
      (a.expiration ?? '9999').localeCompare(b.expiration ?? '9999'),
    );
    const selected = sorted.slice(0, 2);

    const quotes = new Map<string, Quote>();
    try {
      const rows = asArray(
        await client.request('futuresSnapshot', {
          query: {
            symbols: selected.map((c) => c.symbol).join(','),
            category: CATEGORY.futures,
          },
        }),
      ) as WebullSnapshot[];
      for (const row of rows) {
        const q = toQuote(String(row.symbol ?? ''), row);
        if (q.symbol) quotes.set(q.symbol, q);
      }
    } catch (err) {
      this.logger.warn(
        `futures snapshot failed for ${root}: ${(err as Error).message}`,
      );
    }

    return selected.map((c, i) => {
      const q = quotes.get(c.symbol);
      return {
        symbol: toProjectFuturesSymbol(c.symbol, c.contractMonth),
        root: c.root.toUpperCase(),
        expiration: c.expiration ?? '',
        frontMonth: i === 0,
        bid: q?.bid ?? 0,
        ask: q?.ask ?? 0,
        last: q?.last ?? 0,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Trading
  // -------------------------------------------------------------------------

  async previewOrder(userId: string, order: OrderRequest): Promise<OrderPreview> {
    const client = await this.clientFor(userId);
    const resolved = await this.resolveContract(userId, order);
    const price =
      order.orderType === 'market'
        ? resolved.last
        : computeMid(resolved.bid, resolved.ask);

    const warnings: string[] = [];
    if (
      resolved.optionTerms &&
      resolved.optionTerms.expiration === new Date().toISOString().slice(0, 10)
    ) {
      warnings.push('0DTE contract — expires today');
    }
    if (order.assetClass === 'option' && order.orderType === 'market') {
      warnings.push('Market order on an option contract — fills at last price');
    }

    // Ask the broker for a cost estimate; fall back to a local estimate.
    let estBuyingPower: number | undefined;
    try {
      const newOrder = await this.buildNewOrder(
        userId,
        order,
        resolved,
        toClientOrderId(`prev${Date.now()}`),
        order.orderType === 'market' ? undefined : price,
      );
      const raw = await client.request('orderPreview', {
        body: { account_id: client.accountId, new_orders: [newOrder] },
      });
      estBuyingPower = parsePreviewCost(raw);
    } catch (err) {
      warnings.push(
        `Broker preview unavailable: ${(err as Error).message} — local estimate used`,
      );
    }
    if (estBuyingPower === undefined) {
      estBuyingPower = estimateBuyingPower(
        order.assetClass,
        resolved.contractSymbol,
        order.quantity,
        price,
      );
      warnings.push('Buying-power effect is a local estimate');
    }

    const buyingPower = parseBuyingPower(
      await client.request('balance', {
        query: { account_id: client.accountId },
      }),
      order.assetClass === 'option',
    );
    if (buyingPower !== undefined && estBuyingPower > buyingPower) {
      warnings.push(
        `Estimated buying power ${estBuyingPower} exceeds available ${buyingPower}`,
      );
    }

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
      order.orderType === 'market'
        ? undefined
        : computeMid(resolved.bid, resolved.ask);

    const clientOrderId = toClientOrderId(idempotencyKey);
    const newOrder = await this.buildNewOrder(
      userId,
      order,
      resolved,
      clientOrderId,
      limitPrice,
    );
    const raw = await client.request('orderPlace', {
      body: { account_id: client.accountId, new_orders: [newOrder] },
    });
    const placed = parsePlaceResult(raw);

    const result: OrderResult = {
      // Cancel/replace operate on client_order_id, so that is our order id.
      orderId: placed.clientOrderId ?? clientOrderId,
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
    // Look the order up first: unknown orders fail locally with
    // ORDER_NOT_FOUND, and the cancelled orderUpdate carries the full order.
    const open = await this.getOpenOrders(userId);
    const target = open.find((o) => o.orderId === orderId);
    if (!target) throw brokerErrors.orderNotFound(orderId);
    await client.request('orderCancel', {
      body: { account_id: client.accountId, client_order_id: orderId },
    });
    this.stopStatusPoll(orderId);
    this.events.emit(userId, { ...target, status: 'cancelled' });
  }

  async getPositions(userId: string): Promise<Position[]> {
    const client = await this.clientFor(userId);
    const raw = await client.request('positions', {
      query: { account_id: client.accountId },
    });
    return asArray(raw)
      .map((p) => toPosition(p as WebullPosition))
      .filter((p): p is Position => p !== null);
  }

  async getOpenOrders(userId: string): Promise<OrderResult[]> {
    const client = await this.clientFor(userId);
    const raw = await client.request('orderOpen', {
      query: { account_id: client.accountId, page_size: '100' },
    });
    return this.flattenOrders(raw)
      .map((o) => toOrderResult(o))
      .filter(
        (o) => o.status === 'submitted' || o.status === 'partially_filled',
      );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Builds the unified new_order object for preview/place. */
  private async buildNewOrder(
    userId: string,
    order: OrderRequest,
    resolved: ResolvedContract,
    clientOrderId: string,
    limitPrice?: number,
  ) {
    if (order.assetClass === 'option') {
      if (!resolved.optionTerms) {
        throw brokerErrors.orderRejected('Option contract terms were not resolved');
      }
      const intent = await this.optionPositionIntent(
        userId,
        order,
        resolved.contractSymbol,
      );
      return buildOptionOrder(
        order,
        resolved.optionTerms,
        clientOrderId,
        limitPrice,
        intent,
      );
    }
    return buildFuturesOrder(
      order,
      toWebullFuturesSymbol(resolved.contractSymbol),
      clientOrderId,
      limitPrice,
    );
  }

  /** BUY/SELL_TO_CLOSE when flattening an existing position, else *_TO_OPEN. */
  private async optionPositionIntent(
    userId: string,
    order: OrderRequest,
    contractSymbol: string,
  ) {
    let existing = 0;
    try {
      const positions = await this.getPositions(userId);
      existing =
        positions.find((p) => p.symbol === contractSymbol)?.quantity ?? 0;
    } catch (err) {
      this.logger.warn(
        `position lookup failed; defaulting intent to open: ${(err as Error).message}`,
      );
    }
    return positionIntentFor(order.side, existing);
  }

  /** Resolves any OrderRequest to a concrete, live-quoted contract. */
  private async resolveContract(
    userId: string,
    order: OrderRequest,
  ): Promise<ResolvedContract> {
    if (order.assetClass === 'option') {
      const { optionType } = order.selection;
      if (!optionType) {
        throw brokerErrors.orderRejected(
          'selection.optionType is required for option orders',
        );
      }
      const chain = await this.getOptionsChain(
        userId,
        order.underlying,
        order.selection.expiration,
      );
      const contract =
        order.selection.mode === 'auto_otm'
          ? resolveAutoOtm(chain.contracts, optionType, chain.underlyingPrice)
          : chain.contracts.find(
              (c) =>
                c.optionType === optionType &&
                c.strike === order.selection.strike,
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

    const contracts = await this.getFuturesContracts(userId, order.underlying);
    const contract = contracts.find(
      (c) => c.symbol === order.selection.contractSymbol,
    );
    if (!contract) {
      throw brokerErrors.contractNotFound(
        `No futures contract ${order.selection.contractSymbol} for root ${order.underlying}`,
      );
    }
    return {
      contractSymbol: contract.symbol,
      bid: contract.bid,
      ask: contract.ask,
      last: contract.last,
    };
  }

  /** Open-order entries are combo wrappers with a nested orders[] array, or
   *  flat order objects depending on the endpoint variant [best-effort]. */
  private flattenOrders(raw: unknown): WebullOrder[] {
    const out: WebullOrder[] = [];
    for (const entry of asArray(raw) as Record<string, unknown>[]) {
      if (Array.isArray(entry.orders)) {
        for (const o of entry.orders as Record<string, unknown>[]) {
          out.push({
            client_order_id: entry.client_order_id as string | undefined,
            ...o,
          } as WebullOrder);
        }
      } else {
        out.push(entry as WebullOrder);
      }
    }
    return out;
  }

  /**
   * Polls order/detail after placement until a terminal status (fills
   * otherwise arrive only via Webull's gRPC events, out of scope for P4).
   */
  private startStatusPoll(
    userId: string,
    client: WebullClient,
    result: OrderResult,
  ): void {
    let attempts = 0;
    const tick = async (): Promise<void> => {
      this.pollTimers.delete(result.orderId);
      attempts += 1;
      try {
        const raw = await client.request('orderDetail', {
          query: {
            account_id: client.accountId,
            client_order_id: result.orderId,
          },
        });
        const detail = toOrderResult(asObject(raw) as WebullOrder);
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
        this.logger.debug(
          `status poll for ${result.orderId} failed: ${(err as Error).message}`,
        );
      }
      if (attempts < STATUS_POLL_MAX_ATTEMPTS) {
        this.schedulePoll(userId, client, result, tick);
      }
    };
    this.schedulePoll(userId, client, result, tick);
  }

  private schedulePoll(
    userId: string,
    client: WebullClient,
    result: OrderResult,
    tick: () => Promise<void>,
  ): void {
    const timer = setTimeout(() => void tick(), STATUS_POLL_INTERVAL_MS);
    timer.unref?.();
    this.pollTimers.set(result.orderId, timer);
  }

  private stopStatusPoll(orderId: string): void {
    const timer = this.pollTimers.get(orderId);
    if (timer) {
      clearTimeout(timer);
      this.pollTimers.delete(orderId);
    }
  }
}
