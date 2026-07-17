import { OrderRequest } from '@0dtetrader/shared-types';
import { BrokerError } from '../common/broker-error';
import {
  MockBrokerGateway,
  MOCK_BUYING_POWER,
} from './mock-broker.gateway';
import { OrderEventsService } from './order-events.service';

const USER = 'user-1';

function marketOrder(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    underlying: 'SPY',
    assetClass: 'option',
    side: 'buy',
    quantity: 1,
    orderType: 'market',
    selection: { mode: 'auto_otm', optionType: 'call' },
    ...overrides,
  };
}

describe('MockBrokerGateway', () => {
  let gateway: MockBrokerGateway;
  let events: OrderEventsService;

  beforeEach(() => {
    // Freeze the walk's 1-second tick for deterministic prices within a test.
    jest.spyOn(Date, 'now').mockReturnValue(1_752_000_000_000);
    events = new OrderEventsService();
    gateway = new MockBrokerGateway(events);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    gateway.onModuleDestroy();
  });

  describe('quotes', () => {
    it('is deterministic within a one-second tick', async () => {
      const a = await gateway.getQuote(USER, 'SPY');
      const b = await gateway.getQuote(USER, 'SPY');
      expect(a.last).toBe(b.last);
      expect(a.bid).toBe(b.bid);
      expect(a.bid).toBeLessThanOrEqual(a.last);
      expect(a.ask).toBeGreaterThanOrEqual(a.last);
      expect(a.bid).toBeLessThan(a.ask);
    });

    it('gives different symbols independent prices', async () => {
      const spy = await gateway.getQuote(USER, 'SPY');
      const qqq = await gateway.getQuote(USER, 'QQQ');
      expect(spy.last).not.toBe(qqq.last);
    });
  });

  describe('options chain', () => {
    it('offers today/+1d/weekly/monthly expirations, ascending', async () => {
      const chain = await gateway.getOptionsChain(USER, 'SPY');
      expect(chain.expirations.length).toBeGreaterThanOrEqual(3);
      const sorted = [...chain.expirations].sort();
      expect(chain.expirations).toEqual(sorted);
      expect(chain.expirations[0]).toBe(
        new Date().toISOString().slice(0, 10),
      );
    });

    it('uses $1 strikes under $250 and $5 strikes above', async () => {
      const chain = await gateway.getOptionsChain(USER, 'SPY');
      const strikes = [
        ...new Set(chain.contracts.map((c) => c.strike)),
      ].sort((a, b) => a - b);
      const increment = strikes[1] - strikes[0];
      expect(increment).toBe(chain.underlyingPrice < 250 ? 1 : 5);
      // Strike grid brackets the underlying price on both sides.
      expect(strikes[0]).toBeLessThan(chain.underlyingPrice);
      expect(strikes[strikes.length - 1]).toBeGreaterThan(chain.underlyingPrice);
    });

    it('quotes contracts with non-crossed markets and OCC symbols', async () => {
      const chain = await gateway.getOptionsChain(USER, 'SPY');
      for (const c of chain.contracts) {
        expect(c.bid).toBeLessThan(c.ask);
        expect(c.last).toBeGreaterThan(0);
        expect(c.symbol).toMatch(/^SPY\d{6}[CP]\d{8}$/);
      }
      expect(chain.contracts.some((c) => c.optionType === 'call')).toBe(true);
      expect(chain.contracts.some((c) => c.optionType === 'put')).toBe(true);
    });

    it('rejects an unknown expiration', async () => {
      await expect(
        gateway.getOptionsChain(USER, 'SPY', '2030-01-18'),
      ).rejects.toBeInstanceOf(BrokerError);
    });
  });

  describe('futures', () => {
    it('lists front + deferred contracts for all supported roots', async () => {
      for (const root of ['ES', 'MES', 'NQ', 'MNQ', 'CL', 'GC']) {
        const contracts = await gateway.getFuturesContracts(USER, root);
        expect(contracts).toHaveLength(2);
        expect(contracts[0].frontMonth).toBe(true);
        expect(contracts[1].frontMonth).toBe(false);
        expect(contracts[0].symbol).toMatch(new RegExp(`^${root}[HMUZ]\\d{2}$`));
        expect(contracts[0].bid).toBeLessThan(contracts[0].ask);
      }
    });

    it('rejects an unknown root', async () => {
      await expect(gateway.getFuturesContracts(USER, 'ZZ')).rejects.toMatchObject({
        code: 'CONTRACT_NOT_FOUND',
      });
    });
  });

  describe('candles', () => {
    it('returns deterministic, well-formed candles', async () => {
      const a = await gateway.getCandles(USER, 'SPY', { interval: '1m' });
      const b = await gateway.getCandles(USER, 'SPY', { interval: '1m' });
      expect(a.length).toBeGreaterThan(50);
      expect(a).toEqual(b);
      for (const c of a) {
        expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
        expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      }
    });
  });

  describe('orders', () => {
    it('market orders fill immediately at last and open a position', async () => {
      const fills: string[] = [];
      events.events$.subscribe((e) => fills.push(e.order.status));

      const result = await gateway.placeOrder(USER, marketOrder(), 'key-1');
      expect(result.status).toBe('filled');
      expect(result.filledPrice).toBeGreaterThan(0);
      expect(result.contractSymbol).toMatch(/^SPY\d{6}C\d{8}$/);
      expect(fills).toEqual(['filled']);

      const positions = await gateway.getPositions(USER);
      expect(positions).toHaveLength(1);
      expect(positions[0].symbol).toBe(result.contractSymbol);
      expect(positions[0].quantity).toBe(1);
      expect(positions[0].avgPrice).toBe(result.filledPrice);
      expect(positions[0].assetClass).toBe('option');
    });

    it('mid orders rest at mid and fill at mid after a short delay', async () => {
      const statuses: string[] = [];
      events.events$.subscribe((e) => statuses.push(e.order.status));

      const result = await gateway.placeOrder(
        USER,
        marketOrder({ orderType: 'mid' }),
        'key-2',
      );
      expect(result.status).toBe('submitted');
      expect(result.limitPrice).toBeGreaterThan(0);
      expect(statuses).toEqual(['submitted']);

      // Still open before the delay elapses.
      let open = await gateway.getOpenOrders(USER);
      expect(open.map((o) => o.orderId)).toContain(result.orderId);

      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(statuses).toEqual(['submitted', 'filled']);
      open = await gateway.getOpenOrders(USER);
      expect(open).toHaveLength(0);
      const positions = await gateway.getPositions(USER);
      expect(positions).toHaveLength(1);
      expect(positions[0].quantity).toBe(1);
    });

    it('cancel transitions a resting order to cancelled (no fill)', async () => {
      const result = await gateway.placeOrder(
        USER,
        marketOrder({ orderType: 'mid' }),
        'key-3',
      );
      await gateway.cancelOrder(USER, result.orderId);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const positions = await gateway.getPositions(USER);
      expect(positions).toHaveLength(0);
    });

    it('cancel of a filled/unknown order fails properly', async () => {
      const filled = await gateway.placeOrder(USER, marketOrder(), 'key-4');
      await expect(gateway.cancelOrder(USER, filled.orderId)).rejects.toMatchObject({
        code: 'ORDER_NOT_OPEN',
      });
      await expect(gateway.cancelOrder(USER, 'MOCK-999999')).rejects.toMatchObject({
        code: 'ORDER_NOT_FOUND',
      });
    });

    it('enforces the $25k buying power limit', async () => {
      const chain = await gateway.getOptionsChain(USER, 'SPY');
      const atm = chain.contracts.reduce((best, c) =>
        Math.abs(c.strike - chain.underlyingPrice) <
        Math.abs(best.strike - chain.underlyingPrice)
          ? c
          : best,
      );
      await expect(
        gateway.placeOrder(
          USER,
          {
            underlying: 'SPY',
            assetClass: 'option',
            side: 'buy',
            quantity: 1000,
            orderType: 'market',
            selection: {
              mode: 'explicit',
              optionType: 'call',
              expiration: atm.expiration,
              strike: atm.strike,
            },
          },
          'key-5',
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_BUYING_POWER' });
      expect(MOCK_BUYING_POWER).toBe(25_000);
    });

    it('closing a position removes it', async () => {
      const opened = await gateway.placeOrder(USER, marketOrder(), 'key-6');
      const occ = opened.contractSymbol;
      await gateway.placeOrder(
        USER,
        {
          underlying: 'SPY',
          assetClass: 'option',
          side: 'sell',
          quantity: 1,
          orderType: 'market',
          selection: {
            mode: 'explicit',
            optionType: 'call',
            expiration: `20${occ.slice(3, 5)}-${occ.slice(5, 7)}-${occ.slice(7, 9)}`,
            strike: Number(occ.slice(10)) / 1000,
          },
        },
        'key-7',
      );
      const positions = await gateway.getPositions(USER);
      expect(positions).toHaveLength(0);
    });

    it('previews with resolved contract, price, buying power, warnings', async () => {
      const preview = await gateway.previewOrder(USER, marketOrder());
      expect(preview.resolved.contractSymbol).toMatch(/^SPY\d{6}C\d{8}$/);
      expect(preview.resolved.price).toBeGreaterThan(0);
      expect(preview.resolved.estBuyingPower).toBeCloseTo(
        preview.resolved.price * 100,
        2,
      );
      // Today is the default expiration → 0DTE warning.
      expect(preview.warnings.join(' ')).toMatch(/0DTE/);
    });

    it('futures orders work end to end', async () => {
      const contracts = await gateway.getFuturesContracts(USER, 'MES');
      const result = await gateway.placeOrder(
        USER,
        {
          underlying: 'MES',
          assetClass: 'future',
          side: 'buy',
          quantity: 1,
          orderType: 'market',
          selection: { mode: 'explicit', contractSymbol: contracts[0].symbol },
        },
        'key-8',
      );
      expect(result.status).toBe('filled');
      expect(result.contractSymbol).toBe(contracts[0].symbol);
      const positions = await gateway.getPositions(USER);
      expect(positions[0].assetClass).toBe('future');
    });
  });
});
