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
import { Logger } from '@nestjs/common';
import {
  computeMid,
  estimateBuyingPower,
  findExplicitOption,
  formatOccSymbol,
} from '../broker/contract-resolution';
import { optionExpirations } from '../broker/expiration-calendar';
import { BrokerExecutionScope, BrokerGateway } from '../broker/broker-gateway.interface';
import { brokerErrors } from '../common/broker-error';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { OrderEventsService } from '../broker/order-events.service';
import { OrderRequestDto } from './dto/order-request.dto';
import { OrdersService } from './orders.service';
import { TradingService } from './trading.service';
import type { AutoCandidateRankingContext } from './auto-candidates.service';

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
    _expectedMode?: TradingMode,
    _heldQuantity?: number,
    resolvedContract?: OptionContract,
    _expectedScope?: BrokerExecutionScope,
  ): Promise<OrderResult> {
    const resolved = resolvedContract
      ? {
          contractSymbol: resolvedContract.symbol,
          bid: resolvedContract.bid,
          ask: resolvedContract.ask,
          last: resolvedContract.last,
        }
      : await this.resolveContract(userId, order);
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

  async getRecentOrders(
    _userId: string,
    since?: Date,
    _expectedScope?: BrokerExecutionScope,
  ): Promise<OrderResult[]> {
    return [...this.orders.values()].filter((order) => {
      if (!since) return true;
      const timestamp = Date.parse(order.timestamp);
      return !Number.isFinite(timestamp) || timestamp >= since.getTime();
    });
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
  let orderEvents: OrderEventsService;
  let trading: TradingService;
  let autoCandidates: { rankResolved: jest.Mock };
  let userId: string;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    prisma = new InMemoryPrismaService();
    gateway = new StubBrokerGateway();
    orderEvents = new OrderEventsService();
    orders = new OrdersService(
      prisma as unknown as ConstructorParameters<typeof OrdersService>[0],
      orderEvents,
      gateway as BrokerGateway,
    );
    autoCandidates = { rankResolved: jest.fn() };
    trading = new TradingService(
      prisma as unknown as ConstructorParameters<typeof TradingService>[0],
      gateway as BrokerGateway,
      orders,
      orderEvents,
      autoCandidates as never,
    );
    const user = await prisma.user.create({
      data: { email: 'trader@example.com', passwordHash: 'x' },
    });
    userId = user.id;
    prisma.acceptCurrentTradingLegal(userId);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('auto_otm re-validation', () => {
    it('resolves +1 OTM strike from the live quote and normalizes to explicit', async () => {
      const placeSpy = jest.spyOn(gateway, 'placeOrder');
      const quote = await gateway.getQuote(userId, 'SPY');
      const chain = await gateway.getOptionsChain(userId, 'SPY');

      const result = await trading.place(userId, autoOtmCall(), 'idem-auto-1');
      expect(result.status).toBe('filled');

      // Server-side resolution: the stub's last sits exactly on a strike, so
      // that strike is the ATM anchor and the default offset steps one out.
      const sent = placeSpy.mock.calls[0][1] as OrderRequest;
      expect(sent.selection.mode).toBe('explicit');
      expect(sent.selection.strike).toBe(quote.last + 1);
      expect(sent.selection.expiration).toBe(chain.expirations[0]);
    });

    it('records the placement quote under the immutable execution account scope', async () => {
      (gateway as BrokerGateway).executionScope = jest.fn(async () => ({
        provider: 'webull' as const,
        environment: 'live' as const,
        accountId: 'broker-account-42',
      }));

      const result = await trading.place(userId, autoOtmCall(), 'idem-scoped-anchor');

      expect(prisma.tradeOrders).toHaveLength(1);
      expect(prisma.tradeOrders[0]).toMatchObject({
        provider: 'webull',
        environment: 'live',
        accountId: 'broker-account-42',
        clientOrderId: result.orderId,
        underlyingPrice: StubBrokerGateway.PRICE,
      });
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

  describe('scored Auto authoritative re-ranking', () => {
    const autoPreferences = {
      schemaVersion: 1 as const,
      preset: 'conservative' as const,
      targetAbsDelta: 0.25,
      strikeRungs: 5,
      maxSpreadBps: 500,
      maxPremiumDollars: 250,
      minOpenInterest: 100,
      gammaMode: 'avoid' as const,
      weights: { delta: 0.3, spread: 0.25, openInterest: 0.2, gamma: 0.1, iv: 0.15 },
    };

    function scoredRequest(selectedSymbol: string): OrderRequestDto {
      return {
        underlying: 'SPY',
        assetClass: 'option',
        side: 'buy',
        quantity: 1,
        orderType: 'mid',
        selection: {
          mode: 'auto_scored',
          optionType: 'call',
          expiration: '2026-08-05',
          autoScoring: {
            selectedSymbol,
            preferences: autoPreferences,
            scoredConfirmationAccepted: true,
            rankedAt: '2026-08-05T15:00:00.000Z',
          },
        },
      } as OrderRequestDto;
    }

    function rerank(selectedSymbol: string | null): AutoCandidateRankingContext {
      const contract: OptionContract = {
        symbol: selectedSymbol ?? 'SPY260805C00500000',
        underlying: 'SPY',
        expiration: '2026-08-05',
        strike: selectedSymbol?.includes('501') ? 501 : 500,
        optionType: 'call',
        bid: 2,
        ask: 2.1,
        last: 2.05,
        quoteTimestamp: new Date().toISOString(),
      };
      return {
        result: selectedSymbol
          ? {
              selectedSymbol,
              noPass: false,
              requiresConfirmation: true,
              rankedAt: new Date().toISOString(),
              exclusions: [],
              rankings: [
                {
                  rank: 1,
                  candidate: {
                    ...contract,
                    quoteTimestamp: contract.quoteTimestamp ?? null,
                    delta: 0.25,
                    gamma: 0.01,
                    impliedVolatility: 0.2,
                    openInterest: 100,
                    quoteProvider: 'webull',
                    analyticsTimestamp: new Date().toISOString(),
                  },
                  score: 1,
                  rationale: {
                    summary: 'winner',
                    mid: 2.05,
                    spreadBps: 100,
                    premiumDollars: 205,
                    atmDistance: 0,
                    normalized: { delta: 1, spread: 1, openInterest: 1, gamma: 1, iv: 1 },
                    weighted: { delta: 0.3, spread: 0.25, openInterest: 0.2, gamma: 0.1, iv: 0.15 },
                  },
                },
              ],
            }
          : {
              selectedSymbol: null,
              noPass: true,
              requiresConfirmation: true,
              rankedAt: new Date().toISOString(),
              exclusions: [],
              rankings: [],
            },
        selectedContract: selectedSymbol ? contract : null,
        underlyingPrice: 500,
      };
    }

    it('rejects when the fresh winner changed before broker acceptance', async () => {
      autoCandidates.rankResolved.mockResolvedValue(rerank('SPY260805C00501000'));
      const place = jest.spyOn(gateway, 'placeOrder');

      await expect(
        trading.place(userId, scoredRequest('SPY260805C00500000'), 'scored-changed'),
      ).rejects.toMatchObject({ code: 'AUTO_SCORING_SELECTION_CHANGED' });
      expect(place).not.toHaveBeenCalled();
      expect(trading.metrics).toMatchObject({
        scoredReranks: 1,
        scoredSelectionChanges: 1,
        scoredNoPassRejections: 0,
      });
      expect(Logger.prototype.log).toHaveBeenCalledWith(
        expect.stringContaining('"outcome":"selection_changed"'),
      );
    });

    it('rejects a fresh no-pass result without entering the broker', async () => {
      const staleNoPass = rerank(null);
      staleNoPass.result.exclusions = [{ symbol: 'SPY260805C00500000', reason: 'stale_quote' }];
      autoCandidates.rankResolved.mockResolvedValue(staleNoPass);
      const place = jest.spyOn(gateway, 'placeOrder');

      await expect(
        trading.place(userId, scoredRequest('SPY260805C00500000'), 'scored-no-pass'),
      ).rejects.toMatchObject({ code: 'AUTO_SCORING_NO_PASS' });
      expect(place).not.toHaveBeenCalled();
      expect(trading.metrics).toMatchObject({
        scoredReranks: 1,
        scoredSelectionChanges: 0,
        scoredNoPassRejections: 1,
        scoredStaleRejections: 1,
      });
      expect(Logger.prototype.log).toHaveBeenCalledWith(
        expect.stringContaining('"outcome":"no_pass"'),
      );
    });

    it('sends only the exact freshly reranked contract as explicit', async () => {
      const selectedSymbol = 'SPY260805C00500000';
      autoCandidates.rankResolved.mockResolvedValue(rerank(selectedSymbol));
      const place = jest.spyOn(gateway, 'placeOrder');

      await trading.place(userId, scoredRequest(selectedSymbol), 'scored-match');

      expect(autoCandidates.rankResolved).toHaveBeenCalledWith(
        userId,
        { underlying: 'SPY', expiration: '2026-08-05', optionType: 'call' },
        autoPreferences,
      );
      expect(place.mock.calls[0][1].selection).toEqual({
        mode: 'explicit',
        optionType: 'call',
        expiration: '2026-08-05',
        strike: 500,
      });
      expect(place.mock.calls[0][5]).toMatchObject({ symbol: selectedSymbol });
      expect(trading.metrics).toMatchObject({
        scoredReranks: 1,
        scoredAccepted: 1,
      });
      expect(Logger.prototype.log).toHaveBeenCalledWith(
        expect.stringContaining('"outcome":"accepted"'),
      );
    });

    it('defensively rejects unconfirmed scored requests passed outside DTO validation', async () => {
      const request = scoredRequest('SPY260805C00500000');
      request.selection.autoScoring!.scoredConfirmationAccepted = false as true;
      await expect(trading.place(userId, request, 'scored-unconfirmed')).rejects.toMatchObject({
        code: 'SCORED_CONFIRMATION_REQUIRED',
      });
      expect(autoCandidates.rankResolved).not.toHaveBeenCalled();
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
      expect(keyed[0].request).toMatchObject({
        preparedOrder: {
          selection: { mode: 'explicit' },
        },
      });
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
      jest
        .spyOn(gateway, 'placeOrder')
        .mockRejectedValueOnce(brokerErrors.orderRejected('broker down'));
      await expect(trading.place(userId, autoOtmCall(), 'idem-retry')).rejects.toThrow(
        'broker down',
      );

      const result = await trading.place(userId, autoOtmCall(), 'idem-retry');
      expect(result.status).toBe('filled');

      // The failure left only an unkeyed error audit behind.
      const audits = await prisma.orderAudit.findMany({ where: { userId } });
      expect(audits.filter((a) => a.idempotencyKey === 'idem-retry')).toHaveLength(1);
    });

    it('keeps the key pending when an unknown gateway error may follow broker acceptance', async () => {
      const place = jest
        .spyOn(gateway, 'placeOrder')
        .mockRejectedValueOnce(new Error('fetch failed'));

      await expect(trading.place(userId, autoOtmCall(), 'idem-uncertain')).rejects.toMatchObject({
        status: 503,
        code: 'ORDER_PLACEMENT_UNCERTAIN',
      });
      const keyed = prisma.orderAudits.filter((audit) => audit.idempotencyKey === 'idem-uncertain');
      expect(keyed).toHaveLength(1);
      expect(keyed[0].status).toBe('pending');

      await expect(trading.place(userId, autoOtmCall(), 'idem-uncertain')).rejects.toMatchObject({
        code: 'ORDER_IN_FLIGHT',
      });
      expect(place).toHaveBeenCalledTimes(1);
    });

    it('recovers an order accepted before a crash without submitting it again', async () => {
      const chain = await gateway.getOptionsChain(userId, 'SPY');
      const dto = autoOtmCall({
        orderType: 'mid',
        selection: {
          mode: 'explicit',
          optionType: 'call',
          expiration: chain.expirations[0],
          strike: 101,
        },
      });
      const acceptedRequest: OrderRequest = {
        underlying: dto.underlying,
        assetClass: dto.assetClass,
        side: dto.side,
        quantity: dto.quantity,
        orderType: dto.orderType,
        selection: {
          mode: 'explicit',
          optionType: 'call',
          expiration: chain.expirations[0],
          strike: 101,
        },
      };
      const accepted = await gateway.placeOrder(userId, acceptedRequest, 'crash-after-accept');
      const pending = await prisma.orderAudit.create({
        data: {
          userId,
          idempotencyKey: 'crash-after-accept',
          request: { action: 'place', order: dto },
          response: null,
          status: 'pending',
        },
      });
      pending.createdAt = new Date(Date.now() - 3 * 60_000);
      const place = jest.spyOn(gateway, 'placeOrder');

      await expect(trading.place(userId, dto, 'crash-after-accept')).resolves.toEqual(accepted);
      expect(place).not.toHaveBeenCalled();
    });

    it('matches stale scored-Auto recovery to the exact selected contract', async () => {
      const chain = await gateway.getOptionsChain(userId, 'SPY');
      const expiration = chain.expirations[0];
      const selectedRequest: OrderRequest = {
        underlying: 'SPY',
        assetClass: 'option',
        side: 'buy',
        quantity: 1,
        orderType: 'mid',
        selection: {
          mode: 'explicit',
          optionType: 'call',
          expiration,
          strike: 101,
        },
      };
      const competingRequest: OrderRequest = {
        underlying: 'SPY',
        assetClass: 'option',
        side: 'buy',
        quantity: 1,
        orderType: 'mid',
        selection: {
          mode: 'explicit',
          optionType: 'call',
          expiration,
          strike: 102,
        },
      };
      const accepted = await gateway.placeOrder(userId, selectedRequest, 'scored-selected');
      await gateway.placeOrder(userId, competingRequest, 'scored-competing');
      const scoredRequest: OrderRequest = {
        underlying: 'SPY',
        assetClass: 'option',
        side: 'buy',
        quantity: 1,
        orderType: 'mid',
        selection: {
          mode: 'auto_scored',
          optionType: 'call',
          expiration,
          autoScoring: {
            selectedSymbol: accepted.contractSymbol,
            preferences: {
              schemaVersion: 1,
              preset: 'conservative',
              targetAbsDelta: 0.25,
              strikeRungs: 5,
              maxSpreadBps: 500,
              maxPremiumDollars: 250,
              minOpenInterest: 100,
              gammaMode: 'avoid',
              weights: {
                delta: 0.3,
                spread: 0.25,
                openInterest: 0.2,
                gamma: 0.1,
                iv: 0.15,
              },
            },
            scoredConfirmationAccepted: true,
            rankedAt: new Date().toISOString(),
          },
        },
      };
      const dto = autoOtmCall({ orderType: 'mid' });
      const pending = await prisma.orderAudit.create({
        data: {
          userId,
          idempotencyKey: 'scored-crash-after-accept',
          request: { action: 'place', order: dto, preparedOrder: scoredRequest },
          response: null,
          status: 'pending',
        },
      });
      pending.createdAt = new Date(Date.now() - 3 * 60_000);
      const place = jest.spyOn(gateway, 'placeOrder');

      await expect(trading.place(userId, dto, 'scored-crash-after-accept')).resolves.toEqual(
        accepted,
      );
      expect(place).not.toHaveBeenCalled();
    });

    it('prefers an exact provider client-id recovery over history matching', async () => {
      const dto = autoOtmCall({ orderType: 'mid' });
      const scope: BrokerExecutionScope = {
        provider: 'webull',
        environment: 'live',
        accountId: 'default',
      };
      const accepted: OrderResult = {
        orderId: 'deterministic-client-order-id',
        status: 'filled',
        contractSymbol: 'SPY260101C00101000',
        side: dto.side,
        quantity: dto.quantity,
        orderType: dto.orderType,
        timestamp: new Date().toISOString(),
      };
      const pending = await prisma.orderAudit.create({
        data: {
          userId,
          idempotencyKey: 'exact-crash-after-accept',
          request: { action: 'place', order: dto, executionScope: scope },
          response: null,
          status: 'pending',
        },
      });
      pending.createdAt = new Date(Date.now() - 3 * 60_000);
      const recover = jest.fn(async () => ({
        ...accepted,
        clientOrderId: accepted.orderId,
        brokerOrderId: 'webull-broker-order-id',
      }));
      (gateway as BrokerGateway).recoverOrder = recover;
      const recent = jest.spyOn(gateway, 'getRecentOrders');
      const place = jest.spyOn(gateway, 'placeOrder');
      const updates: OrderResult[] = [];
      orderEvents.events$.subscribe((event) => updates.push(event.order));

      await expect(trading.place(userId, dto, 'exact-crash-after-accept')).resolves.toEqual(
        accepted,
      );

      expect(recover).toHaveBeenCalledWith(userId, 'exact-crash-after-accept', scope);
      expect(recent).not.toHaveBeenCalled();
      expect(place).not.toHaveBeenCalled();
      expect(prisma.tradeOrders).toContainEqual(
        expect.objectContaining({
          userId,
          provider: 'webull',
          environment: 'live',
          accountId: 'default',
          clientOrderId: accepted.orderId,
          brokerOrderId: 'webull-broker-order-id',
        }),
      );
      expect(updates).toContainEqual(expect.objectContaining({ orderId: accepted.orderId }));
    });

    it('retries durable event ingestion from a completed audit without touching the broker', async () => {
      const dto = autoOtmCall({ orderType: 'mid' });
      const scope: BrokerExecutionScope = {
        provider: 'webull',
        environment: 'live',
        accountId: 'default',
      };
      const completed: OrderResult = {
        orderId: 'completed-audit-client-id',
        status: 'submitted',
        contractSymbol: 'SPY260101C00101000',
        side: dto.side,
        quantity: dto.quantity,
        orderType: dto.orderType,
        timestamp: new Date().toISOString(),
      };
      await prisma.orderAudit.create({
        data: {
          userId,
          idempotencyKey: 'completed-audit-replay',
          request: { action: 'place', order: dto, executionScope: scope },
          response: completed,
          status: completed.status,
        },
      });
      jest.spyOn(orderEvents, 'ingest').mockRejectedValueOnce(new Error('event store offline'));
      const place = jest.spyOn(gateway, 'placeOrder');

      await expect(trading.place(userId, dto, 'completed-audit-replay')).rejects.toMatchObject({
        code: 'ORDER_RECOVERY_UNAVAILABLE',
      });
      expect(place).not.toHaveBeenCalled();
      expect(prisma.tradeOrders).toHaveLength(0);

      await expect(trading.place(userId, dto, 'completed-audit-replay')).resolves.toEqual(
        completed,
      );
      expect(place).not.toHaveBeenCalled();
      expect(prisma.tradeOrders).toContainEqual(
        expect.objectContaining({ clientOrderId: completed.orderId, status: 'submitted' }),
      );
    });

    it('retries only after exact recovery authoritatively reports no order', async () => {
      const dto = autoOtmCall({ orderType: 'mid' });
      const scope: BrokerExecutionScope = {
        provider: 'webull',
        environment: 'live',
        accountId: 'default',
      };
      const pending = await prisma.orderAudit.create({
        data: {
          userId,
          idempotencyKey: 'exact-crash-before-send',
          request: { action: 'place', order: dto, executionScope: scope },
          response: null,
          status: 'pending',
        },
      });
      pending.createdAt = new Date(Date.now() - 3 * 60_000);
      const recover = jest.fn(async () => null);
      (gateway as BrokerGateway).recoverOrder = recover;
      const place = jest.spyOn(gateway, 'placeOrder');

      await expect(trading.place(userId, dto, 'exact-crash-before-send')).resolves.toBeDefined();

      expect(recover).toHaveBeenCalledWith(userId, 'exact-crash-before-send', scope);
      expect(place).toHaveBeenCalledTimes(1);
    });

    it('keeps a stale claim pending when exact provider recovery is unavailable', async () => {
      const dto = autoOtmCall({ orderType: 'mid' });
      const scope: BrokerExecutionScope = {
        provider: 'webull',
        environment: 'live',
        accountId: 'default',
      };
      const pending = await prisma.orderAudit.create({
        data: {
          userId,
          idempotencyKey: 'exact-recovery-offline',
          request: { action: 'place', order: dto, executionScope: scope },
          response: null,
          status: 'pending',
        },
      });
      pending.createdAt = new Date(Date.now() - 3 * 60_000);
      (gateway as BrokerGateway).recoverOrder = jest.fn(async () => {
        throw brokerErrors.unavailable('order detail offline');
      });
      const place = jest.spyOn(gateway, 'placeOrder');

      await expect(trading.place(userId, dto, 'exact-recovery-offline')).rejects.toMatchObject({
        code: 'ORDER_RECOVERY_UNAVAILABLE',
      });

      expect(place).not.toHaveBeenCalled();
      expect(
        prisma.orderAudits.find((audit) => audit.idempotencyKey === 'exact-recovery-offline'),
      ).toMatchObject({ status: 'pending' });
    });

    it('reclaims a stale pre-send crash only after broker history confirms no order', async () => {
      const dto = autoOtmCall({ orderType: 'mid' });
      const pending = await prisma.orderAudit.create({
        data: {
          userId,
          idempotencyKey: 'crash-before-send',
          request: { action: 'place', order: dto },
          response: null,
          status: 'pending',
        },
      });
      pending.createdAt = new Date(Date.now() - 3 * 60_000);
      const place = jest.spyOn(gateway, 'placeOrder');

      await expect(trading.place(userId, dto, 'crash-before-send')).resolves.toBeDefined();
      expect(place).toHaveBeenCalledTimes(1);
    });

    it('reconciles and replays a stale claim only in its persisted broker account scope', async () => {
      const dto = autoOtmCall({ orderType: 'mid' });
      const armedScope: BrokerExecutionScope = {
        provider: 'webull',
        environment: 'live',
        accountId: 'account-a',
      };
      const currentScope: BrokerExecutionScope = {
        provider: 'snaptrade',
        environment: 'live',
        accountId: 'account-b',
      };
      const pending = await prisma.orderAudit.create({
        data: {
          userId,
          idempotencyKey: 'scope-pinned-crash',
          request: { action: 'place', order: dto, executionScope: armedScope },
          response: null,
          status: 'pending',
        },
      });
      pending.createdAt = new Date(Date.now() - 3 * 60_000);
      (gateway as BrokerGateway).executionScope = jest.fn(async () => currentScope);
      const recent = jest.spyOn(gateway, 'getRecentOrders').mockResolvedValue([]);
      const place = jest.spyOn(gateway, 'placeOrder');

      await trading.place(userId, dto, 'scope-pinned-crash');

      expect(recent.mock.calls[0][2]).toEqual(armedScope);
      expect(place.mock.calls[0][6]).toEqual(armedScope);
      expect(
        prisma.orderAudits.find((audit) => audit.idempotencyKey === 'scope-pinned-crash'),
      ).toMatchObject({ request: expect.objectContaining({ executionScope: armedScope }) });
    });
  });

  describe('legal gate', () => {
    it('blocks placement until both current server-side acceptances exist', async () => {
      prisma.legalAcceptances.length = 0;
      const place = jest.spyOn(gateway, 'placeOrder');

      await expect(trading.place(userId, autoOtmCall(), 'legal-blocked')).rejects.toMatchObject({
        status: 403,
        code: 'LEGAL_ACCEPTANCE_REQUIRED',
      });
      expect(place).not.toHaveBeenCalled();

      prisma.acceptCurrentTradingLegal(userId);
      await expect(trading.place(userId, autoOtmCall(), 'legal-accepted')).resolves.toBeDefined();
    });

    it('allows a verified close-only risk reduction after the legal version changes', async () => {
      const chain = await gateway.getOptionsChain(userId, 'SPY');
      const contract = findExplicitOption(chain.contracts, 'call', 101)!;
      jest.spyOn(gateway, 'getPositions').mockResolvedValue([
        {
          symbol: contract.symbol,
          assetClass: 'option',
          quantity: 1,
          avgPrice: 1,
          markPrice: 1,
          unrealizedPnl: 0,
          multiplier: 100,
        } as Position,
      ]);
      prisma.legalAcceptances.length = 0;

      await expect(
        trading.place(
          userId,
          autoOtmCall({
            side: 'sell',
            selection: {
              mode: 'explicit',
              optionType: 'call',
              expiration: chain.expirations[0],
              strike: 101,
            },
          }),
          'legal-close-only',
          'live',
          true,
        ),
      ).resolves.toBeDefined();
    });

    it('allows a manual flatten after a version bump only when the broker proves the reduction', async () => {
      const chain = await gateway.getOptionsChain(userId, 'SPY');
      const contract = findExplicitOption(chain.contracts, 'call', 101)!;
      jest.spyOn(gateway, 'getPositions').mockResolvedValue([
        {
          symbol: contract.symbol,
          assetClass: 'option',
          quantity: 2,
          avgPrice: 1,
          markPrice: 1,
          unrealizedPnl: 0,
          multiplier: 100,
        } as Position,
      ]);
      prisma.legalAcceptances.length = 0;

      await expect(
        trading.place(
          userId,
          autoOtmCall({
            side: 'sell',
            quantity: 2,
            selection: {
              mode: 'explicit',
              optionType: 'call',
              expiration: chain.expirations[0],
              strike: 101,
            },
          }),
          'manual-flatten-after-legal-bump',
        ),
      ).resolves.toBeDefined();
    });

    it('does not treat an over-sized or same-side manual order as a legal-bypass close', async () => {
      const chain = await gateway.getOptionsChain(userId, 'SPY');
      const contract = findExplicitOption(chain.contracts, 'call', 101)!;
      jest.spyOn(gateway, 'getPositions').mockResolvedValue([
        {
          symbol: contract.symbol,
          assetClass: 'option',
          quantity: 1,
          avgPrice: 1,
          markPrice: 1,
          unrealizedPnl: 0,
          multiplier: 100,
        } as Position,
      ]);
      prisma.legalAcceptances.length = 0;
      const explicit = {
        mode: 'explicit' as const,
        optionType: 'call' as const,
        expiration: chain.expirations[0],
        strike: 101,
      };

      await expect(
        trading.place(
          userId,
          autoOtmCall({ side: 'sell', quantity: 2, selection: explicit }),
          'unaccepted-over-close',
        ),
      ).rejects.toMatchObject({ code: 'LEGAL_ACCEPTANCE_REQUIRED' });
      await expect(
        trading.place(
          userId,
          autoOtmCall({ side: 'buy', quantity: 1, selection: explicit }),
          'unaccepted-add',
        ),
      ).rejects.toMatchObject({ code: 'LEGAL_ACCEPTANCE_REQUIRED' });
    });

    it('fails closed when positions are unavailable during an unaccepted manual close', async () => {
      const chain = await gateway.getOptionsChain(userId, 'SPY');
      jest.spyOn(gateway, 'getPositions').mockRejectedValue(new Error('positions offline'));
      prisma.legalAcceptances.length = 0;

      await expect(
        trading.place(
          userId,
          autoOtmCall({
            side: 'sell',
            selection: {
              mode: 'explicit',
              optionType: 'call',
              expiration: chain.expirations[0],
              strike: 101,
            },
          }),
          'unaccepted-positions-down',
        ),
      ).rejects.toMatchObject({ status: 503, code: 'POSITIONS_UNAVAILABLE' });
      expect(prisma.orderAudits.some((audit) => audit.idempotencyKey)).toBe(false);
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
      // The stub quotes the underlying at a fixed 100. That level is a
      // placement-time ESTIMATE, so it feeds the display-only estimate field;
      // the authoritative fill-time field stays reserved and unset, keeping
      // "Move stop to entry" disabled until a real fill observation exists.
      expect(position.underlyingEntryEstimate).toBe(StubBrokerGateway.PRICE);
      expect(position.underlyingEntryPrice).toBeUndefined();
    });

    it('leaves a position unannotated when no fill of it recorded an underlying price', async () => {
      jest.spyOn(gateway, 'getPositions').mockResolvedValue([positionFor('SPY260717C00505000', 1)]);

      const [position] = await trading.getPositions(userId);
      expect(position.underlyingEntryEstimate).toBeUndefined();
    });

    it('never fails a positions read because the anchor lookup failed', async () => {
      jest.spyOn(gateway, 'getPositions').mockResolvedValue([positionFor('SPY260717C00505000', 1)]);
      jest.spyOn(orders, 'positionAnchors').mockRejectedValue(new Error('db down'));

      await expect(trading.getPositions(userId)).resolves.toHaveLength(1);
    });

    it('withholds the anchor when the replay covers less than the broker position', async () => {
      const placed = await trading.place(userId, autoOtmCall(), 'idem-anchor-mismatch');
      // The broker reports 3 held; the app only ever saw the 1-lot fill. An
      // entry price averaged over a third of the position is not the
      // position's entry price — and "Move stop to entry" would consume it.
      jest
        .spyOn(gateway, 'getPositions')
        .mockResolvedValue([positionFor(placed.contractSymbol, 3)]);

      const [position] = await trading.getPositions(userId);
      expect(position.underlyingEntryEstimate).toBeUndefined();
      expect(position.openedAt).toBeUndefined();
    });

    it('withholds the anchor when the broker direction disagrees with the replay', async () => {
      const placed = await trading.place(userId, autoOtmCall(), 'idem-anchor-sign');
      // The app replayed a long; the broker says short. Attaching the long's
      // entry to the short would gate the stop on the wrong side.
      jest
        .spyOn(gateway, 'getPositions')
        .mockResolvedValue([positionFor(placed.contractSymbol, -1)]);

      const [position] = await trading.getPositions(userId);
      expect(position.underlyingEntryEstimate).toBeUndefined();
      expect(position.openedAt).toBeUndefined();
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
      const originalUpdate = prisma.orderAudit.update.bind(prisma.orderAudit);
      jest
        .spyOn(prisma.orderAudit, 'update')
        .mockImplementationOnce(originalUpdate)
        .mockRejectedValueOnce(new Error('connection reset'));

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

  /**
   * The clients each cap sell-to-close in their own trade panel, but that was
   * the only cap. A chart bracket leg freezes its size when the line is drawn,
   * so scaling the position down by hand leaves a stop that would close what
   * remains and open a short with the rest — unattended.
   */
  describe('closing orders are capped to the position', () => {
    /** The contract auto-OTM resolves to, so the stub position lines up. */
    async function resolvedSymbol(): Promise<string> {
      const spy = jest.spyOn(gateway, 'placeOrder');
      await trading.place(userId, autoOtmCall(), 'idem-warm');
      const sent = spy.mock.calls[0][1] as OrderRequest;
      spy.mockRestore();
      const chain = await gateway.getOptionsChain(userId, 'SPY');
      return findExplicitOption(chain.contracts, 'call', sent.selection.strike as number)!.symbol;
    }

    it('caps a sell that exceeds the long position', async () => {
      const symbol = await resolvedSymbol();
      const positions = jest.spyOn(gateway, 'getPositions').mockResolvedValue([
        {
          symbol,
          assetClass: 'option',
          quantity: 2,
          avgPrice: 1,
          markPrice: 1,
          unrealizedPnl: 0,
          multiplier: 100,
        } as Position,
      ]);
      const place = jest.spyOn(gateway, 'placeOrder');

      await trading.place(userId, autoOtmCall({ side: 'sell', quantity: 5 }), 'idem-cap-1');

      expect((place.mock.calls[0][1] as OrderRequest).quantity).toBe(2);
      // The held quantity capToPosition just read travels to the gateway
      // call, so it never has to read positions again to decide open/close.
      expect(place.mock.calls[0][4]).toBe(2);
      expect(positions).toHaveBeenCalledTimes(1);
    });

    it('leaves an opening order alone', async () => {
      const symbol = await resolvedSymbol();
      jest.spyOn(gateway, 'getPositions').mockResolvedValue([
        {
          symbol,
          assetClass: 'option',
          quantity: 2,
          avgPrice: 1,
          markPrice: 1,
          unrealizedPnl: 0,
          multiplier: 100,
        } as Position,
      ]);
      const place = jest.spyOn(gateway, 'placeOrder');

      // Same direction as the holding: adding, not closing.
      await trading.place(userId, autoOtmCall({ side: 'buy', quantity: 5 }), 'idem-cap-2');

      expect((place.mock.calls[0][1] as OrderRequest).quantity).toBe(5);
      expect(place.mock.calls[0][4]).toBe(2);
    });

    it('honours a partial scale-out rather than closing the whole position', async () => {
      const symbol = await resolvedSymbol();
      jest.spyOn(gateway, 'getPositions').mockResolvedValue([
        {
          symbol,
          assetClass: 'option',
          quantity: 10,
          avgPrice: 1,
          markPrice: 1,
          unrealizedPnl: 0,
          multiplier: 100,
        } as Position,
      ]);
      const place = jest.spyOn(gateway, 'placeOrder');

      await trading.place(userId, autoOtmCall({ side: 'sell', quantity: 4 }), 'idem-cap-3');

      expect((place.mock.calls[0][1] as OrderRequest).quantity).toBe(4);
      expect(place.mock.calls[0][4]).toBe(10);
    });

    it('places uncapped rather than failing the order when positions cannot be read', async () => {
      jest.spyOn(gateway, 'getPositions').mockRejectedValue(new Error('broker down'));
      const place = jest.spyOn(gateway, 'placeOrder');

      await trading.place(userId, autoOtmCall({ side: 'sell', quantity: 3 }), 'idem-cap-4');

      expect((place.mock.calls[0][1] as OrderRequest).quantity).toBe(3);
      // Positions couldn't be read at all, so there is no held quantity to
      // hand the gateway — it falls back to its own lookup.
      expect(place.mock.calls[0][4]).toBeUndefined();
    });

    it('fails closed when an unattended close-only order cannot read positions', async () => {
      jest.spyOn(gateway, 'getPositions').mockRejectedValue(new Error('broker down'));
      const place = jest.spyOn(gateway, 'placeOrder');

      await expect(
        trading.place(
          userId,
          autoOtmCall({ side: 'sell', quantity: 3 }),
          'idem-close-only-1',
          'live',
          true,
        ),
      ).rejects.toMatchObject({ code: 'POSITIONS_UNAVAILABLE' });

      expect(place).not.toHaveBeenCalled();
    });

    it('fails closed when an unattended close-only order would open a position', async () => {
      jest.spyOn(gateway, 'getPositions').mockResolvedValue([]);
      const place = jest.spyOn(gateway, 'placeOrder');

      await expect(
        trading.place(userId, autoOtmCall({ side: 'sell' }), 'idem-close-only-2', 'live', true),
      ).rejects.toMatchObject({ code: 'CLOSE_ONLY_NO_POSITION' });

      expect(place).not.toHaveBeenCalled();
    });
  });

  /**
   * Each gateway re-derives live-vs-practice from the database when it builds a
   * client, so the environment the caller validated has to travel with the
   * order — otherwise a mode flip mid-placement silently reroutes it.
   */
  describe('environment is pinned for the whole placement', () => {
    it("passes the user's current mode to the gateway", async () => {
      const place = jest.spyOn(gateway, 'placeOrder');

      await trading.place(userId, autoOtmCall(), 'idem-mode-1');

      expect(place.mock.calls[0][3]).toBe('live');
    });

    it("passes the caller's expected mode when one is given", async () => {
      const place = jest.spyOn(gateway, 'placeOrder');

      await trading.place(userId, autoOtmCall(), 'idem-mode-2', 'practice');

      expect(place.mock.calls[0][3]).toBe('practice');
    });
  });
});
