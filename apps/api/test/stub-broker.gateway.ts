import {
  Candle,
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
import { BrokerGateway } from '../src/broker/broker-gateway.interface';
import {
  computeMid,
  estimateBuyingPower,
  findExplicitOption,
  formatOccSymbol,
  OPTION_MULTIPLIER,
  resolveAutoOtm,
} from '../src/broker/contract-resolution';
import { optionExpirations } from '../src/broker/expiration-calendar';
import { brokerErrors } from '../src/common/broker-error';

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Delay before a mid order fills. */
const MID_FILL_DELAY_MS = 200;

interface StoredOrder extends OrderResult {
  timer?: NodeJS.Timeout;
}

interface PositionAgg {
  quantity: number; // signed
  avgPrice: number;
}

/**
 * Test-only BrokerGateway double for the e2e suite (app.e2e-spec.ts overrides
 * the BROKER_GATEWAY token with this). Deterministic: fixed underlying price,
 * chain from the real expiration calendar, market fills at last, mid fills at
 * mid after 200 ms, positions aggregate on fills. Never leaves the process.
 */
export class StubBrokerGateway implements BrokerGateway {
  static readonly PRICE = 100;

  private readonly orders = new Map<string, Map<string, StoredOrder>>();
  private readonly positions = new Map<string, Map<string, PositionAgg>>();
  private counter = 0;

  async getQuote(_userId: string, symbol: string): Promise<Quote> {
    const last = StubBrokerGateway.PRICE;
    return {
      symbol,
      bid: round2(last - 0.02),
      ask: round2(last + 0.02),
      last,
      bidSize: 10,
      askSize: 10,
      volume: 1_000_000,
      timestamp: new Date().toISOString(),
    };
  }

  async reauthenticate(): Promise<TradingMode> {
    return 'live';
  }

  async getCandles(_userId: string, symbol: string, req: CandleRequest): Promise<Candle[]> {
    void symbol;
    const intervalMs = {
      '1m': 60_000,
      '5m': 300_000,
      '15m': 900_000,
      '30m': 1_800_000,
      '1h': 3_600_000,
      '4h': 14_400_000,
      '1d': 86_400_000,
    }[req.interval];
    const lastBucket = Math.floor(Date.now() / intervalMs);
    const candles: Candle[] = [];
    for (let b = lastBucket - 50; b < lastBucket; b++) {
      const level = StubBrokerGateway.PRICE + Math.sin(b / 7) * 2;
      candles.push({
        time: new Date(b * intervalMs).toISOString(),
        open: round2(level - 0.1),
        high: round2(level + 0.2),
        low: round2(level - 0.2),
        close: round2(level + 0.1),
        volume: 100_000,
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
    const price = StubBrokerGateway.PRICE;
    const contracts: OptionContract[] = [];
    for (let k = -24; k <= 24; k++) {
      const strike = price + k;
      for (const optionType of ['call', 'put'] as OptionType[]) {
        const intrinsic =
          optionType === 'call' ? Math.max(0, price - strike) : Math.max(0, strike - price);
        const last = round2(intrinsic + 1);
        contracts.push({
          symbol: formatOccSymbol(symbol, chosen, optionType, strike),
          underlying: symbol.toUpperCase(),
          expiration: chosen,
          strike,
          optionType,
          bid: round2(last - 0.01),
          ask: round2(last + 0.01),
          last,
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

  async previewOrder(userId: string, order: OrderRequest): Promise<OrderPreview> {
    const resolved = await this.resolveContract(userId, order);
    const price =
      order.orderType === 'market' ? resolved.last : computeMid(resolved.bid, resolved.ask);
    return {
      resolved: {
        contractSymbol: resolved.contractSymbol,
        price,
        estBuyingPower: round2(estimateBuyingPower(order.quantity, price)),
      },
      warnings: [],
    };
  }

  async placeOrder(
    userId: string,
    order: OrderRequest,
    _idempotencyKey: string,
  ): Promise<OrderResult> {
    const resolved = await this.resolveContract(userId, order);
    const record: StoredOrder = {
      orderId: `STUB-${String(++this.counter).padStart(6, '0')}`,
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
      this.applyFill(userId, record.contractSymbol, order.side, order.quantity, resolved.last);
      return this.publicOrder(record);
    }

    record.limitPrice = computeMid(resolved.bid, resolved.ask);
    record.timer = setTimeout(() => {
      record.timer = undefined;
      if (record.status !== 'submitted') return;
      record.status = 'filled';
      record.filledPrice = record.limitPrice;
      this.applyFill(
        userId,
        record.contractSymbol,
        record.side,
        record.quantity,
        record.filledPrice!,
      );
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
      const last = StubBrokerGateway.PRICE;
      out.push({
        symbol,
        assetClass: 'option',
        quantity: agg.quantity,
        avgPrice: round2(agg.avgPrice),
        markPrice: last,
        unrealizedPnl: round2((last - agg.avgPrice) * agg.quantity * OPTION_MULTIPLIER),
        multiplier: OPTION_MULTIPLIER,
      });
    }
    return out;
  }

  private async resolveContract(userId: string, order: OrderRequest) {
    const { optionType } = order.selection;
    if (!optionType) {
      throw brokerErrors.orderRejected('selection.optionType is required for option orders');
    }
    const chain = await this.getOptionsChain(userId, order.underlying, order.selection.expiration);
    const contract =
      order.selection.mode === 'auto_otm'
        ? resolveAutoOtm(chain.contracts, optionType, chain.underlyingPrice)
        : findExplicitOption(chain.contracts, optionType, order.selection.strike ?? NaN);
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
    };
  }

  private applyFill(
    userId: string,
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
    const pos = userPositions.get(contractSymbol) ?? { quantity: 0, avgPrice: 0 };
    const oldQty = pos.quantity;
    const newQty = oldQty + signed;
    if (newQty === 0) {
      userPositions.delete(contractSymbol);
      return;
    }
    if (oldQty === 0 || Math.sign(oldQty) === Math.sign(signed)) {
      pos.avgPrice =
        (Math.abs(oldQty) * pos.avgPrice + Math.abs(signed) * fillPrice) /
        (Math.abs(oldQty) + Math.abs(signed));
    } else if (Math.abs(signed) > Math.abs(oldQty)) {
      pos.avgPrice = fillPrice;
    }
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
}
