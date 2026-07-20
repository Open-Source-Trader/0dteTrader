import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { OrderRequest } from '@0dtetrader/shared-types';
import { CredentialsService } from '../credentials/credentials.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrderEventsService } from './order-events.service';
import { parseOccSymbol } from './contract-resolution';
import { optionExpirations } from './expiration-calendar';
import { WebullBrokerGateway } from './webull/webull-broker.gateway';
import { FetchImpl, WebullCredentials } from './webull/webull-client';

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

/** The expiration an unqualified SPY order resolves to (nearest listed). */
const NEAREST_EXPIRATION = optionExpirations('SPY', new Date())[0];

function defaultHandlers(): Record<string, Handler> {
  const perSymbol = (call: RecordedCall, make: (symbol: string) => Record<string, unknown>) => {
    const symbols = new URL(call.url).searchParams.get('symbols') ?? '';
    return {
      status: 200,
      body: symbols.split(',').filter(Boolean).map(make),
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
    'GET /openapi/assets/balance': () => ({
      status: 200,
      body: {
        account_currency_assets: [
          { currency: 'USD', buying_power: '25000', option_buying_power: '25000' },
        ],
      },
    }),
    'GET /openapi/account/list': () => ({
      status: 200,
      body: [{ account_id: 'ACC-DISCOVERED', account_number: 'X1' }],
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
  };
}

describe('WebullBrokerGateway', () => {
  let calls: RecordedCall[];
  let handlers: Record<string, Handler>;
  let events: OrderEventsService;
  let gateway: WebullBrokerGateway;
  /** Per-user trading mode the fake Prisma reports. */
  let tradingMode: string;
  /** Stored credentials per environment the fake CredentialsService reports. */
  let storedCreds: Partial<Record<'live' | 'practice', WebullCredentials>>;
  let configValues: Record<string, unknown>;
  let savedAccountIds: jest.Mock;
  /** Saved override so the Prisma-client dotenv autoload can't leak into hosts(). */
  let savedDataBaseUrl: string | undefined;

  const callsTo = (path: string): RecordedCall[] => calls.filter((c) => c.path === path);

  beforeEach(() => {
    calls = [];
    handlers = defaultHandlers();
    tradingMode = 'live';
    savedDataBaseUrl = process.env.WEBULL_MARKET_DATA_BASE_URL;
    delete process.env.WEBULL_MARKET_DATA_BASE_URL;
    storedCreds = {
      live: { appKey: 'AK', appSecret: 'SK', accountId: 'ACC-1' },
    };
    configValues = {
      webull: {
        apiBaseUrl: 'https://api.sandbox.webull.com',
        marketDataBaseUrl: '',
        practiceAppKey: 'PAK',
        practiceAppSecret: 'PSK',
        practiceAccountId: 'PACC',
      },
    };
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
      getDecrypted: jest.fn(
        async (
          _userId: string,
          _provider?: 'webull' | 'alpaca',
          environment: 'live' | 'practice' = 'live',
        ) => storedCreds[environment] ?? null,
      ),
      saveDiscoveredAccountId: jest.fn(async () => undefined),
    } as unknown as CredentialsService;
    savedAccountIds = credentials.saveDiscoveredAccountId as jest.Mock;
    const config = new ConfigService(configValues);
    const prisma = {
      user: {
        findUnique: jest.fn(async () => ({ id: 'u1', tradingMode })),
      },
    } as unknown as PrismaService;
    events = new OrderEventsService();
    gateway = new WebullBrokerGateway(credentials, config, events, prisma, undefined, fetchImpl);
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    if (savedDataBaseUrl === undefined) {
      delete process.env.WEBULL_MARKET_DATA_BASE_URL;
    } else {
      process.env.WEBULL_MARKET_DATA_BASE_URL = savedDataBaseUrl;
    }
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

  describe('getCandles', () => {
    const BAR = {
      symbol: 'SPY',
      time: '2026-07-17T19:59:00.000+0000',
      open: '1',
      high: '2',
      low: '0.5',
      close: '1.5',
      volume: '10',
    };

    it('falls back to the latest bars when the requested window is empty (weekend)', async () => {
      handlers['GET /openapi/market-data/stock/bars'] = (call) => ({
        status: 200,
        body: new URL(call.url).searchParams.has('start_time') ? [] : [BAR],
      });
      const candles = await gateway.getCandles('u1', 'SPY', {
        interval: '1m',
        from: new Date(Date.now() - 400 * 60 * 1000).toISOString(),
      });
      expect(candles).toHaveLength(1);
      const barsCalls = callsTo('/openapi/market-data/stock/bars');
      expect(barsCalls).toHaveLength(2);
      expect(barsCalls[0].url).toContain('start_time=');
      expect(barsCalls[1].url).not.toContain('start_time=');
    });

    it('does not refetch when the windowed request returns bars', async () => {
      handlers['GET /openapi/market-data/stock/bars'] = () => ({
        status: 200,
        body: [BAR],
      });
      const candles = await gateway.getCandles('u1', 'SPY', {
        interval: '1m',
        from: new Date(Date.now() - 400 * 60 * 1000).toISOString(),
      });
      expect(candles).toHaveLength(1);
      expect(callsTo('/openapi/market-data/stock/bars')).toHaveLength(1);
    });

    it('requests the latest bars directly when no window is given', async () => {
      handlers['GET /openapi/market-data/stock/bars'] = () => ({
        status: 200,
        body: [BAR],
      });
      await gateway.getCandles('u1', 'SPY', { interval: '1m' });
      const barsCalls = callsTo('/openapi/market-data/stock/bars');
      expect(barsCalls).toHaveLength(1);
      expect(barsCalls[0].url).not.toContain('start_time=');
    });
  });

  describe('trading mode (live / practice)', () => {
    it('live mode uses the prod hosts and the live credential set', async () => {
      tradingMode = 'live';
      await gateway.getQuote('u1', 'SPY');
      // First call is the token create against the trade API host.
      expect(calls[0].url).toContain('https://api.webull.com');
      expect(calls[0].headers['x-app-key']).toBe('AK');
      const snap = callsTo('/openapi/market-data/stock/snapshot')[0];
      expect(snap.url).toContain('https://data-api.webull.com');
    });

    it('practice mode uses the sandbox hosts and stored practice credentials', async () => {
      tradingMode = 'practice';
      storedCreds.practice = { appKey: 'PAK-U', appSecret: 'PSK-U', accountId: 'PACC-U' };
      await gateway.getQuote('u1', 'SPY');
      expect(calls[0].url).toContain('https://api.sandbox.webull.com');
      expect(calls[0].headers['x-app-key']).toBe('PAK-U');
      const snap = callsTo('/openapi/market-data/stock/snapshot')[0];
      expect(snap.url).toContain('https://data-api.sandbox.webull.com');
    });

    it("practice mode falls back to the server's built-in practice credentials", async () => {
      tradingMode = 'practice';
      // No stored practice credentials: storedCreds.practice stays undefined.
      await gateway.getQuote('u1', 'SPY');
      expect(calls[0].url).toContain('https://api.sandbox.webull.com');
      expect(calls[0].headers['x-app-key']).toBe('PAK');
    });

    it('practice mode fails with an auth error when no credentials exist at all', async () => {
      tradingMode = 'practice';
      (configValues.webull as Record<string, string>).practiceAppKey = '';
      (configValues.webull as Record<string, string>).practiceAppSecret = '';
      await expect(gateway.getQuote('u1', 'SPY')).rejects.toMatchObject({
        code: 'BROKER_AUTH_FAILED',
      });
      expect(calls).toHaveLength(0);
    });

    it('caches clients per (user, mode) so modes do not share a client', async () => {
      await gateway.getQuote('u1', 'SPY');
      tradingMode = 'practice';
      await gateway.getQuote('u1', 'SPY');
      // Two token creates: one per environment client.
      expect(callsTo('/openapi/auth/token/create')).toHaveLength(2);
      expect(calls[0].headers['x-app-key']).toBe('AK');
      // Practice fell back to the built-in practice credentials.
      const practiceToken = callsTo('/openapi/auth/token/create')[1];
      expect(practiceToken.headers['x-app-key']).toBe('PAK');
    });

    it('reauthenticate drops the cached client and mints a fresh token', async () => {
      await gateway.getQuote('u1', 'SPY');
      expect(callsTo('/openapi/auth/token/create')).toHaveLength(1);

      await expect(gateway.reauthenticate('u1')).resolves.toBe('live');
      // Full create, not refresh — the stale token is discarded, not reused.
      expect(callsTo('/openapi/auth/token/create')).toHaveLength(2);
      expect(callsTo('/openapi/auth/token/refresh')).toHaveLength(0);

      // The fresh client caches its token: no third create on the next call.
      await gateway.getQuote('u1', 'SPY');
      expect(callsTo('/openapi/auth/token/create')).toHaveLength(2);
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
        res.body = res.body.filter((row) => (parseOccSymbol(row.symbol)?.strike ?? 0) <= 500);
        return res;
      };
      const chain = await gateway.getOptionsChain('u1', 'SPY');
      expect(chain.contracts.length).toBeGreaterThan(0);
      expect(chain.contracts.every((c) => c.strike <= 500)).toBe(true);
    });

    it('rejects an expiration that is not probed', async () => {
      await expect(gateway.getOptionsChain('u1', 'SPY', '1999-01-01')).rejects.toMatchObject({
        code: 'CONTRACT_NOT_FOUND',
      });
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
      expect(preview.warnings.some((w) => w.includes('local estimate'))).toBe(true);
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

    it('derives a deterministic user-scoped MD5 client_order_id and maps the option body', async () => {
      const result = await gateway.placeOrder('u1', order, 'idem-key-1');
      const expectedId = createHash('md5').update('u1:idem-key-1').digest('hex');
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
        option_expire_date: NEAREST_EXPIRATION,
        instrument_type: 'OPTION',
        market: 'US',
      });
    });

    it('closes an existing short with BUY_TO_CLOSE', async () => {
      const chain = await gateway.getOptionsChain('u1', 'SPY');
      const target = chain.contracts.find((c) => c.optionType === 'call' && c.strike === 505)!;
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
          option_expire_date: NEAREST_EXPIRATION,
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
    it('filters positions to options only', async () => {
      handlers['GET /openapi/assets/positions'] = () => ({
        status: 200,
        body: [
          { instrument_type: 'EQUITY', symbol: 'AAPL', quantity: '10' },
          {
            instrument_type: 'OPTION',
            symbol: 'SPY',
            quantity: '1',
            cost_price: '1.5',
            last_price: '1.6',
            unrealized_profit_loss: '10',
            legs: [
              {
                symbol: 'SPY',
                strike_price: '505',
                option_expire_date: NEAREST_EXPIRATION,
                option_type: 'CALL',
              },
            ],
          },
        ],
      });
      const positions = await gateway.getPositions('u1');
      expect(positions).toEqual([
        {
          symbol: `SPY${NEAREST_EXPIRATION.slice(2).replace(/-/g, '')}C00505000`,
          assetClass: 'option',
          quantity: 1,
          avgPrice: 1.5,
          markPrice: 1.6,
          unrealizedPnl: 10,
          multiplier: 100,
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

  describe('account id auto-discovery (official flow: GET account/list)', () => {
    beforeEach(() => {
      // Credentials saved without an account id — the normal case now.
      storedCreds = { live: { appKey: 'AK', appSecret: 'SK' } };
    });

    it('discovers, uses, and persists the account id on first account call', async () => {
      await gateway.getPositions('u1');
      expect(callsTo('/openapi/account/list')).toHaveLength(1);
      const positions = callsTo('/openapi/assets/positions');
      expect(positions[0].url).toContain('account_id=ACC-DISCOVERED');
      expect(savedAccountIds).toHaveBeenCalledWith('u1', 'webull', 'live', 'ACC-DISCOVERED');
    });

    it('discovers only once — later calls reuse the resolved id', async () => {
      await gateway.getPositions('u1');
      await gateway.getOpenOrders('u1');
      expect(callsTo('/openapi/account/list')).toHaveLength(1);
      expect(callsTo('/openapi/trade/order/open')[0].url).toContain('account_id=ACC-DISCOVERED');
    });

    it('accepts the {accounts: [...]} response wrapper', async () => {
      handlers['GET /openapi/account/list'] = () => ({
        status: 200,
        body: { accounts: [{ account_id: 'ACC-NESTED' }] },
      });
      await gateway.getPositions('u1');
      expect(callsTo('/openapi/assets/positions')[0].url).toContain('account_id=ACC-NESTED');
    });

    it('fails with an auth error when no accounts come back', async () => {
      handlers['GET /openapi/account/list'] = () => ({ status: 200, body: [] });
      await expect(gateway.getPositions('u1')).rejects.toMatchObject({
        code: 'BROKER_AUTH_FAILED',
      });
    });

    it('skips discovery entirely when an account id is stored', async () => {
      storedCreds = { live: { appKey: 'AK', appSecret: 'SK', accountId: 'ACC-1' } };
      await gateway.getPositions('u1');
      expect(callsTo('/openapi/account/list')).toHaveLength(0);
      expect(callsTo('/openapi/assets/positions')[0].url).toContain('account_id=ACC-1');
    });
  });
});
