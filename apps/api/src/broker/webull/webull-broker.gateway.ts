import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  Candle,
  CandleInterval,
  CandleRequest,
  OptionsChain,
  OptionType,
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
  asArray,
  asObject,
  buildOptionOrder,
  CATEGORY,
  formatOccSymbol,
  parseBuyingPower,
  parsePlaceResult,
  parsePreviewCost,
  positionIntentFor,
  TIMESPAN,
  toClientOrderId,
  WEBULL_PROD_HOSTS,
  WEBULL_SANDBOX_HOSTS,
  WebullHosts,
} from './webull-endpoints';
import { FetchImpl, WebullClient, WebullCredentials } from './webull-client';
import { WebullTokenStore } from './webull-token-store';
import {
  toCandle,
  toOptionContract,
  toOrderResult,
  toPosition,
  toQuote,
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

/** Today's date in the US options market timezone (0DTE warnings). */
function tradingDay(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Real Webull OpenAPI gateway (P4). Wire details live in webull-endpoints.ts
 * (paths/payloads), webull-mappers.ts (response→DTO) and webull-signer.ts;
 * this class maps them onto the BrokerGateway seam.
 *
 * - Per-user WebullClient built from decrypted, encrypted-at-rest credentials
 *   for the user's current trading mode (live / practice); clients are cached
 *   per (user, mode) and rebuilt when credentials change. Practice mode falls
 *   back to the server's built-in practice app credentials when the user has
 *   not stored their own.
 * - Option chains: the official API has NO chain endpoint (see
 *   webull-endpoints.ts header) — chains are probed by batch-requesting
 *   option snapshots for candidate OCC symbols [best-effort].
 * - Fills: Webull pushes order events over gRPC (out of scope for P4); the
 *   gateway polls order/detail after placement until a terminal status and
 *   emits orderUpdates, so the app still gets fill feedback.
 */
@Injectable()
export class WebullBrokerGateway implements BrokerGateway, OnModuleDestroy {
  private readonly logger = new Logger(WebullBrokerGateway.name);
  private readonly clients = new Map<string, { fingerprint: string; client: WebullClient }>();
  private readonly pollTimers = new Map<string, NodeJS.Timeout>();
  /** Timespans the live API rejected or returned empty (native-first fallback
   *  memo for 30m/4h — see getCandles). */
  private readonly unsupportedTimespans = new Set<CandleInterval>();

  constructor(
    private readonly credentials: CredentialsService,
    private readonly config: ConfigService,
    private readonly events: OrderEventsService,
    private readonly prisma: PrismaService,
    private readonly tokenStore?: WebullTokenStore,
    private readonly fetchImpl?: FetchImpl,
  ) {}

  onModuleDestroy(): void {
    for (const timer of this.pollTimers.values()) clearTimeout(timer);
    this.pollTimers.clear();
  }

  /**
   * Drop the cached client (and its token) for the user's current mode and
   * mint a fresh access token — the server side of the app's "Reconnect"
   * button; spares the user re-entering credentials when a token goes stale.
   */
  async reauthenticate(userId: string): Promise<TradingMode> {
    const mode = await this.tradingModeFor(userId);
    this.clients.delete(`${userId}:${mode}`);
    const client = await this.clientFor(userId);
    await client.reauthenticate();
    return mode;
  }

  // -------------------------------------------------------------------------
  // Client factory (per-user, per-environment, credentials-aware)
  // -------------------------------------------------------------------------

  /** The user's current live/practice mode (per-user server-side setting). */
  private async tradingModeFor(userId: string): Promise<TradingMode> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return user?.tradingMode === 'practice' ? 'practice' : 'live';
  }

  /**
   * Credentials for (userId, mode). Practice mode falls back to the server's
   * built-in practice app credentials when the user hasn't stored their own.
   */
  private async credentialsFor(
    userId: string,
    mode: TradingMode,
  ): Promise<WebullCredentials | null> {
    const stored = await this.credentials.getDecrypted(userId, 'webull', mode);
    if (stored) return stored as unknown as WebullCredentials;
    if (mode !== 'practice') return null;
    const appKey = this.config.get<string>('webull.practiceAppKey') ?? '';
    const appSecret = this.config.get<string>('webull.practiceAppSecret') ?? '';
    const accountId = this.config.get<string>('webull.practiceAccountId') ?? '';
    if (!appKey || !appSecret) return null;
    // Materialize the built-in practice fallback as a stored credential so the
    // discovered account id survives a token-cache miss / restart (bug 3) and
    // so /me reports webullPracticeConfigured once practice is used (bug 2).
    await this.credentials.ensureWebullPracticeStored(userId, { appKey, appSecret, accountId });
    return { appKey, appSecret, accountId };
  }

  private async clientFor(userId: string): Promise<WebullClient> {
    const mode = await this.tradingModeFor(userId);
    const creds = await this.credentialsFor(userId, mode);
    if (!creds) {
      throw brokerErrors.authFailed(
        mode === 'practice'
          ? 'No Webull practice credentials available — save app key/secret in Profile first'
          : 'No Webull credentials on file — save app key/secret in Profile first',
      );
    }
    // The account id is not part of the fingerprint: it is discovered and
    // set on the live client after auth, and a rebuild for that would
    // needlessly drop the token cache.
    const fingerprint = createHash('sha256')
      .update(`${creds.appKey}${creds.appSecret}`)
      .digest('hex');
    const cacheKey = `${userId}:${mode}`;
    const existing = this.clients.get(cacheKey);
    if (existing && existing.fingerprint === fingerprint) {
      return existing.client;
    }
    const client = new WebullClient(creds, {
      hosts: this.hosts(mode),
      fetchImpl: this.fetchImpl,
      tokenStore: this.tokenStore?.scopedTo(userId, 'webull', mode),
    });
    this.clients.set(cacheKey, { fingerprint, client });
    return client;
  }

  /**
   * The Webull account id for API calls. Official flow: it is NOT typed by
   * the user — after authentication it is discovered once via
   * GET /openapi/account/list and persisted alongside the credentials.
   */
  private async accountIdFor(userId: string, client: WebullClient): Promise<string> {
    if (client.hasAccountId()) return client.accountId;
    const payload = await client.request('accountList');
    const rows = Array.isArray(payload) ? payload : asArray(asObject(payload)?.accounts);
    const accounts = rows.map((row) => asObject(row));
    // Sandbox and production responses have used both snake_case and camelCase
    // account-type fields, so accept the known aliases when identifying margin.
    const hasValidAccountId = (
      account: Record<string, unknown> | null,
    ): account is Record<string, unknown> =>
      typeof account?.account_id === 'string' && account.account_id.length > 0;
    const marginAccount = accounts.find((account) => {
      if (!hasValidAccountId(account)) return false;
      // These aliases cover the snake_case and camelCase account-list payloads
      // observed across Webull's sandbox and production environments.
      const type =
        account.account_type ?? account.accountType ?? account.account_type_name ?? account.type;
      if (typeof type !== 'string') return false;
      // Normalize labels such as "MARGIN_ACCOUNT", "margin-account", and
      // "Margin Account" before matching only known margin account types.
      const normalizedType = type.toLowerCase().replace(/[\s_-]+/g, '');
      return normalizedType === 'margin' || normalizedType === 'marginaccount';
    });
    const firstAccount = accounts.find(hasValidAccountId);
    const accountId = (marginAccount ?? firstAccount)?.account_id;
    if (!accountId) {
      throw brokerErrors.authFailed(
        'Webull returned no accounts for these credentials — check the app key/secret',
      );
    }
    client.setAccountId(accountId);
    const mode = await this.tradingModeFor(userId);
    await this.credentials.saveDiscoveredAccountId(userId, 'webull', mode, accountId);
    this.logger.log(`Discovered Webull ${mode} account (…${accountId.slice(-4)}) via account/list`);
    return accountId;
  }

  private hosts(mode: TradingMode): WebullHosts {
    if (mode === 'live') {
      const api = this.config.get<string>('webull.liveApiBaseUrl') || WEBULL_PROD_HOSTS.api;
      const data =
        this.config.get<string>('webull.liveMarketDataBaseUrl') ||
        api.replace(/^https:\/\/api\./, 'https://data-api.');
      return { api, data };
    }
    const api = this.config.get<string>('webull.apiBaseUrl') || WEBULL_SANDBOX_HOSTS.api;
    // Market data lives on a separate host family (api.* → data-api.*). An
    // explicit WEBULL_MARKET_DATA_BASE_URL always wins (read through the
    // config layer like every other override).
    // [verified 2026-07-18 against live] data-api.webull.com can be
    // unreachable (connection hangs) while api.webull.com serves the
    // market-data paths fine — the env override is the escape hatch, and the
    // signer keys its algorithm off the request host, so it stays correct.
    const data =
      this.config.get<string>('webull.marketDataBaseUrl') ||
      api.replace(/^https:\/\/api\./, 'https://data-api.');
    return { api, data };
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
    const rows = asArray(
      await client.request('stockSnapshot', {
        query: { symbols: symbol, category: CATEGORY.stock },
      }),
    ) as WebullSnapshot[];
    const first = rows[0];
    if (!first) throw brokerErrors.contractNotFound(`Unknown symbol: ${symbol}`);
    return toQuote(symbol, first);
  }

  async getCandles(userId: string, symbol: string, req: CandleRequest): Promise<Candle[]> {
    const client = await this.clientFor(userId);
    const occ = parseOccSymbol(symbol);
    const endpoint = occ ? 'optionBars' : 'stockBars';
    const category = occ ? CATEGORY.option : CATEGORY.stock;

    const fetchBars = async (timespan: string, count: number): Promise<Candle[]> => {
      // Verified against the live API: stock bars take `symbol` (singular), but
      // option bars require `symbols` (plural) — singular gets a
      // 400 "Parameters not valid".
      const query: Record<string, string> = {
        [occ ? 'symbols' : 'symbol']: symbol,
        category,
        timespan,
        count: String(count),
      };
      if (req.from) query.start_time = String(Date.parse(req.from));
      if (req.to) query.end_time = String(Date.parse(req.to));
      let raw = await client.request(endpoint, { query });
      // A window covering no trading session (weekend/holiday) returns []; fall
      // back to the latest bars so the chart still renders the last session.
      if (asArray(raw).length === 0 && (req.from || req.to)) {
        delete query.start_time;
        delete query.end_time;
        raw = await client.request(endpoint, { query });
      }
      // Webull returns bars newest-first; chart clients require ascending
      // (lightweight-charts setData throws on unsorted input, DGCharts mirrors
      // the same assumption) — sort by bucket start.
      return asArray(raw)
        .map((b) => toCandle(b as WebullBar))
        .sort((a, b) => a.time.localeCompare(b.time));
    };

    // Whether Webull accepts count > 200 is unverified; if the larger request
    // fails, settle for the documented cap (fewer but correct bars).
    const fetchAggregated = async (
      source: Exclude<CandleInterval, '1w'>,
      count: number,
      target: CandleInterval,
    ): Promise<Candle[]> => {
      let bars: Candle[];
      try {
        bars = await fetchBars(TIMESPAN[source], count);
      } catch (err) {
        if (count <= 200) throw err;
        this.logger.warn(
          `bars count=${count} rejected for ${symbol} ${source} — retrying with 200: ${(err as Error).message}`,
        );
        bars = await fetchBars(TIMESPAN[source], 200);
      }
      return aggregateCandles(bars, target);
    };

    // Webull has no verified weekly timespan — always build 1w from daily bars.
    if (req.interval === '1w') {
      return fetchAggregated('1d', 600, '1w');
    }
    const plan = AGGREGATION_PLANS[req.interval];
    const planSource = plan?.source as Exclude<CandleInterval, '1w'> | undefined;
    if (!plan || !planSource) {
      return fetchBars(TIMESPAN[req.interval], 200);
    }
    // Native M30/M240 support is unverified against the live API: try it once,
    // and on error or an empty result remember the failure for the process
    // lifetime and aggregate from the next-smaller supported timespan.
    if (!this.unsupportedTimespans.has(req.interval)) {
      try {
        const native = await fetchBars(TIMESPAN[req.interval], 200);
        if (native.length > 0) return native;
      } catch (err) {
        this.logger.warn(
          `native timespan ${TIMESPAN[req.interval]} failed for ${symbol} — aggregating from ${planSource}: ${(err as Error).message}`,
        );
      }
      this.unsupportedTimespans.add(req.interval);
    }
    return fetchAggregated(planSource, 200 * plan.factor, req.interval);
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
    const expirations = optionExpirations(symbol, new Date());
    const chosen = expiration ?? expirations[0];
    if (!expirations.includes(chosen)) {
      throw brokerErrors.contractNotFound(
        `No chain for expiration ${chosen}. Available: ${expirations.join(', ')}`,
      );
    }
    const underlyingQuote = await this.getQuote(userId, symbol);
    const price = underlyingQuote.last;
    if (!(price > 0)) {
      // A degraded snapshot (price defaulted to 0) would build negative
      // strikes and probe garbage OCC symbols — fail clearly instead.
      throw brokerErrors.unavailable(
        `No usable underlying price for ${symbol} — cannot probe an option chain`,
      );
    }
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
        toOptionContract(c.symbol, symbol, chosen, c.strike, c.optionType, bySymbol.get(c.symbol)!),
      );
    return {
      underlying: symbol.toUpperCase(),
      underlyingPrice: price,
      expirations,
      contracts,
    };
  }

  // -------------------------------------------------------------------------
  // Trading
  // -------------------------------------------------------------------------

  async previewOrder(userId: string, order: OrderRequest): Promise<OrderPreview> {
    const client = await this.clientFor(userId);
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

    // Ask the broker for a cost estimate; fall back to a local estimate.
    let estBuyingPower: number | undefined;
    try {
      const newOrder = await this.buildNewOrder(
        userId,
        order,
        resolved,
        toClientOrderId(userId, `prev${Date.now()}`),
        order.orderType === 'market' ? undefined : price,
      );
      const raw = await client.request('orderPreview', {
        body: {
          account_id: await this.accountIdFor(userId, client),
          new_orders: [newOrder],
        },
      });
      estBuyingPower = parsePreviewCost(raw);
    } catch (err) {
      warnings.push(`Broker preview unavailable: ${(err as Error).message} — local estimate used`);
    }
    if (estBuyingPower === undefined) {
      estBuyingPower = estimateBuyingPower(order.quantity, price);
      warnings.push('Buying-power effect is a local estimate');
    }

    const buyingPower = parseBuyingPower(
      await client.request('balance', {
        query: { account_id: await this.accountIdFor(userId, client) },
      }),
    );
    if (buyingPower !== undefined && estBuyingPower > buyingPower) {
      warnings.push(`Estimated buying power ${estBuyingPower} exceeds available ${buyingPower}`);
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
      order.orderType === 'market' ? undefined : computeMid(resolved.bid, resolved.ask);

    const clientOrderId = toClientOrderId(userId, idempotencyKey);
    const newOrder = await this.buildNewOrder(userId, order, resolved, clientOrderId, limitPrice);
    const raw = await client.request('orderPlace', {
      body: {
        account_id: await this.accountIdFor(userId, client),
        new_orders: [newOrder],
      },
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
      body: {
        account_id: await this.accountIdFor(userId, client),
        client_order_id: orderId,
      },
    });
    this.stopStatusPoll(userId, orderId);
    this.events.emit(userId, { ...target, status: 'cancelled' });
  }

  async getPositions(userId: string): Promise<Position[]> {
    const client = await this.clientFor(userId);
    const raw = await client.request('positions', {
      query: { account_id: await this.accountIdFor(userId, client) },
    });
    return asArray(raw)
      .map((p) => toPosition(p as WebullPosition))
      .filter((p): p is Position => p !== null);
  }

  async getOpenOrders(userId: string): Promise<OrderResult[]> {
    const client = await this.clientFor(userId);
    const raw = await client.request('orderOpen', {
      query: {
        account_id: await this.accountIdFor(userId, client),
        page_size: '100',
      },
    });
    return this.flattenOrders(raw)
      .map((o) => toOrderResult(o))
      .filter((o) => o.status === 'submitted' || o.status === 'partially_filled');
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
    if (!resolved.optionTerms) {
      throw brokerErrors.orderRejected('Option contract terms were not resolved');
    }
    const intent = await this.optionPositionIntent(userId, order, resolved.contractSymbol);
    return buildOptionOrder(order, resolved.optionTerms, clientOrderId, limitPrice, intent);
  }

  /** BUY/SELL_TO_CLOSE when flattening an existing position, else *_TO_OPEN. */
  private async optionPositionIntent(userId: string, order: OrderRequest, contractSymbol: string) {
    let existing = 0;
    try {
      const positions = await this.getPositions(userId);
      existing = positions.find((p) => p.symbol === contractSymbol)?.quantity ?? 0;
    } catch (err) {
      this.logger.warn(
        `position lookup failed; defaulting intent to open: ${(err as Error).message}`,
      );
    }
    return positionIntentFor(order.side, existing);
  }

  /** Resolves any OrderRequest to a concrete, live-quoted contract. */
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
  private startStatusPoll(userId: string, client: WebullClient, result: OrderResult): void {
    const key = `${userId}:${result.orderId}`;
    let attempts = 0;
    const tick = async (): Promise<void> => {
      this.pollTimers.delete(key);
      attempts += 1;
      try {
        const raw = await client.request('orderDetail', {
          query: {
            account_id: await this.accountIdFor(userId, client),
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
