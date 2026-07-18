import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { OrderRequest } from '@0dtetrader/shared-types';
import { CredentialsService } from '../credentials/credentials.service';
import { OrderEventsService } from './order-events.service';
import { parseOccSymbol } from './contract-resolution';
import { WebullBrokerGateway } from './webull/webull-broker.gateway';
import { FetchImpl } from './webull/webull-client';

/**
 * Gateway tests through its real seams: mocked CredentialsService (fixed fake
 * creds), real ConfigService, real OrderEventsService, and a fake fetchImpl
 * that routes URL paths to synthetic Webull responses. No HTTP, no signing
 * assertions here (those live in webull-signer.spec / webull-client.spec).
 */

interface RecordedCall {
  method: string;
  path: string;
  url: string;
  body: any;
  headers: Record<string, string>;
}

type Handler = (call: RecordedCall) => { status: number; body: unknown };

const TODAY = new Date().toISOString().slice(0, 10);

function defaultHandlers(): Record<string, Handler> {
  const perSymbol = (
    call: RecordedCall,
    make: (symbol: string) => Record<string, unknown>,
  ) => {
    const symbols = new URL(call.url).searchParams.get('symbols') ?? '';
    return {
      status: 200,
      body: symbols
        .split(',')
        .filter(Boolean)
        .map(make),
    };
  };

  return {
    'POST /openapi/auth/token/create': () => ({
      status: 200,
      body: {
        token: 'tok-1',
        expires: Math.floor(Date.now() / 1000) + 15 * 86_400,
        status: 'NORMAL',
      },
    }),
    'POST /openapi/auth/token/refresh': () => ({
      status: 200,
      body: {
        token: 'tok-2',
        expires: Math.floor(Date.now() / 1000) + 15 * 86_400,
        status: 'NORMAL',
      },
    }),
    'GET /openapi/market-data/stock/snapshot': (call) =>
      perSymbol(call, (s) => ({
        symbol: s,
        bid: '499.9',
        ask: '500.1',
        price: '500',
        bid_size: '5',
        ask_size: '5',
        volume: '1000000',
        last_trade_time: Date.now(),
      })),
    'GET /openapi/market-data/option/snapshot': (call) =>
      perSymbol(call, (occ) => ({
        symbol: occ,
        bid: '1.00',
        ask: '1.10',
        price: '1.05',
        bid_size: '10',
        ask_size: '12',
        volume: '5000',
        last_trade_time: Date.now(),
      })),
    'GET /openapi/market-data/futures/snapshot': (call) =>
      perSymbol(call, (s) => ({
        symbol: s,
        bid: '6000.75',
        ask: '6001.25',
        price: '6001',
        volume: '100',
        last_trade_time: Date.now(),
      })),
    'GET /openapi/instrument/futures/by-code': () => ({
      status: 200,
      body: [
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
      ],
    }),
    'GET /openapi/assets/balance': () => ({
      status: 200,
      body: {
        account_currency_assets: [
          { currency: 'USD', buying_power: '25000', option_buying_power: '25000' },
        ],
      },
    }),
    'GET /openapi/assets/positions': () => ({ status: 200, body: [] }),
    'GET /openapi/trade/order/open': () => ({ status: 200, body: [] }),
    'GET /openapi/trade/order/detail': () => ({ status: 200, body: {} }),
    'POST /openapi/trade/order/preview': () => ({
      status: 200,
      body: { estimated_cost: '210' },
    }),
    'POST /openapi/trade/order/place': () => ({
      status: 200,
      body: { order_id: 'WB-1' },
    }),
    'POST /openapi/trade/order/cancel': () => ({ status: 200, body: {} }),
    'GET /openapi/market-data/stock/bars': () => ({ status: 200, body: [] }),
    'GET /openapi/market-data/option/bars': () => ({ status: 200, body: [] }),
    'GET /openapi/market-data/futures/bars': () => ({ status: 200, body: [] }),
  };
}

describe('WebullBrokerGateway', () => {
  let calls: RecordedCall[];
  let handlers: Record<string, Handler>;
  let events: OrderEventsService;
  let gateway: WebullBrokerGateway;

  const callsTo = (path: string): RecordedCall[] =>
    calls.filter((c) => c.path === path);

  beforeEach(() => {
    calls = [];
    handlers = defaultHandlers();
    const fetchImpl: FetchImpl = async (url, init) => {
      const path = new URL(url).pathname;
      const call: RecordedCall = {
        method: init.method,
        path,
        url,
        body: init.body ? JSON.parse(init.body) : undefined,
        headers: init.headers,
      };
      calls.push(call);
      const handler = handlers[`${init.method} ${path}`];
      if (!handler) throw new Error(`No handler for ${init.method} ${path}`);
      const res = handler(call);
      return {
        status: res.status,
        json: async () => res.body,
      };
    };
    const credentials = {
      getDecrypted: jest
        .fn()
        .mockResolvedValue({ appKey: 'AK', appSecret: 'SK', accountId: 'ACC-1' }),
    } as unknown as CredentialsService;
    const config = new ConfigService({
      webull: {
        apiBaseUrl: 'https://api.sandbox.webull.com',
        marketDataBaseUrl: '',
      },
    });
    events = new OrderEventsService();
    gateway = new WebullBrokerGateway(credentials, config, events, fetchImpl);
  });

  afterEach(() => {
    gateway.onModuleDestroy();
  });

  describe('getQuote', () => {
    it('routes stock symbols to stock snapshots', async () => {
      const quote = await gateway.getQuote('u1', 'SPY');
      expect(quote.last).toBe(500);
      expect(quote.bid).toBe(499.9);
      const snaps = callsTo('/openapi/market-data/stock/snapshot');
      expect(snaps).toHaveLength(1);
      expect(snaps[0].url).toContain('symbols=SPY');
      expect(snaps[0].url).toContain('category=US_STOCK');
    });

    it('routes OCC symbols to option snapshots', async () => {
      const quote = await gateway.getQuote('u1', 'SPY260717C00505000');
      expect(quote.last).toBe(1.05);
      expect(callsTo('/openapi/market-data/option/snapshot')[0].url).toContain(
        'symbols=SPY260717C00505000',
      );
    });

    it('translates futures symbols to Webull 1-digit years on the wire', async () => {
      const quote = await gateway.getQuote('u1', 'ESZ26');
      expect(quote.symbol).toBe('ESZ26'); // app keeps the project symbol
      expect(quote.last).toBe(6001);
      expect(
        callsTo('/openapi/market-data/futures/snapshot')[0].url,
      ).toContain('symbols=ESZ6');
    });

    it('throws CONTRACT_NOT_FOUND for unknown symbols', async () => {
      handlers['GET /openapi/market-data/stock/snapshot'] = () => ({
        status: 200,
        body: [],
      });
      await expect(gateway.getQuote('u1', 'NOPE')).rejects.toMatchObject({
        code: 'CONTRACT_NOT_FOUND',
      });
    });
  });

  describe('getOptionsChain (snapshot-probe synthesis)', () => {
    it('synthesizes ±12 strikes × $5 around ATM via snapshot probing', async () => {
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
        expect(contract.bid).toBe(1.0);
        expect(contract.ask).toBe(1.1);
      }
      // 50 candidates probed in batches of ≤ 20.
      const probes = callsTo('/openapi/market-data/option/snapshot');
      expect(probes.length).toBe(3);
    });

    it('drops strikes the snapshot endpoint does not return', async () => {
      const base = defaultHandlers()['GET /openapi/market-data/option/snapshot'];
      handlers['GET /openapi/market-data/option/snapshot'] = (call) => {
        const res = base(call) as { status: number; body: any[] };
        res.body = res.body.filter(
          (row) => (parseOccSymbol(row.symbol)?.strike ?? 0) <= 500,
        );
        return res;
      };
      const chain = await gateway.getOptionsChain('u1', 'SPY');
      expect(chain.contracts.length).toBeGreaterThan(0);
      expect(chain.contracts.every((c) => c.strike <= 500)).toBe(true);
    });

    it('rejects an expiration that is not probed', async () => {
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
        bid: 6000.75,
        ask: 6001.25,
      });
      expect(contracts[1]).toMatchObject({
        symbol: 'ESH27',
        frontMonth: false,
        expiration: '2027-03-19',
      });
      // Instruments are queried with Webull-native symbols.
      expect(
        callsTo('/openapi/market-data/futures/snapshot')[0].url,
      ).toContain('symbols=ESZ6%2CESH7');
    });

    it('rejects an unknown root', async () => {
      handlers['GET /openapi/instrument/futures/by-code'] = () => ({
        status: 200,
        body: [],
      });
      await expect(gateway.getFuturesContracts('u1', 'ZZ')).rejects.toMatchObject(
        { code: 'CONTRACT_NOT_FOUND' },
      );
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

    it('uses the broker preview estimate and live mid pricing', async () => {
      const preview = await gateway.previewOrder('u1', order);
      // auto_otm call above 500 with $5 increment → 505.
      expect(parseOccSymbol(preview.resolved.contractSymbol)).toMatchObject({
        underlying: 'SPY',
        strike: 505,
        optionType: 'call',
      });
      expect(preview.resolved.price).toBe(1.05); // mid of 1.00/1.10
      expect(preview.resolved.estBuyingPower).toBe(210);
      const previews = callsTo('/openapi/trade/order/preview');
      expect(previews).toHaveLength(1);
      expect(previews[0].body.account_id).toBe('ACC-1');
    });

    it('falls back to the local estimate when the broker preview fails', async () => {
      handlers['POST /openapi/trade/order/preview'] = () => ({
        status: 500,
        body: {},
      });
      const preview = await gateway.previewOrder('u1', order);
      // 2 contracts × 1.05 × 100 multiplier
      expect(preview.resolved.estBuyingPower).toBe(210);
      expect(
        preview.warnings.some((w) => w.includes('local estimate')),
      ).toBe(true);
    });

    it('warns on market orders for options', async () => {
      const preview = await gateway.previewOrder('u1', {
        ...order,
        orderType: 'market',
      });
      expect(preview.warnings.some((w) => w.includes('Market order'))).toBe(true);
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

    it('derives a deterministic MD5 client_order_id and maps the option body', async () => {
      const result = await gateway.placeOrder('u1', order, 'idem-key-1');
      const expectedId = createHash('md5').update('idem-key-1').digest('hex');
      expect(result.orderId).toBe(expectedId);
      expect(result.status).toBe('submitted');

      const place = callsTo('/openapi/trade/order/place')[0];
      expect(place.body.account_id).toBe('ACC-1');
      const newOrder = place.body.new_orders[0];
      expect(newOrder).toMatchObject({
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
      expect(newOrder.legs[0]).toMatchObject({
        symbol: 'SPY',
        strike_price: '505',
        option_type: 'CALL',
        option_expire_date: TODAY,
        instrument_type: 'OPTION',
        market: 'US',
      });
    });

    it('closes an existing short with BUY_TO_CLOSE', async () => {
      const chain = await gateway.getOptionsChain('u1', 'SPY');
      const target = chain.contracts.find(
        (c) => c.optionType === 'call' && c.strike === 505,
      )!;
      handlers['GET /openapi/assets/positions'] = () => ({
        status: 200,
        body: [
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
        ],
      });
      await gateway.placeOrder('u1', order, 'idem-key-2');
      const place = callsTo('/openapi/trade/order/place')[0];
      expect(place.body.new_orders[0].position_intent).toBe('BUY_TO_CLOSE');
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
      const place = callsTo('/openapi/trade/order/place')[0];
      const newOrder = place.body.new_orders[0];
      expect(newOrder).toMatchObject({
        instrument_type: 'FUTURES',
        symbol: 'ESZ6',
        side: 'SELL',
        order_type: 'MARKET',
        market: 'US',
      });
      expect(newOrder.legs).toBeUndefined();
      expect(newOrder.limit_price).toBeUndefined();
    });

    it('emits an orderUpdate when the status poll sees a fill', async () => {
      jest.useFakeTimers();
      try {
        const emitted: unknown[] = [];
        events.events$.subscribe((e) => emitted.push(e));
        const result = await gateway.placeOrder('u1', order, 'idem-key-4');
        handlers['GET /openapi/trade/order/detail'] = () => ({
          status: 200,
          body: {
            client_order_id: result.orderId,
            status: 'FILLED',
            filled_price: '1.04',
            quantity: '1',
          },
        });
        await jest.advanceTimersByTimeAsync(1_100);
        expect(emitted).toHaveLength(2); // initial submitted + filled
        expect(emitted[1]).toMatchObject({
          userId: 'u1',
          order: { status: 'filled', filledPrice: 1.04, orderId: result.orderId },
        });
        // Poll stopped at the terminal status — no more detail calls.
        const detailCalls = callsTo('/openapi/trade/order/detail').length;
        await jest.advanceTimersByTimeAsync(3_000);
        expect(callsTo('/openapi/trade/order/detail').length).toBe(detailCalls);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('cancelOrder', () => {
    const openOptionOrder = {
      client_order_id: 'abc',
      status: 'SUBMITTED',
      instrument_type: 'OPTION',
      symbol: 'SPY',
      side: 'BUY',
      order_type: 'LIMIT',
      limit_price: '1.05',
      quantity: '1',
      legs: [
        {
          symbol: 'SPY',
          strike_price: '505',
          option_expire_date: TODAY,
          option_type: 'CALL',
        },
      ],
    };

    it('cancels by client_order_id and emits the cancelled update', async () => {
      handlers['GET /openapi/trade/order/open'] = () => ({
        status: 200,
        body: [openOptionOrder],
      });
      const emitted: unknown[] = [];
      events.events$.subscribe((e) => emitted.push(e));
      await gateway.cancelOrder('u1', 'abc');
      const cancels = callsTo('/openapi/trade/order/cancel');
      expect(cancels).toHaveLength(1);
      expect(cancels[0].body).toMatchObject({
        account_id: 'ACC-1',
        client_order_id: 'abc',
      });
      expect(emitted[0]).toMatchObject({
        userId: 'u1',
        order: { orderId: 'abc', status: 'cancelled' },
      });
    });

    it('maps unknown orders to ORDER_NOT_FOUND', async () => {
      await expect(gateway.cancelOrder('u1', 'abc')).rejects.toMatchObject({
        code: 'ORDER_NOT_FOUND',
      });
      expect(callsTo('/openapi/trade/order/cancel')).toHaveLength(0);
    });
  });

  describe('getPositions / getOpenOrders', () => {
    it('filters positions to options and futures, translating futures symbols', async () => {
      handlers['GET /openapi/assets/positions'] = () => ({
        status: 200,
        body: [
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
        ],
      });
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
      handlers['GET /openapi/trade/order/open'] = () => ({
        status: 200,
        body: [
          { client_order_id: 'a', status: 'SUBMITTED', symbol: 'SPY' },
          { client_order_id: 'b', status: 'FILLED', symbol: 'SPY' },
        ],
      });
      const orders = await gateway.getOpenOrders('u1');
      expect(orders.map((o) => o.orderId)).toEqual(['a']);
    });
  });
});
