import { createHash } from 'node:crypto';
import { OrderRequest } from '@0dtetrader/shared-types';
import { OrderEventsService } from './order-events.service';
import { WebullBrokerGateway } from './webull-broker.gateway';
import { WebullClientProvider } from './webull/webull-client.provider';
import { parseOccSymbol } from './contract-resolution';
import { WebullSnapshot } from './webull/webull-mappers';

/**
 * Fake WebullClientProvider: answers every snapshot request with synthetic
 * data so gateway logic (chain synthesis, resolution, order body construction)
 * is tested without any HTTP.
 */
function makeFakeClient(): jest.Mocked<WebullClientProvider> {
  const optionSnap = (occ: string): WebullSnapshot => ({
    symbol: occ,
    bid: '1.00',
    ask: '1.10',
    price: '1.05',
    bid_size: '10',
    ask_size: '12',
    volume: '5000',
    last_trade_time: Date.now(),
  });
  return {
    accountId: jest.fn().mockResolvedValue('ACC-1'),
    getStockSnapshots: jest.fn().mockImplementation(async (_u, symbols: string[]) =>
      symbols.map((s) => ({
        symbol: s,
        bid: '499.9',
        ask: '500.1',
        price: '500',
        bid_size: '5',
        ask_size: '5',
        volume: '1000000',
        last_trade_time: Date.now(),
      })),
    ),
    getOptionSnapshots: jest
      .fn()
      .mockImplementation(async (_u, occSymbols: string[]) =>
        occSymbols.map(optionSnap),
      ),
    getFuturesSnapshots: jest.fn().mockImplementation(async (_u, symbols: string[]) =>
      symbols.map((s) => ({
        symbol: s,
        bid: '6000.75',
        ask: '6001.25',
        price: '6001',
        volume: '100',
        last_trade_time: Date.now(),
      })),
    ),
    getBars: jest.fn().mockResolvedValue([]),
    getFuturesInstruments: jest.fn().mockResolvedValue([
      {
        symbol: 'ESZ6',
        contract_month: '202612',
        contract_type: 'MONTHLY',
        last_trading_date: '2026-12-18',
      },
      {
        symbol: 'ESH7',
        contract_month: '202703',
        contract_type: 'MONTHLY',
        last_trading_date: '2027-03-19',
      },
    ]),
    getBalance: jest.fn().mockResolvedValue({
      account_currency_assets: [
        { buying_power: '25000', option_buying_power: '25000' },
      ],
    }),
    getPositions: jest.fn().mockResolvedValue([]),
    previewOrder: jest.fn().mockResolvedValue({ estimated_cost: '210' }),
    placeOrder: jest.fn().mockResolvedValue({ order_id: 'WB-1' }),
    cancelOrder: jest.fn().mockResolvedValue(undefined),
    getOpenOrders: jest.fn().mockResolvedValue([]),
    getOrderDetail: jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<WebullClientProvider>;
}

describe('WebullBrokerGateway', () => {
  let client: jest.Mocked<WebullClientProvider>;
  let events: OrderEventsService;
  let gateway: WebullBrokerGateway;

  beforeEach(() => {
    client = makeFakeClient();
    events = new OrderEventsService();
    gateway = new WebullBrokerGateway(client, events);
  });

  afterEach(() => {
    gateway.onModuleDestroy();
  });

  describe('getQuote', () => {
    it('routes stock symbols to stock snapshots', async () => {
      const quote = await gateway.getQuote('u1', 'SPY');
      expect(quote.last).toBe(500);
      expect(client.getStockSnapshots).toHaveBeenCalledWith('u1', ['SPY']);
    });

    it('routes OCC symbols to option snapshots', async () => {
      const quote = await gateway.getQuote('u1', 'SPY260717C00505000');
      expect(quote.last).toBe(1.05);
      expect(client.getOptionSnapshots).toHaveBeenCalledWith('u1', [
        'SPY260717C00505000',
      ]);
    });

    it('translates futures symbols to Webull 1-digit years', async () => {
      const quote = await gateway.getQuote('u1', 'ESZ26');
      expect(quote.symbol).toBe('ESZ26');
      expect(client.getFuturesSnapshots).toHaveBeenCalledWith('u1', ['ESZ6']);
    });
  });

  describe('getOptionsChain (synthesis)', () => {
    it('synthesizes strikes around ATM with the $5 increment above $250', async () => {
      const chain = await gateway.getOptionsChain('u1', 'SPY');
      expect(chain.underlying).toBe('SPY');
      expect(chain.underlyingPrice).toBe(500);
      expect(chain.expirations.length).toBeGreaterThan(0);
      // ±12 strikes × 2 types, all returned by the fake snapshot endpoint.
      expect(chain.contracts).toHaveLength(50);
      const strikes = [...new Set(chain.contracts.map((c) => c.strike))];
      expect(Math.min(...strikes)).toBe(500 - 12 * 5);
      expect(Math.max(...strikes)).toBe(500 + 12 * 5);
      for (const contract of chain.contracts) {
        expect(parseOccSymbol(contract.symbol)).toMatchObject({
          underlying: 'SPY',
          strike: contract.strike,
        });
      }
    });

    it('drops strikes the snapshot endpoint does not return', async () => {
      client.getOptionSnapshots.mockImplementation(
        async (_u: string, occSymbols: string[]) =>
          occSymbols
            .filter((occ) => (parseOccSymbol(occ)?.strike ?? 0) <= 500)
            .map((occ) => ({ symbol: occ, bid: '1', ask: '1.1', price: '1.05' })),
      );
      const chain = await gateway.getOptionsChain('u1', 'SPY');
      expect(chain.contracts.every((c) => c.strike <= 500)).toBe(true);
    });

    it('rejects an expiration that fails the probe', async () => {
      await expect(
        gateway.getOptionsChain('u1', 'SPY', '1999-01-01'),
      ).rejects.toMatchObject({ code: 'CONTRACT_NOT_FOUND' });
    });
  });

  describe('getFuturesContracts', () => {
    it('maps instruments + snapshots into project-format contracts', async () => {
      const contracts = await gateway.getFuturesContracts('u1', 'ES');
      expect(contracts).toHaveLength(2);
      expect(contracts[0]).toMatchObject({
        symbol: 'ESZ26',
        root: 'ES',
        expiration: '2026-12-18',
        frontMonth: true,
        last: 6001,
      });
      expect(contracts[1].frontMonth).toBe(false);
    });
  });

  describe('previewOrder', () => {
    const order: OrderRequest = {
      underlying: 'SPY',
      assetClass: 'option',
      side: 'buy',
      quantity: 2,
      orderType: 'mid',
      selection: { mode: 'auto_otm', optionType: 'call' },
    };

    it('uses the real preview endpoint estimate and mid pricing', async () => {
      const preview = await gateway.previewOrder('u1', order);
      // auto_otm call above 500 with $5 increment → 505.
      expect(preview.resolved.contractSymbol).toBe('SPY260717C00505000'.replace('260717', preview.resolved.contractSymbol.slice(3, 9)));
      expect(parseOccSymbol(preview.resolved.contractSymbol)).toMatchObject({
        strike: 505,
        optionType: 'call',
      });
      expect(preview.resolved.price).toBe(1.05); // mid of 1.00/1.10
      expect(preview.resolved.estBuyingPower).toBe(210);
    });

    it('falls back to the local estimate when preview fails', async () => {
      client.previewOrder.mockRejectedValueOnce(new Error('boom'));
      const preview = await gateway.previewOrder('u1', order);
      // 2 contracts × 1.05 × 100 multiplier
      expect(preview.resolved.estBuyingPower).toBe(210);
    });

    it('warns on market orders for options', async () => {
      const preview = await gateway.previewOrder('u1', {
        ...order,
        orderType: 'market',
      });
      expect(
        preview.warnings.some((w) => w.includes('Market order')),
      ).toBe(true);
    });
  });

  describe('placeOrder', () => {
    const order: OrderRequest = {
      underlying: 'SPY',
      assetClass: 'option',
      side: 'buy',
      quantity: 1,
      orderType: 'mid',
      selection: { mode: 'auto_otm', optionType: 'call' },
    };

    it('derives a deterministic client_order_id from the idempotency key', async () => {
      const result = await gateway.placeOrder('u1', order, 'idem-key-1');
      const expectedId = createHash('md5').update('idem-key-1').digest('hex');
      expect(result.orderId).toBe(expectedId);
      expect(result.status).toBe('submitted');

      const body = client.placeOrder.mock.calls[0][1] as Record<string, unknown>;
      expect(body).toMatchObject({
        client_order_id: expectedId,
        combo_type: 'NORMAL',
        entrust_type: 'QTY',
        market: 'US',
        side: 'BUY',
        order_type: 'LIMIT',
        limit_price: '1.05',
        quantity: '1',
        time_in_force: 'DAY',
        instrument_type: 'OPTION',
        symbol: 'SPY',
        option_strategy: 'SINGLE',
        position_intent: 'BUY_TO_OPEN',
      });
      const legs = body.legs as Record<string, unknown>[];
      expect(legs[0]).toMatchObject({
        symbol: 'SPY',
        strike_price: '505',
        option_type: 'CALL',
      });
    });

    it('closes an existing short with BUY_TO_CLOSE', async () => {
      const chain = await gateway.getOptionsChain('u1', 'SPY');
      const target = chain.contracts.find(
        (c) => c.optionType === 'call' && c.strike === 505,
      )!;
      client.getPositions.mockResolvedValue([
        {
          instrument_type: 'OPTION',
          symbol: 'SPY',
          quantity: '-1',
          cost_price: '1',
          last_price: '1',
          unrealized_profit_loss: '0',
          legs: [
            {
              symbol: 'SPY',
              strike_price: '505',
              option_expire_date: target.expiration,
              option_type: 'CALL',
            },
          ],
        },
      ]);
      await gateway.placeOrder('u1', order, 'idem-key-2');
      const body = client.placeOrder.mock.calls[0][1] as Record<string, unknown>;
      expect(body.position_intent).toBe('BUY_TO_CLOSE');
    });

    it('places futures orders with the Webull symbol and no legs', async () => {
      await gateway.placeOrder(
        'u1',
        {
          underlying: 'ES',
          assetClass: 'future',
          side: 'sell',
          quantity: 1,
          orderType: 'market',
          selection: { mode: 'explicit', contractSymbol: 'ESZ26' },
        },
        'idem-key-3',
      );
      const body = client.placeOrder.mock.calls[0][1] as Record<string, unknown>;
      expect(body).toMatchObject({
        instrument_type: 'FUTURES',
        symbol: 'ESZ6',
        side: 'SELL',
        order_type: 'MARKET',
      });
      expect(body.legs).toBeUndefined();
      expect(body.limit_price).toBeUndefined();
    });

    it('emits an orderUpdate when a status poll sees a fill', async () => {
      jest.useFakeTimers();
      try {
        const emitted: unknown[] = [];
        events.events$.subscribe((e) => emitted.push(e));
        const result = await gateway.placeOrder('u1', order, 'idem-key-4');
        client.getOrderDetail.mockResolvedValue({
          client_order_id: result.orderId,
          status: 'FILLED',
          filled_price: '1.04',
          quantity: '1',
        });
        await jest.advanceTimersByTimeAsync(1_100);
        expect(emitted).toHaveLength(2); // initial submitted + filled
        expect(emitted[1]).toMatchObject({
          userId: 'u1',
          order: { status: 'filled', filledPrice: 1.04, orderId: result.orderId },
        });
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('cancelOrder', () => {
    it('cancels by client_order_id', async () => {
      await gateway.cancelOrder('u1', 'abc');
      expect(client.cancelOrder).toHaveBeenCalledWith('u1', 'abc');
    });

    it('maps unknown-order failures to ORDER_NOT_FOUND', async () => {
      client.cancelOrder.mockRejectedValueOnce(
        new Error('order does not exist'),
      );
      await expect(gateway.cancelOrder('u1', 'abc')).rejects.toMatchObject({
        code: 'ORDER_NOT_FOUND',
      });
    });
  });

  describe('getPositions / getOpenOrders', () => {
    it('filters positions to options and futures', async () => {
      client.getPositions.mockResolvedValue([
        { instrument_type: 'EQUITY', symbol: 'AAPL', quantity: '10' },
        {
          instrument_type: 'FUTURES',
          symbol: 'ESZ6',
          contract_month: '202612',
          quantity: '1',
          cost_price: '6000',
          last_price: '6001',
          unrealized_profit_loss: '50',
        },
      ]);
      const positions = await gateway.getPositions('u1');
      expect(positions).toEqual([
        {
          symbol: 'ESZ26',
          assetClass: 'future',
          quantity: 1,
          avgPrice: 6000,
          markPrice: 6001,
          unrealizedPnl: 50,
        },
      ]);
    });

    it('returns only open orders', async () => {
      client.getOpenOrders.mockResolvedValue([
        { client_order_id: 'a', status: 'SUBMITTED', symbol: 'SPY' },
        { client_order_id: 'b', status: 'FILLED', symbol: 'SPY' },
      ]);
      const orders = await gateway.getOpenOrders('u1');
      expect(orders.map((o) => o.orderId)).toEqual(['a']);
    });
  });
});
