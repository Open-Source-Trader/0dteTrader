import {
  Candle,
  OptionContract,
  OptionType,
  OptionsChain,
  OrderPreview,
  OrderRequest,
  OrderResult,
  Position,
  Quote,
  TradingMode,
  WebullAccount,
} from '@0dtetrader/shared-types';
import {
  computeMid,
  estimateBuyingPower,
  findExplicitOption,
  formatOccSymbol,
} from '../broker/contract-resolution';
import { optionExpirations } from '../broker/expiration-calendar';
import { BrokerGateway } from '../broker/broker-gateway.interface';
import { brokerErrors } from '../common/broker-error';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { OrderEventsService } from '../broker/order-events.service';
import { OrderRequestDto } from './dto/order-request.dto';
import { OrdersService } from './orders.service';
import { TradingService } from './trading.service';

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Minimal BrokerGateway test double with a fixed quote (last = 100) and a
 * deterministic ±24-strike chain built from the real expiration calendar, so
 * TradingService's server-side re-validation is exercised against stable data.
 * Market orders fill at last; mid orders rest submitted at the mid.
 */
class StubBrokerGateway implements BrokerGateway {
  static readonly PRICE = 100;
  private readonly orders = new Map<string, OrderResult>();
  private counter = 0;

  async getQuote(_userId: string, symbol: string): Promise<Quote> {
    return {
      symbol,
      bid: StubBrokerGateway.PRICE - 0.02,
      ask: StubBrokerGateway.PRICE + 0.02,
      last: StubBrokerGateway.PRICE,
      bidSize: 10,
      askSize: 10,
      volume: 1_000_000,
      timestamp: new Date().toISOString(),
    };
  }

  async getCandles(): Promise<Candle[]> {
    return [];
  }

  async listAccounts(): Promise<WebullAccount[]> {
    return [];
  }

  async selectAccount(): Promise<void> {}

  async reauthenticate(): Promise<TradingMode> {
    return 'live';
  }

  async getOptionsChain(
    _userId: string,
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
        bid: resolved.bid,
        ask: resolved.ask,
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
    const result: OrderResult = {
      orderId: `STUB-${String(++this.counter).padStart(6, '0')}`,
      status: 'submitted',
      contractSymbol: resolved.contractSymbol,
      side: order.side,
      quantity: order.quantity,
      orderType: order.orderType,
      timestamp: new Date().toISOString(),
    };
    if (order.orderType === 'market') {
      result.status = 'filled';
      result.filledPrice = resolved.last;
    } else {
      result.limitPrice = computeMid(resolved.bid, resolved.ask);
    }
    this.orders.set(result.orderId, result);
    return result;
  }

  async cancelOrder(_userId: string, orderId: string): Promise<void> {
    const record = this.orders.get(orderId);
    if (!record) throw brokerErrors.orderNotFound(orderId);
    if (record.status !== 'submitted' && record.status !== 'partially_filled') {
      throw brokerErrors.orderNotOpen(orderId, record.status);
    }
    record.status = 'cancelled';
  }

  async getOpenOrders(): Promise<OrderResult[]> {
    return [...this.orders.values()].filter(
      (o) => o.status === 'submitted' || o.status === 'partially_filled',
    );
  }

  async getPositions(): Promise<Position[]> {
    return [];
  }

  private async resolveContract(userId: string, order: OrderRequest) {
    const { optionType } = order.selection;
    if (!optionType) {
      throw brokerErrors.orderRejected('selection.optionType is required for option orders');
    }
    const chain = await this.getOptionsChain(userId, order.underlying, order.selection.expiration);
    const contract = findExplicitOption(chain.contracts, optionType, order.selection.strike ?? NaN);
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
}

function autoOtmCall(overrides: Partial<OrderRequestDto> = {}): OrderRequestDto {
  return {
    underlying: 'SPY',
    assetClass: 'option',
    side: 'buy',
    quantity: 1,
    orderType: 'market',
    selection: { mode: 'auto_otm', optionType: 'call' },
    ...overrides,
  } as OrderRequestDto;
}

describe('TradingService', () => {
  let prisma: InMemoryPrismaService;
  let gateway: StubBrokerGateway;
  let orders: OrdersService;
  let trading: TradingService;
  let userId: string;

  beforeEach(async () => {
    prisma = new InMemoryPrismaService();
    gateway = new StubBrokerGateway();
    orders = new OrdersService(
      prisma as unknown as ConstructorParameters<typeof OrdersService>[0],
      new OrderEventsService(),
    );
    trading = new TradingService(
      prisma as unknown as ConstructorParameters<typeof TradingService>[0],
      gateway as BrokerGateway,
      orders,
    );
    const user = await prisma.user.create({
      data: { email: 'trader@example.com', passwordHash: 'x' },
    });
    userId = user.id;
  });

  describe('auto_otm re-validation', () => {
    it('resolves +1 OTM strike from the live quote and normalizes to explicit', async () => {
      const placeSpy = jest.spyOn(gateway, 'placeOrder');
      const quote = await gateway.getQuote(userId, 'SPY');
      const chain = await gateway.getOptionsChain(userId, 'SPY');

      const result = await trading.place(userId, autoOtmCall(), 'idem-auto-1');
      expect(result.status).toBe('filled');

      // Server-side resolution: lowest call strike strictly above the last.
      const strikes = [
        ...new Set(chain.contracts.filter((c) => c.optionType === 'call').map((c) => c.strike)),
      ].sort((a, b) => a - b);
      const expected = strikes.find((s) => s > quote.last)!;
      const sent = placeSpy.mock.calls[0][1] as OrderRequest;
      expect(sent.selection.mode).toBe('explicit');
      expect(sent.selection.strike).toBe(expected);
      expect(sent.selection.expiration).toBe(chain.expirations[0]);
    });

    it('defaults a missing expiration to the nearest one', async () => {
      const preview = await trading.preview(userId, autoOtmCall());
      const chain = await gateway.getOptionsChain(userId, 'SPY');
      // OCC symbol encodes the expiration — must be the nearest.
      const nearest = chain.expirations[0].slice(2).replace(/-/g, '');
      expect(preview.resolved.contractSymbol.slice(3, 9)).toBe(nearest);
    });

    it('honors a requested valid expiration', async () => {
      const chain = await gateway.getOptionsChain(userId, 'SPY');
      const later = chain.expirations[chain.expirations.length - 1];
      const placeSpy = jest.spyOn(gateway, 'placeOrder');
      await trading.place(
        userId,
        autoOtmCall({
          selection: { mode: 'auto_otm', optionType: 'put', expiration: later },
        }),
        'idem-auto-2',
      );
      const sent = placeSpy.mock.calls[0][1] as OrderRequest;
      expect(sent.selection.expiration).toBe(later);
    });

    it('rejects an unavailable expiration with a validation error', async () => {
      await expect(
        trading.preview(
          userId,
          autoOtmCall({
            selection: { mode: 'auto_otm', optionType: 'call', expiration: '2030-01-18' },
          }),
        ),
      ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    });
  });

  describe('mid price', () => {
    it('mid orders carry the live (bid+ask)/2 as limit price', async () => {
      const quote = await gateway.getQuote(userId, 'SPY');
      const chain = await gateway.getOptionsChain(userId, 'SPY');
      const call = chain.contracts
        .filter((c) => c.optionType === 'call')
        .sort((a, b) => a.strike - b.strike)
        .find((c) => c.strike > quote.last)!;
      const expectedMid = Math.round(((call.bid + call.ask) / 2) * 100) / 100;

      const result = await trading.place(userId, autoOtmCall({ orderType: 'mid' }), 'idem-mid-1');
      expect(result.status).toBe('submitted');
      expect(result.limitPrice).toBe(expectedMid);
    });
  });

  describe('idempotency', () => {
    it('replays the original result for a duplicate Idempotency-Key without re-submitting', async () => {
      const placeSpy = jest.spyOn(gateway, 'placeOrder');
      const first = await trading.place(userId, autoOtmCall(), 'idem-123');
      const second = await trading.place(userId, autoOtmCall(), 'idem-123');

      expect(second).toEqual(first);
      expect(placeSpy).toHaveBeenCalledTimes(1);

      const audits = await prisma.orderAudit.findMany({ where: { userId } });
      const keyed = audits.filter((a) => a.idempotencyKey === 'idem-123');
      expect(keyed).toHaveLength(1);
      expect(keyed[0].status).toBe('filled');
    });

    it('different keys execute independently', async () => {
      const a = await trading.place(userId, autoOtmCall(), 'idem-a');
      const b = await trading.place(userId, autoOtmCall(), 'idem-b');
      expect(a.orderId).not.toBe(b.orderId);
    });

    it('rejects a duplicate while the first placement is still in flight', async () => {
      // Hold the broker call open so the pending claim row is observable.
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = gateway.placeOrder.bind(gateway);
      jest.spyOn(gateway, 'placeOrder').mockImplementation(async (u, o, k) => {
        await gate;
        return original(u, o, k);
      });

      const first = trading.place(userId, autoOtmCall(), 'idem-flight');
      // Let the first call reach the broker before firing the duplicate.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(trading.place(userId, autoOtmCall(), 'idem-flight')).rejects.toMatchObject({
        status: 409,
        code: 'ORDER_IN_FLIGHT',
      });

      release();
      const result = await first;
      expect(result.status).toBe('filled');
      // And once settled, the key replays the original result.
      await expect(trading.place(userId, autoOtmCall(), 'idem-flight')).resolves.toEqual(result);
    });

    it('frees the key when execution fails so the client can retry', async () => {
      jest.spyOn(gateway, 'placeOrder').mockRejectedValueOnce(new Error('broker down'));
      await expect(trading.place(userId, autoOtmCall(), 'idem-retry')).rejects.toThrow(
        'broker down',
      );

      const result = await trading.place(userId, autoOtmCall(), 'idem-retry');
      expect(result.status).toBe('filled');

      // The failure left only an unkeyed error audit behind.
      const audits = await prisma.orderAudit.findMany({ where: { userId } });
      expect(audits.filter((a) => a.idempotencyKey === 'idem-retry')).toHaveLength(1);
    });
  });

  describe('kill switch', () => {
    it('returns 403 TRADING_DISABLED and audit-logs the blocked attempt', async () => {
      prisma.setTradingDisabled(userId, true);
      await expect(trading.place(userId, autoOtmCall(), 'idem-blocked')).rejects.toMatchObject({
        status: 403,
        code: 'TRADING_DISABLED',
      });

      const audits = await prisma.orderAudit.findMany({ where: { userId } });
      expect(audits).toHaveLength(1);
      expect(audits[0].status).toBe('blocked');
      expect(audits[0].response.error.code).toBe('TRADING_DISABLED');
      // Blocked attempts do not consume the idempotency key.
      expect(audits[0].idempotencyKey).toBeNull();
    });

    it('blocks previews and cancels too', async () => {
      prisma.setTradingDisabled(userId, true);
      await expect(trading.preview(userId, autoOtmCall())).rejects.toMatchObject({
        status: 403,
        code: 'TRADING_DISABLED',
      });
      await expect(trading.cancel(userId, 'STUB-000001')).rejects.toMatchObject({
        status: 403,
        code: 'TRADING_DISABLED',
      });
    });
  });

  describe('auditing', () => {
    it('records every preview/place/cancel attempt', async () => {
      await trading.preview(userId, autoOtmCall());
      const placed = await trading.place(userId, autoOtmCall({ orderType: 'mid' }), 'idem-audit');
      await trading.cancel(userId, placed.orderId);

      const audits = await prisma.orderAudit.findMany({ where: { userId } });
      expect(audits.map((a) => a.request.action).sort()).toEqual(['cancel', 'place', 'preview']);
      expect(audits.every((a) => a.status === 'ok' || a.status === 'submitted')).toBe(true);
    });
  });

  describe('entry-line anchor', () => {
    /** Mirrors what the stub gateway would report after a market order fills. */
    function positionFor(contractSymbol: string, quantity: number): Position {
      return {
        symbol: contractSymbol,
        assetClass: 'option',
        quantity,
        avgPrice: 1,
        markPrice: 1,
        unrealizedPnl: 0,
        multiplier: 100,
      };
    }

    it('annotates a position with the underlying price its opening fill happened at', async () => {
      const placed = await trading.place(userId, autoOtmCall(), 'idem-anchor-1');
      jest
        .spyOn(gateway, 'getPositions')
        .mockResolvedValue([positionFor(placed.contractSymbol, 1)]);

      const [position] = await trading.getPositions(userId);
      // The stub quotes the underlying at a fixed 100 — that is the level the
      // chart's entry line must be drawn at.
      expect(position.underlyingEntryPrice).toBe(StubBrokerGateway.PRICE);
    });

    it('leaves a position unannotated when no fill of it recorded an underlying price', async () => {
      jest.spyOn(gateway, 'getPositions').mockResolvedValue([positionFor('SPY260717C00505000', 1)]);

      const [position] = await trading.getPositions(userId);
      expect(position.underlyingEntryPrice).toBeUndefined();
    });

    it('never fails a positions read because the anchor lookup failed', async () => {
      jest.spyOn(gateway, 'getPositions').mockResolvedValue([positionFor('SPY260717C00505000', 1)]);
      jest.spyOn(orders, 'positionAnchors').mockRejectedValue(new Error('db down'));

      await expect(trading.getPositions(userId)).resolves.toHaveLength(1);
    });
  });

  describe('post-placement bookkeeping', () => {
    /**
     * Once the broker accepts, a bookkeeping failure must not surface as a
     * thrown order. The catch deletes the idempotency claim so the caller can
     * retry — after a real placement that retry would submit a SECOND order.
     */
    it('returns the order when the audit write fails after the broker accepted', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      jest.spyOn(prisma.orderAudit, 'update').mockRejectedValueOnce(new Error('connection reset'));

      const result = await trading.place(userId, autoOtmCall(), 'idem-audit-fail');

      expect(place).toHaveBeenCalledTimes(1);
      expect(result.orderId).toBeTruthy();

      // The claim must survive the failed write. It still holds the result the
      // audit row never received, so a retry cannot replay — but the invariant
      // that matters is that it refuses rather than submitting a second order.
      await expect(trading.place(userId, autoOtmCall(), 'idem-audit-fail')).rejects.toMatchObject({
        code: 'ORDER_IN_FLIGHT',
      });
      expect(place).toHaveBeenCalledTimes(1);
    });
  });

  describe('validation', () => {
    it('requires optionType for option orders', async () => {
      await expect(
        trading.preview(userId, autoOtmCall({ selection: { mode: 'auto_otm' } })),
      ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    });

    it('requires strike for explicit option orders', async () => {
      await expect(
        trading.preview(
          userId,
          autoOtmCall({ selection: { mode: 'explicit', optionType: 'call' } }),
        ),
      ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    });
  });
});
