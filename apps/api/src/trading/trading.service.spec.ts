import { OrderRequest } from '@0dtetrader/shared-types';
import { BrokerGateway } from '../broker/broker-gateway.interface';
import { MockBrokerGateway } from '../broker/mock-broker.gateway';
import { OrderEventsService } from '../broker/order-events.service';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { OrderRequestDto } from './dto/order-request.dto';
import { TradingService } from './trading.service';

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
  let gateway: MockBrokerGateway;
  let trading: TradingService;
  let userId: string;

  beforeEach(async () => {
    // Freeze the mock's 1-second tick so prices are identical across every
    // call in a test (walk advances once per wall-clock second).
    jest.spyOn(Date, 'now').mockReturnValue(1_752_000_000_000);
    prisma = new InMemoryPrismaService();
    gateway = new MockBrokerGateway(new OrderEventsService());
    trading = new TradingService(
      prisma as unknown as ConstructorParameters<typeof TradingService>[0],
      gateway as BrokerGateway,
    );
    const user = await prisma.user.create({
      data: { email: 'trader@example.com', passwordHash: 'x' },
    });
    userId = user.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    gateway.onModuleDestroy();
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
        ...new Set(
          chain.contracts
            .filter((c) => c.optionType === 'call')
            .map((c) => c.strike),
        ),
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

      const result = await trading.place(
        userId,
        autoOtmCall({ orderType: 'mid' }),
        'idem-mid-1',
      );
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
  });

  describe('kill switch', () => {
    it('returns 403 TRADING_DISABLED and audit-logs the blocked attempt', async () => {
      prisma.setTradingDisabled(userId, true);
      await expect(
        trading.place(userId, autoOtmCall(), 'idem-blocked'),
      ).rejects.toMatchObject({ status: 403, code: 'TRADING_DISABLED' });

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
      await expect(trading.cancel(userId, 'MOCK-000001')).rejects.toMatchObject({
        status: 403,
        code: 'TRADING_DISABLED',
      });
    });
  });

  describe('auditing', () => {
    it('records every preview/place/cancel attempt', async () => {
      await trading.preview(userId, autoOtmCall());
      const placed = await trading.place(
        userId,
        autoOtmCall({ orderType: 'mid' }),
        'idem-audit',
      );
      await trading.cancel(userId, placed.orderId);

      const audits = await prisma.orderAudit.findMany({ where: { userId } });
      expect(audits.map((a) => a.request.action).sort()).toEqual([
        'cancel',
        'place',
        'preview',
      ]);
      expect(audits.every((a) => a.status === 'ok' || a.status === 'submitted')).toBe(
        true,
      );
    });
  });

  describe('validation', () => {
    it('requires optionType for option orders', async () => {
      await expect(
        trading.preview(
          userId,
          autoOtmCall({ selection: { mode: 'auto_otm' } }) ,
        ),
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

    it('rejects auto_otm for futures', async () => {
      await expect(
        trading.preview(
          userId,
          autoOtmCall({
            underlying: 'MES',
            assetClass: 'future',
            selection: { mode: 'auto_otm' },
          }),
        ),
      ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    });

    it('rejects an unknown futures contract symbol', async () => {
      await expect(
        trading.preview(
          userId,
          autoOtmCall({
            underlying: 'MES',
            assetClass: 'future',
            selection: { mode: 'explicit', contractSymbol: 'MESX99' },
          }),
        ),
      ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    });
  });
});
