import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  Candle,
  CandleRequest,
  FuturesContract,
  OptionContract,
  OptionType,
  OptionsChain,
  OrderPreview,
  OrderRequest,
  OrderResult,
  Position,
  Quote,
} from '@0dtetrader/shared-types';
import { brokerErrors } from '../common/broker-error';
import { BrokerGateway } from './broker-gateway.interface';
import {
  computeMid,
  estimateBuyingPower,
  findExplicitOption,
  formatOccSymbol,
  futuresRootOf,
  parseOccSymbol,
  resolveAutoOtm,
} from './contract-resolution';
import { mockOptionExpirations } from './mock-broker.gateway';
import { OrderEventsService } from './order-events.service';
import { TtlCache } from './webull/webull-cache';
import { WebullClientProvider } from './webull/webull-client.provider';
import {
  INTERVAL_TO_TIMESPAN,
  num,
  toCandle,
  toFuturesContract,
  toOptionContract,
  toOrderResult,
  toPosition,
  toQuote,
  toWebullFuturesSymbol,
} from './webull/webull-mappers';

const CHAIN_CACHE_MS = 45_000; // fits the 60/min option-snapshot budget
/** Strikes each side of ATM in a synthesized chain (≤ 3 snapshot batches). */
const CHAIN_STRIKE_SPAN = 12;
const MAX_CANDLES = 500;
/** Post-place order status poll offsets (ms). */
const STATUS_POLL_DELAYS = [1_000, 2_000, 5_000, 10_000];

function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Real Webull OpenAPI gateway (P4, docs/WEBULL-INTEGRATION.md). All Webull
 * specifics live in ./webull; this class maps BrokerGateway calls onto the
 * client provider and mirrors the MockBrokerGateway's observable contract.
 *
 * Webull has no option-chain discovery endpoint, so getOptionsChain
 * synthesizes the chain: candidate expirations are probed with ATM snapshot
 * queries and strikes are generated around ATM, keeping only contracts the
 * snapshot endpoint actually returns.
 */
@Injectable()
export class WebullBrokerGateway implements BrokerGateway, OnModuleDestroy {
  private readonly logger = new Logger(WebullBrokerGateway.name);
  private readonly chainCache = new TtlCache<OptionsChain>();
  private readonly pollTimers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly client: WebullClientProvider,
    private readonly events: OrderEventsService,
  ) {}

  onModuleDestroy(): void {
    for (const timer of this.pollTimers) clearTimeout(timer);
    this.pollTimers.clear();
  }

  // -------------------------------------------------------------------------
  // Market data
  // -------------------------------------------------------------------------

  async getQuote(userId: string, symbol: string): Promise<Quote> {
    const occ = parseOccSymbol(symbol);
    if (occ) {
      const [snap] = await this.client.getOptionSnapshots(userId, [symbol]);
      if (!snap) {
        throw brokerErrors.contractNotFound(`No quote for option ${symbol}`);
      }
      return toQuote(symbol, snap);
    }
    if (futuresRootOf(symbol)) {
      const webullSymbol = toWebullFuturesSymbol(symbol);
      const [snap] = await this.client.getFuturesSnapshots(userId, [webullSymbol]);
      if (!snap) {
        throw brokerErrors.contractNotFound(`No quote for futures ${symbol}`);
      }
      return toQuote(symbol, snap);
    }
    const [snap] = await this.client.getStockSnapshots(userId, [symbol]);
    if (!snap) {
      throw brokerErrors.contractNotFound(`No quote for symbol ${symbol}`);
    }
    return toQuote(symbol, snap);
  }

  async getCandles(
    userId: string,
    symbol: string,
    req: CandleRequest,
  ): Promise<Candle[]> {
    const timespan = INTERVAL_TO_TIMESPAN[req.interval];
    const from = req.from ? Date.parse(req.from) : undefined;
    const to = req.to ? Date.parse(req.to) : undefined;
    let count = 200;
    if (from !== undefined && to !== undefined && to > from) {
      const intervalMs =
        { M1: 60_000, M5: 300_000, M15: 900_000, M60: 3_600_000, D: 86_400_000 }[
          timespan
        ] ?? 60_000;
      count = Math.min(Math.ceil((to - from) / intervalMs), MAX_CANDLES);
    }

    let category: 'US_STOCK' | 'US_OPTION' | 'US_FUTURES' = 'US_STOCK';
    let webullSymbol = symbol;
    if (parseOccSymbol(symbol)) {
      category = 'US_OPTION';
    } else if (futuresRootOf(symbol)) {
      category = 'US_FUTURES';
      webullSymbol = toWebullFuturesSymbol(symbol);
    }

    const bars = await this.client.getBars(
      userId,
      webullSymbol,
      category,
      timespan,
      count,
      from,
      to,
    );
    return bars
      .map(toCandle)
      .sort((a, b) => a.time.localeCompare(b.time));
  }

  async getOptionsChain(
    userId: string,
    symbol: string,
    expiration?: string,
  ): Promise<OptionsChain> {
    const underlying = symbol.toUpperCase();
    const [underlyingSnap] = await this.client.getStockSnapshots(userId, [
      underlying,
    ]);
    if (!underlyingSnap) {
      throw brokerErrors.contractNotFound(`Unknown underlying: ${symbol}`);
    }
    const price = num(underlyingSnap.price ?? underlyingSnap.last);

    const expirations = await this.probeExpirations(userId, underlying, price);
    const chosen = expiration ?? expirations[0];
    if (!expirations.includes(chosen)) {
      throw brokerErrors.contractNotFound(
        `No chain for expiration ${chosen}. Available: ${expirations.join(', ')}`,
      );
    }

    const cacheKey = `${underlying}:${chosen}`;
    const cached = this.chainCache.get(cacheKey);
    if (cached) {
      return { ...cached, underlyingPrice: price, expirations };
    }

    const increment = price < 250 ? 1 : 5;
    const atm = Math.round(price / increment) * increment;
    const wanted: {
      occ: string;
      strike: number;
      optionType: OptionType;
    }[] = [];
    for (let k = -CHAIN_STRIKE_SPAN; k <= CHAIN_STRIKE_SPAN; k++) {
      const strike = Math.round((atm + k * increment) * 100) / 100;
      if (strike <= 0) continue;
      for (const optionType of ['call', 'put'] as OptionType[]) {
        wanted.push({
          occ: formatOccSymbol(underlying, chosen, optionType, strike),
          strike,
          optionType,
        });
      }
    }

    const snaps = await this.client.getOptionSnapshots(
      userId,
      wanted.map((w) => w.occ),
    );
    const bySymbol = new Map(snaps.map((s) => [s.symbol, s]));
    const contracts: OptionContract[] = [];
    for (const w of wanted) {
      const snap = bySymbol.get(w.occ);
      if (!snap) continue; // Contract does not exist at this strike.
      contracts.push(
        toOptionContract(w.occ, underlying, chosen, w.strike, w.optionType, snap),
      );
    }
    if (contracts.length === 0) {
      throw brokerErrors.contractNotFound(
        `No option data for ${underlying} ${chosen}`,
      );
    }

    const chain: OptionsChain = {
      underlying,
      underlyingPrice: price,
      expirations,
      contracts,
    };
    this.chainCache.set(cacheKey, chain, CHAIN_CACHE_MS);
    return chain;
  }

  async getFuturesContracts(
    userId: string,
    root: string,
  ): Promise<FuturesContract[]> {
    const instruments = await this.client.getFuturesInstruments(userId, root);
    const monthly = instruments
      .filter((i) => i.symbol && i.last_trading_date)
      .filter((i) => (i.contract_type ?? 'MONTHLY').toUpperCase() !== 'MAIN')
      .sort((a, b) =>
        (a.last_trading_date ?? '').localeCompare(b.last_trading_date ?? ''),
      );
    if (monthly.length === 0) {
      throw brokerErrors.contractNotFound(`Unknown futures root: ${root}`);
    }
    const snaps = await this.client.getFuturesSnapshots(
      userId,
      monthly.map((i) => i.symbol!),
    );
    const bySymbol = new Map(snaps.map((s) => [s.symbol, s]));
    return monthly.map((instrument, i) =>
      toFuturesContract(root, instrument, bySymbol.get(instrument.symbol), i === 0),
    );
  }

  // -------------------------------------------------------------------------
  // Trading
  // -------------------------------------------------------------------------

  async previewOrder(userId: string, order: OrderRequest): Promise<OrderPreview> {
    const resolved = await this.resolveContract(userId, order);
    const price =
      order.orderType === 'market'
        ? resolved.last
        : computeMid(resolved.bid, resolved.ask);

    let estBuyingPower: number;
    try {
      const preview = await this.client.previewOrder(
        userId,
        await this.buildNewOrder(userId, order, resolved, price, 'preview'),
      );
      const estimated = num(
        (preview as { estimated_cost?: unknown }).estimated_cost,
        NaN,
      );
      estBuyingPower = Number.isFinite(estimated)
        ? estimated
        : localEstimate(order, resolved.contractSymbol, price);
    } catch (err) {
      this.logger.warn(
        `Webull preview failed, using local estimate: ${(err as Error).message}`,
      );
      estBuyingPower = localEstimate(order, resolved.contractSymbol, price);
    }

    const warnings: string[] = [];
    if (
      order.assetClass === 'option' &&
      resolved.expiration === ymdUtc(new Date())
    ) {
      warnings.push('0DTE contract — expires today');
    }
    if (order.assetClass === 'option' && order.orderType === 'market') {
      warnings.push('Market order on an option contract — fills at last price');
    }
    const available = await this.availableBuyingPower(userId, order);
    if (available !== undefined && estBuyingPower > available) {
      warnings.push(
        `Estimated buying power ${estBuyingPower} exceeds available ${available}`,
      );
    }
    return {
      resolved: { contractSymbol: resolved.contractSymbol, price, estBuyingPower },
      warnings,
    };
  }

  async placeOrder(
    userId: string,
    order: OrderRequest,
    idempotencyKey: string,
  ): Promise<OrderResult> {
    const resolved = await this.resolveContract(userId, order);
    const price =
      order.orderType === 'market'
        ? resolved.last
        : computeMid(resolved.bid, resolved.ask);

    // Deterministic 32-char id from the app's idempotency key gives
    // broker-side idempotency on top of the OrderAudit replay.
    const clientOrderId = createHash('md5').update(idempotencyKey).digest('hex');

    await this.client.placeOrder(
      userId,
      await this.buildNewOrder(userId, order, resolved, price, clientOrderId),
    );

    const result: OrderResult = {
      orderId: clientOrderId,
      status: 'submitted',
      contractSymbol: resolved.contractSymbol,
      side: order.side,
      quantity: order.quantity,
      orderType: order.orderType,
      ...(order.orderType === 'mid' ? { limitPrice: price } : {}),
      timestamp: new Date().toISOString(),
    };
    this.events.emit(userId, result);
    this.scheduleStatusPolls(userId, result);
    return result;
  }

  async cancelOrder(userId: string, orderId: string): Promise<void> {
    try {
      await this.client.cancelOrder(userId, orderId);
    } catch (err) {
      const message = (err as Error).message?.toLowerCase() ?? '';
      if (message.includes('not exist') || message.includes('not found')) {
        throw brokerErrors.orderNotFound(orderId);
      }
      if (message.includes('cancel') && message.includes('status')) {
        throw brokerErrors.orderNotOpen(orderId, 'unknown');
      }
      throw err;
    }
  }

  async getOpenOrders(userId: string): Promise<OrderResult[]> {
    const orders = await this.client.getOpenOrders(userId);
    return orders
      .map(toOrderResult)
      .filter((o) => o.status === 'submitted' || o.status === 'partially_filled');
  }

  async getPositions(userId: string): Promise<Position[]> {
    const positions = await this.client.getPositions(userId);
    return positions
      .map(toPosition)
      .filter((p): p is Position => p !== null && p.quantity !== 0);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Valid expirations for an underlying: the mock's candidate dates
   * (today/+1d/weekly/monthly) filtered by probing one ATM call per candidate
   * — Webull has no chain endpoint, so existence is proven by quote data.
   */
  private async probeExpirations(
    userId: string,
    underlying: string,
    price: number,
  ): Promise<string[]> {
    const candidates = mockOptionExpirations(new Date());
    const increment = price < 250 ? 1 : 5;
    const atm = Math.round(price / increment) * increment;
    const probes = candidates.map((exp) => ({
      exp,
      occ: formatOccSymbol(underlying, exp, 'call', atm),
    }));
    const snaps = await this.client.getOptionSnapshots(
      userId,
      probes.map((p) => p.occ),
    );
    const found = new Set(snaps.map((s) => s.symbol));
    const valid = probes.filter((p) => found.has(p.occ)).map((p) => p.exp);
    if (valid.length === 0) {
      throw brokerErrors.contractNotFound(
        `No option expirations found for ${underlying} — market data may be unavailable`,
      );
    }
    return valid;
  }

  /** Resolves any OrderRequest to a concrete, quoted contract (mirrors mock). */
  private async resolveContract(
    userId: string,
    order: OrderRequest,
  ): Promise<{
    contractSymbol: string;
    bid: number;
    ask: number;
    last: number;
    expiration?: string;
  }> {
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
          : findExplicitOption(
              chain.contracts,
              optionType,
              order.selection.strike ?? NaN,
            );
      if (!contract) {
        throw brokerErrors.contractNotFound(
          `No ${optionType} contract at strike ${order.selection.strike} ` +
            `for ${order.underlying} ${chain.expirations[0]}`,
        );
      }
      return {
        contractSymbol: contract.symbol,
        bid: contract.bid,
        ask: contract.ask,
        last: contract.last,
        expiration: contract.expiration,
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
      expiration: contract.expiration,
    };
  }

  /** Builds the Webull new_orders[0] payload for preview/place. */
  private async buildNewOrder(
    userId: string,
    order: OrderRequest,
    resolved: { contractSymbol: string; expiration?: string },
    price: number,
    clientOrderId: string,
  ): Promise<Record<string, unknown>> {
    const base: Record<string, unknown> = {
      client_order_id: clientOrderId,
      combo_type: 'NORMAL',
      entrust_type: 'QTY',
      market: 'US',
      side: order.side.toUpperCase(),
      order_type: order.orderType === 'market' ? 'MARKET' : 'LIMIT',
      quantity: String(order.quantity),
      time_in_force: 'DAY',
    };
    if (order.orderType === 'mid') {
      base.limit_price = price.toFixed(2);
    }

    if (order.assetClass === 'option') {
      const occ = parseOccSymbol(resolved.contractSymbol)!;
      return {
        ...base,
        instrument_type: 'OPTION',
        symbol: occ.underlying,
        option_strategy: 'SINGLE',
        position_intent: await this.positionIntent(
          userId,
          resolved.contractSymbol,
          order.side,
        ),
        legs: [
          {
            symbol: occ.underlying,
            strike_price: String(occ.strike),
            option_expire_date: occ.expiration,
            option_type: occ.optionType.toUpperCase(),
          },
        ],
      };
    }
    return {
      ...base,
      instrument_type: 'FUTURES',
      symbol: toWebullFuturesSymbol(resolved.contractSymbol),
    };
  }

  /** BUY closes an existing short, SELL closes an existing long; else opens. */
  private async positionIntent(
    userId: string,
    contractSymbol: string,
    side: 'buy' | 'sell',
  ): Promise<string> {
    let existingQty = 0;
    try {
      const positions = await this.getPositions(userId);
      existingQty =
        positions.find((p) => p.symbol === contractSymbol)?.quantity ?? 0;
    } catch {
      // Position lookup is best-effort; default to opening.
    }
    if (side === 'buy') {
      return existingQty < 0 ? 'BUY_TO_CLOSE' : 'BUY_TO_OPEN';
    }
    return existingQty > 0 ? 'SELL_TO_CLOSE' : 'SELL_TO_OPEN';
  }

  /** Available buying power from the balance endpoint (best-effort). */
  private async availableBuyingPower(
    userId: string,
    order: OrderRequest,
  ): Promise<number | undefined> {
    try {
      const balance = (await this.client.getBalance(userId)) as {
        account_currency_assets?: {
          buying_power?: unknown;
          option_buying_power?: unknown;
        }[];
        buying_power?: unknown;
      };
      const assets = balance.account_currency_assets?.[0];
      const raw =
        order.assetClass === 'option'
          ? assets?.option_buying_power ?? assets?.buying_power
          : assets?.buying_power ?? balance.buying_power;
      const value = num(raw, NaN);
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Polls order detail shortly after placement and emits status transitions
   * through OrderEventsService so WebSocket orderUpdate messages keep working
   * (the gRPC events push is a future upgrade).
   */
  private scheduleStatusPolls(userId: string, placed: OrderResult): void {
    let lastStatus = placed.status;
    for (const delay of STATUS_POLL_DELAYS) {
      const timer = setTimeout(() => {
        this.pollTimers.delete(timer);
        if (lastStatus === 'filled' || lastStatus === 'cancelled' || lastStatus === 'rejected') {
          return;
        }
        this.client
          .getOrderDetail(userId, placed.orderId)
          .then((detail) => {
            const mapped = toOrderResult(detail);
            if (mapped.status === lastStatus && !mapped.filledPrice) return;
            lastStatus = mapped.status;
            this.events.emit(userId, {
              ...mapped,
              orderId: placed.orderId,
              contractSymbol: placed.contractSymbol,
              side: placed.side,
              orderType: placed.orderType,
              quantity: mapped.quantity || placed.quantity,
            });
          })
          .catch((err) =>
            this.logger.warn(
              `Order status poll failed for ${placed.orderId}: ${(err as Error).message}`,
            ),
          );
      }, delay);
      timer.unref?.();
      this.pollTimers.add(timer);
    }
  }
}

function localEstimate(
  order: OrderRequest,
  contractSymbol: string,
  price: number,
): number {
  return (
    Math.round(
      estimateBuyingPower(order.assetClass, contractSymbol, order.quantity, price) *
        100,
    ) / 100
  );
}
