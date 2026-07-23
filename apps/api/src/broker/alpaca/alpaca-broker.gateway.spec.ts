import { OrderPreview, OrderRequest, OrderResult, Position, Quote } from '@0dtetrader/shared-types';
import { AlpacaBrokerGateway } from './alpaca-broker.gateway';
import { AlpacaClientLike, AlpacaFactory } from './alpaca-sdk.types';
import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderEventsService } from '../order-events.service';
import { formatOccSymbol } from '../contract-resolution';
import { optionExpirations } from '../expiration-calendar';

const SYMBOL = 'SPY';
const UNDER = 100;
const EXPIRATION = optionExpirations(SYMBOL, new Date())[0];
const EXPECTED_OCC = formatOccSymbol(SYMBOL, EXPIRATION, 'call', 105);

function bar(t: Date) {
  return { timestamp: t, open: 5, high: 5.2, low: 4.9, close: 5.1, volume: 100 };
}

/**
 * A fake of the SDK client surface the gateway depends on. It records every
 * call so tests can assert which SDK methods fire (and with what args), and
 * returns SDK-shaped response objects that the mappers translate into DTOs.
 */
function makeFakeClient() {
  const calls: Array<{
    method: string;
    req?: unknown;
    symbol?: string;
    input?: unknown;
    params?: unknown;
  }> = [];
  const client: AlpacaClientLike = {
    marketData: {
      collectOptionSnapshotsBySymbol: async (req) => {
        calls.push({ method: 'collectOptionSnapshotsBySymbol', req });
        return {
          [req.symbols[0]]: {
            latestQuote: { bp: 5, ap: 5.5, bps: 10, aps: 12, t: '2024-01-01T15:00:00Z' },
            latestTrade: { p: 5.25, s: 100, t: '2024-01-01T15:00:00Z' },
          },
        };
      },
      stocks: {
        stockSnapshots: async (req) => {
          calls.push({ method: 'stockSnapshots', req });
          return {
            [req.symbols[0]]: {
              latestQuote: {
                bp: UNDER - 1,
                ap: UNDER + 1,
                bps: 5,
                aps: 5,
                t: '2024-01-01T15:00:00Z',
              },
              latestTrade: { p: UNDER, s: 1000, t: '2024-01-01T15:00:00Z' },
              dailyBar: { v: 5000 },
            },
          };
        },
      },
      getOptionBarsFor: async (symbol, req) => {
        calls.push({ method: 'getOptionBarsFor', symbol, req });
        return [bar(new Date('2024-01-02T15:00:00Z'))];
      },
      getStockBarsFor: async (symbol, req) => {
        calls.push({ method: 'getStockBarsFor', symbol, req });
        return [bar(new Date('2024-01-02T15:00:00Z'))];
      },
      collectOptionChainBySymbol: async (req) => {
        calls.push({ method: 'collectOptionChainBySymbol', req });
        return {
          [EXPECTED_OCC]: {
            latestQuote: { bp: 4, ap: 4.5, bps: 1, aps: 1, t: '2024-01-01T15:00:00Z' },
            latestTrade: { p: 4.25, s: 1, t: '2024-01-01T15:00:00Z' },
          },
        };
      },
    },
    trading: {
      orders: {
        submit: async (input) => {
          calls.push({ method: 'submit', input });
          return {
            id: 'ord-server-1',
            client_order_id: input.clientOrderId,
            status: 'new',
            symbol: input.symbol,
            side: input.side,
            type: input.type,
            qty: String(input.qty),
            filled_qty: '0',
            filled_avg_price: null,
            limit_price: input.limitPrice != null ? String(input.limitPrice) : null,
            submitted_at: '2024-01-01T15:00:00Z',
          };
        },
        getAllOrders: async (params) => {
          calls.push({ method: 'getAllOrders', params });
          return [
            {
              id: 'ord-server-1',
              client_order_id: 'abc',
              status: 'new',
              symbol: EXPECTED_OCC,
              side: 'buy',
              type: 'limit',
              qty: '1',
              filled_qty: '0',
              filled_avg_price: null,
              limit_price: '4.25',
              submitted_at: '2024-01-01T15:00:00Z',
            },
          ];
        },
        getOrderByClientOrderId: async (params) => {
          calls.push({ method: 'getOrderByClientOrderId', params });
          return {
            id: 'ord-server-1',
            client_order_id: params.clientOrderId,
            status: 'new',
            symbol: EXPECTED_OCC,
            side: 'buy',
            type: 'limit',
            qty: '1',
            filled_qty: '0',
            filled_avg_price: null,
            limit_price: '4.25',
            submitted_at: '2024-01-01T15:00:00Z',
          };
        },
        deleteOrderByOrderID: async (params) => {
          calls.push({ method: 'deleteOrderByOrderID', params });
        },
      },
      positions: {
        getAllOpenPositions: async () => {
          calls.push({ method: 'getAllOpenPositions' });
          return [
            {
              asset_class: 'us_option',
              symbol: EXPECTED_OCC,
              qty: '2',
              avg_entry_price: '4',
              current_price: '4.5',
              unrealized_pl: '1',
            },
          ];
        },
      },
    },
  };
  return { client, calls };
}

function buildGateway() {
  const { client, calls } = makeFakeClient();
  const alpacaFactory: AlpacaFactory = () => client;
  const credentials = {
    getDecrypted: jest.fn(async () => ({ provider: 'alpaca', apiKey: 'k', apiSecret: 's' })),
    getMode: jest.fn(async () => 'live'),
  } as unknown as CredentialsService;
  const events = { emit: jest.fn() } as unknown as OrderEventsService;
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ tradingMode: 'live' })) },
  } as unknown as PrismaService;
  const gateway = new AlpacaBrokerGateway(credentials, events, prisma, alpacaFactory);
  return { gateway, calls, events };
}

const ORDER: OrderRequest = {
  underlying: SYMBOL,
  assetClass: 'option',
  side: 'buy',
  quantity: 1,
  orderType: 'mid',
  selection: { mode: 'explicit', optionType: 'call', expiration: EXPIRATION, strike: 105 },
};

describe('AlpacaBrokerGateway (SDK-backed)', () => {
  let env: ReturnType<typeof buildGateway>;

  afterEach(async () => {
    if (env) await env.gateway.onModuleDestroy();
  });

  it('getQuote routes an option symbol to collectOptionSnapshotsBySymbol', async () => {
    env = buildGateway();
    const q: Quote = await env.gateway.getQuote('user-1', EXPECTED_OCC);
    const call = env.calls.find((c) => c.method === 'collectOptionSnapshotsBySymbol');
    expect(call).toBeDefined();
    expect((call!.req as { symbols: string[] }).symbols).toEqual([EXPECTED_OCC]);
    expect(q.bid).toBe(5);
    expect(q.ask).toBe(5.5);
    expect(q.last).toBe(5.25);
  });

  it('getQuote routes an equity symbol to stockSnapshots', async () => {
    env = buildGateway();
    const q: Quote = await env.gateway.getQuote('user-1', SYMBOL);
    const call = env.calls.find((c) => c.method === 'stockSnapshots');
    expect(call).toBeDefined();
    expect((call!.req as { symbols: string[] }).symbols).toEqual([SYMBOL]);
    expect(q.bid).toBe(UNDER - 1);
    expect(q.ask).toBe(UNDER + 1);
    expect(q.last).toBe(UNDER);
  });

  it('getCandles fetches stock bars via the SDK', async () => {
    env = buildGateway();
    const candles = await env.gateway.getCandles('user-1', SYMBOL, { interval: '1d' });
    const call = env.calls.find((c) => c.method === 'getStockBarsFor');
    expect(call).toBeDefined();
    expect(call!.symbol).toBe(SYMBOL);
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(5.1);
  });

  it('getOptionsChain reads the v1beta1 chain and tags underlying price', async () => {
    env = buildGateway();
    const chain = await env.gateway.getOptionsChain('user-1', SYMBOL);
    const call = env.calls.find((c) => c.method === 'collectOptionChainBySymbol');
    expect(call).toBeDefined();
    expect((call!.req as { underlyingSymbol: string }).underlyingSymbol).toBe(SYMBOL);
    expect(chain.contracts.map((c) => c.symbol)).toContain(EXPECTED_OCC);
    expect(chain.underlyingPrice).toBe(UNDER);
  });

  it('previewOrder resolves the contract and estimates buying power', async () => {
    env = buildGateway();
    const preview: OrderPreview = await env.gateway.previewOrder('user-1', ORDER);
    expect(preview.resolved.contractSymbol).toBe(EXPECTED_OCC);
    expect(preview.resolved.estBuyingPower).toBeGreaterThan(0);
    expect(Array.isArray(preview.warnings)).toBe(true);
  });

  it('placeOrder submits to Alpaca with the resolved OCC + idempotency key', async () => {
    env = buildGateway();
    const res = await env.gateway.placeOrder('user-1', ORDER, 'test-key');
    const submit = env.calls.find((c) => c.method === 'submit');
    expect(submit).toBeDefined();
    const input = submit!.input as {
      symbol: string;
      assetClass: string;
      type: string;
      clientOrderId: string;
    };
    expect(input.symbol).toBe(EXPECTED_OCC);
    expect(input.assetClass).toBe('us_option');
    expect(input.type).toBe('limit'); // 'mid' maps to an Alpaca limit order
    expect(input.clientOrderId).toHaveLength(32);
    expect(res.orderId).toBe(input.clientOrderId);
    expect(res.contractSymbol).toBe(EXPECTED_OCC);
    expect(res.orderType).toBe('mid');
  });

  it('cancelOrder resolves client id then deletes the server order', async () => {
    env = buildGateway();
    await env.gateway.cancelOrder('user-1', 'abc');
    const byId = env.calls.find((c) => c.method === 'getOrderByClientOrderId');
    const del = env.calls.find((c) => c.method === 'deleteOrderByOrderID');
    expect(byId).toBeDefined();
    expect((byId!.params as { clientOrderId: string }).clientOrderId).toBe('abc');
    expect(del).toBeDefined();
    expect((del!.params as { orderId: string }).orderId).toBe('ord-server-1');
  });

  it('reauthenticate returns the stored trading mode', async () => {
    env = buildGateway();
    expect(await env.gateway.reauthenticate('user-1')).toBe('live');
  });

  it('getPositions maps option positions with multiplier 100', async () => {
    env = buildGateway();
    const positions: Position[] = await env.gateway.getPositions('user-1');
    expect(positions).toHaveLength(1);
    expect(positions[0].assetClass).toBe('option');
    expect(positions[0].multiplier).toBe(100);
    expect(positions[0].symbol).toBe(EXPECTED_OCC);
  });

  it('getOpenOrders filters to open Alpaca orders', async () => {
    env = buildGateway();
    const orders: OrderResult[] = await env.gateway.getOpenOrders('user-1');
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('submitted'); // 'new' -> 'submitted'
    expect(orders[0].contractSymbol).toBe(EXPECTED_OCC);
  });
});
