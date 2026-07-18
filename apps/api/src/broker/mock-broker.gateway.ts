import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
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
  FUTURES_SPECS,
  OPTION_MULTIPLIER,
  parseOccSymbol,
  resolveAutoOtm,
} from './contract-resolution';
import {
  optionExpirations,
  thirdFriday,
  todayUtc,
  ymd,
} from './expiration-calendar';
import { OrderEventsService } from './order-events.service';

/** Fixed mock buying power per user (docs/WEBULL-INTEGRATION.md §4). */
export const MOCK_BUYING_POWER = 25_000;

/** Delay before a mid order fills, per the mock contract. */
const MID_FILL_DELAY_MS = 200;

const MONTH_CODES = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];
const QUARTERLY_MONTHS = [3, 6, 9, 12];

// ---------------------------------------------------------------------------
// Deterministic PRNG utilities
// ---------------------------------------------------------------------------

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Date helpers (calendar-aware ones live in expiration-calendar.ts)
// ---------------------------------------------------------------------------

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Next `count` quarterly futures contract months whose expiry has not passed. */
function nextQuarterlyContracts(
  now: Date,
  count: number,
): { year: number; month: number }[] {
  const today = todayUtc(now);
  const out: { year: number; month: number }[] = [];
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1;
  while (out.length < count) {
    if (
      QUARTERLY_MONTHS.includes(month) &&
      thirdFriday(year, month).getTime() >= today.getTime()
    ) {
      out.push({ year, month });
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

function futuresSymbol(root: string, year: number, month: number): string {
  return `${root}${MONTH_CODES[month - 1]}${String(year % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

interface WalkState {
  rng: () => number;
  seed: number;
  price: number;
  tick: number;
}

interface StoredOrder extends OrderResult {
  timer?: NodeJS.Timeout;
}

interface PositionAgg {
  assetClass: 'option' | 'future';
  quantity: number; // signed
  avgPrice: number;
}

/**
 * Deterministic mock broker (docs/WEBULL-INTEGRATION.md §4):
 * - Random walk per symbol, seeded by symbol name, advanced once per
 *   wall-clock second (lazy), so prices are stable within a process run.
 * - Synthetic option chains: $1 strikes under $250, $5 above; expirations
 *   today/+1d/weekly/monthly.
 * - Synthetic front + deferred futures for ES/MES/NQ/MNQ/CL/GC.
 * - Market orders fill immediately at last; mid orders fill at mid after
 *   200 ms; cancel transitions to cancelled. Positions update on fills.
 * - $25,000 fixed buying power per user.
 */
@Injectable()
export class MockBrokerGateway implements BrokerGateway, OnModuleDestroy {
  private readonly logger = new Logger(MockBrokerGateway.name);
  private readonly walks = new Map<string, WalkState>();
  private readonly orders = new Map<string, Map<string, StoredOrder>>();
  private readonly positions = new Map<string, Map<string, PositionAgg>>();
  private orderCounter = 0;

  constructor(private readonly events: OrderEventsService) {}

  onModuleDestroy(): void {
    for (const byId of this.orders.values()) {
      for (const order of byId.values()) {
        if (order.timer) clearTimeout(order.timer);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Market data
  // -------------------------------------------------------------------------

  async getQuote(_userId: string, symbol: string): Promise<Quote> {
    const occ = parseOccSymbol(symbol);
    if (occ) {
      const { bid, ask, last } = this.priceOption(
        occ.underlying,
        occ.expiration,
        occ.strike,
        occ.optionType,
      );
      return this.assembleQuote(symbol, bid, ask, last);
    }
    const root = futuresRootOf(symbol);
    const base = root ? FUTURES_SPECS[root].base : 20 + (fnv1a(symbol) % 481);
    const price = this.walkPrice(symbol, base);
    const half = Math.max(0.01, round2(price * 0.0002));
    return this.assembleQuote(symbol, round2(price - half), round2(price + half), price);
  }

  async getCandles(
    _userId: string,
    symbol: string,
    req: CandleRequest,
  ): Promise<Candle[]> {
    const intervalMs = this.intervalMs(req.interval);
    const now = Date.now();
    const to = req.to ? Date.parse(req.to) : now;
    const from = req.from ? Date.parse(req.from) : to - 200 * intervalMs;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      return [];
    }
    const seed = fnv1a(`${symbol}|${req.interval}`);
    const base = futuresRootOf(symbol)
      ? FUTURES_SPECS[futuresRootOf(symbol)!].base
      : 20 + (fnv1a(symbol) % 481);

    const firstBucket = Math.floor(from / intervalMs);
    const lastBucket = Math.floor(to / intervalMs);
    const count = Math.min(lastBucket - firstBucket, 500);
    const candles: Candle[] = [];
    for (let b = lastBucket - count; b < lastBucket; b++) {
      const rng = mulberry32(seed ^ b);
      const phase = (seed % 628) / 100;
      const level =
        base * (1 + 0.08 * Math.sin(b / 17 + phase) + 0.02 * Math.sin(b / 5 + phase * 2));
      const open = round2(level * (1 + (rng() - 0.5) * 0.004));
      const close = round2(level * (1 + (rng() - 0.5) * 0.004));
      const high = round2(Math.max(open, close) * (1 + rng() * 0.002));
      const low = round2(Math.min(open, close) * (1 - rng() * 0.002));
      candles.push({
        time: new Date(b * intervalMs).toISOString(),
        open,
        high,
        low,
        close,
        volume: Math.floor(rng() * 1_000_000),
      });
    }
    return candles;
  }

  async getOptionsChain(
    userId: string,
    symbol: string,
    expiration?: string,
  ): Promise<OptionsChain> {
    const expirations = optionExpirations(symbol, new Date());
    const chosen = expiration ?? expirations[0];
    if (!expirations.includes(chosen)) {
      throw brokerErrors.contractNotFound(
        `No chain for expiration ${chosen}. Available: ${expirations.join(', ')}`,
      );
    }
    const quote = await this.getQuote(userId, symbol);
    const price = quote.last;
    const increment = price < 250 ? 1 : 5;
    const atm = Math.round(price / increment) * increment;

    const contracts: OptionContract[] = [];
    for (let k = -24; k <= 24; k++) {
      const strike = round2(atm + k * increment);
      for (const optionType of ['call', 'put'] as OptionType[]) {
        const px = this.priceOption(symbol, chosen, strike, optionType);
        contracts.push({
          symbol: formatOccSymbol(symbol, chosen, optionType, strike),
          underlying: symbol.toUpperCase(),
          expiration: chosen,
          strike,
          optionType,
          bid: px.bid,
          ask: px.ask,
          last: px.last,
        });
      }
    }
    return {
      underlying: symbol.toUpperCase(),
      underlyingPrice: price,
      expirations,
      contracts,
    };
  }

  async getFuturesContracts(
    _userId: string,
    root: string,
  ): Promise<FuturesContract[]> {
    const spec = FUTURES_SPECS[root.toUpperCase()];
    if (!spec) {
      throw brokerErrors.contractNotFound(
        `Unknown futures root: ${root}. Supported: ${Object.keys(FUTURES_SPECS).join(', ')}`,
      );
    }
    const now = new Date();
    return nextQuarterlyContracts(now, 2).map(({ year, month }, i) => {
      const symbol = futuresSymbol(root.toUpperCase(), year, month);
      const price = this.walkPrice(symbol, spec.base);
      const half = Math.max(0.01, round2(price * 0.0002));
      return {
        symbol,
        root: root.toUpperCase(),
        expiration: ymd(thirdFriday(year, month)),
        frontMonth: i === 0,
        bid: round2(price - half),
        ask: round2(price + half),
        last: price,
      };
    });
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
    const estBuyingPower = round2(
      estimateBuyingPower(
        order.assetClass,
        resolved.contractSymbol,
        order.quantity,
        price,
      ),
    );

    const warnings: string[] = [];
    if (
      order.assetClass === 'option' &&
      resolved.expiration === ymd(todayUtc(new Date()))
    ) {
      warnings.push('0DTE contract — expires today');
    }
    if (order.assetClass === 'option' && order.orderType === 'market') {
      warnings.push('Market order on an option contract — fills at last price');
    }
    if (estBuyingPower > MOCK_BUYING_POWER) {
      warnings.push(
        `Estimated buying power ${estBuyingPower} exceeds available ${MOCK_BUYING_POWER}`,
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
    _idempotencyKey: string,
  ): Promise<OrderResult> {
    const resolved = await this.resolveContract(userId, order);
    const limitOrFill =
      order.orderType === 'market'
        ? resolved.last
        : computeMid(resolved.bid, resolved.ask);

    const cost = estimateBuyingPower(
      order.assetClass,
      resolved.contractSymbol,
      order.quantity,
      limitOrFill,
    );
    if (cost > MOCK_BUYING_POWER) {
      throw brokerErrors.insufficientBuyingPower(
        `Order requires ~${round2(cost)} but only ${MOCK_BUYING_POWER} available`,
      );
    }

    const record: StoredOrder = {
      orderId: `MOCK-${String(++this.orderCounter).padStart(6, '0')}`,
      status: 'submitted',
      contractSymbol: resolved.contractSymbol,
      side: order.side,
      quantity: order.quantity,
      orderType: order.orderType,
      timestamp: new Date().toISOString(),
    };
    this.userOrders(userId).set(record.orderId, record);

    if (order.orderType === 'market') {
      record.status = 'filled';
      record.filledPrice = resolved.last;
      this.applyFill(userId, order.assetClass, record.contractSymbol, order.side, order.quantity, resolved.last);
      this.events.emit(userId, this.publicOrder(record));
      return this.publicOrder(record);
    }

    // mid: rest at the mid, fill at mid after a short delay.
    record.limitPrice = limitOrFill;
    this.events.emit(userId, this.publicOrder(record));
    record.timer = setTimeout(() => {
      record.timer = undefined;
      if (record.status !== 'submitted') return;
      try {
        const { bid, ask } = this.quoteForContract(record.contractSymbol);
        record.filledPrice = computeMid(bid, ask);
      } catch {
        record.filledPrice = record.limitPrice;
      }
      record.status = 'filled';
      this.applyFill(userId, order.assetClass, record.contractSymbol, record.side, record.quantity, record.filledPrice!);
      this.events.emit(userId, this.publicOrder(record));
    }, MID_FILL_DELAY_MS);
    record.timer.unref?.();
    return this.publicOrder(record);
  }

  async cancelOrder(userId: string, orderId: string): Promise<void> {
    const record = this.userOrders(userId).get(orderId);
    if (!record) throw brokerErrors.orderNotFound(orderId);
    if (record.status !== 'submitted' && record.status !== 'partially_filled') {
      throw brokerErrors.orderNotOpen(orderId, record.status);
    }
    if (record.timer) {
      clearTimeout(record.timer);
      record.timer = undefined;
    }
    record.status = 'cancelled';
    this.events.emit(userId, this.publicOrder(record));
  }

  async getOpenOrders(userId: string): Promise<OrderResult[]> {
    return [...this.userOrders(userId).values()]
      .filter((o) => o.status === 'submitted' || o.status === 'partially_filled')
      .map((o) => this.publicOrder(o));
  }

  async getPositions(userId: string): Promise<Position[]> {
    const positions = this.positions.get(userId);
    if (!positions) return [];
    const out: Position[] = [];
    for (const [symbol, agg] of positions) {
      if (agg.quantity === 0) continue;
      const { last } = this.quoteForContract(symbol);
      const multiplier =
        agg.assetClass === 'option'
          ? OPTION_MULTIPLIER
          : FUTURES_SPECS[futuresRootOf(symbol) ?? '']?.multiplier ?? 1;
      out.push({
        symbol,
        assetClass: agg.assetClass,
        quantity: agg.quantity,
        avgPrice: round2(agg.avgPrice),
        markPrice: last,
        unrealizedPnl: round2((last - agg.avgPrice) * agg.quantity * multiplier),
        multiplier,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Resolves any OrderRequest to a concrete, quoted contract. */
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

  /** Current quote for a resolved contract symbol (option OCC or futures). */
  private quoteForContract(symbol: string): {
    bid: number;
    ask: number;
    last: number;
  } {
    const occ = parseOccSymbol(symbol);
    if (occ) {
      return this.priceOption(occ.underlying, occ.expiration, occ.strike, occ.optionType);
    }
    const root = futuresRootOf(symbol);
    if (root) {
      const price = this.walkPrice(symbol, FUTURES_SPECS[root].base);
      const half = Math.max(0.01, round2(price * 0.0002));
      return { bid: round2(price - half), ask: round2(price + half), last: price };
    }
    throw brokerErrors.contractNotFound(`Unknown contract symbol: ${symbol}`);
  }

  /** Deterministic option price from the underlying's current price. */
  private priceOption(
    underlying: string,
    expiration: string,
    strike: number,
    optionType: OptionType,
  ): { bid: number; ask: number; last: number } {
    const root = futuresRootOf(underlying);
    const base = root
      ? FUTURES_SPECS[root].base
      : 20 + (fnv1a(underlying) % 481);
    const price = this.walkPrice(underlying, base);

    const [y, m, d] = expiration.split('-').map(Number);
    const expDate = new Date(Date.UTC(y, m - 1, d));
    const dte = Math.max(daysBetween(todayUtc(new Date()), expDate), 0);
    const tYears = Math.max(dte, 1 / 24) / 365; // 0DTE ≈ one hour of life
    const sigT = price * 0.25 * Math.sqrt(tYears);
    const intrinsic =
      optionType === 'call'
        ? Math.max(0, price - strike)
        : Math.max(0, strike - price);
    const x = (strike - price) / sigT;
    const timeValue = sigT * 0.39894228 * Math.exp(-0.5 * x * x);

    const last = Math.max(0.01, round2(intrinsic + timeValue));
    const half = Math.max(0.01, round2(last * 0.02));
    const bid = Math.max(0.01, round2(last - half));
    let ask = round2(last + half);
    if (ask <= bid) ask = round2(bid + 0.01);
    return { bid, ask, last };
  }

  /** Seeded random walk, advanced lazily once per wall-clock second. */
  private walkPrice(symbol: string, base: number): number {
    let state = this.walks.get(symbol);
    if (!state) {
      state = { rng: mulberry32(fnv1a(symbol)), seed: fnv1a(symbol), price: base, tick: 0 };
      this.walks.set(symbol, state);
    }
    const tick = Math.floor(Date.now() / 1000);
    if (state.tick !== tick) {
      const steps = Math.min(tick - state.tick, 300);
      for (let i = 0; i < steps; i++) {
        state.price = round2(
          Math.max(1, state.price * (1 + (state.rng() - 0.5) * 0.002)),
        );
      }
      state.tick = tick;
    }
    return state.price;
  }

  private assembleQuote(
    symbol: string,
    bid: number,
    ask: number,
    last: number,
  ): Quote {
    const tick = Math.floor(Date.now() / 1000);
    const rng = mulberry32(fnv1a(symbol) ^ tick);
    return {
      symbol,
      bid,
      ask,
      last,
      bidSize: 1 + Math.floor(rng() * 50),
      askSize: 1 + Math.floor(rng() * 50),
      volume: Math.floor(rng() * 10_000_000),
      timestamp: new Date(tick * 1000).toISOString(),
    };
  }

  private applyFill(
    userId: string,
    assetClass: 'option' | 'future',
    contractSymbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    fillPrice: number,
  ): void {
    let userPositions = this.positions.get(userId);
    if (!userPositions) {
      userPositions = new Map();
      this.positions.set(userId, userPositions);
    }
    const signed = side === 'buy' ? quantity : -quantity;
    const pos = userPositions.get(contractSymbol) ?? {
      assetClass,
      quantity: 0,
      avgPrice: 0,
    };
    const oldQty = pos.quantity;
    const newQty = oldQty + signed;

    if (newQty === 0) {
      userPositions.delete(contractSymbol);
      return;
    }
    if (oldQty === 0 || Math.sign(oldQty) === Math.sign(signed)) {
      // Increasing (or opening): weighted average price.
      pos.avgPrice =
        (Math.abs(oldQty) * pos.avgPrice + Math.abs(signed) * fillPrice) /
        (Math.abs(oldQty) + Math.abs(signed));
    } else if (Math.abs(signed) > Math.abs(oldQty)) {
      // Flipped through zero: remainder opens at the fill price.
      pos.avgPrice = fillPrice;
    }
    // Reducing but not flipping keeps the existing average.
    pos.quantity = newQty;
    userPositions.set(contractSymbol, pos);
  }

  private userOrders(userId: string): Map<string, StoredOrder> {
    let byId = this.orders.get(userId);
    if (!byId) {
      byId = new Map();
      this.orders.set(userId, byId);
    }
    return byId;
  }

  private publicOrder(record: StoredOrder): OrderResult {
    const { timer: _timer, ...rest } = record;
    return { ...rest };
  }

  private intervalMs(interval: CandleRequest['interval']): number {
    switch (interval) {
      case '1m':
        return 60_000;
      case '5m':
        return 300_000;
      case '15m':
        return 900_000;
      case '1h':
        return 3_600_000;
      case '1d':
        return 86_400_000;
    }
  }
}
