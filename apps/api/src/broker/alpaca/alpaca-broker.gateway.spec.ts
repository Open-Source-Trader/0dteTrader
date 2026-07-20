import { ConfigService } from '@nestjs/config';
import { Candle, OrderRequest, Quote } from '@0dtetrader/shared-types';
import { formatOccSymbol } from '../contract-resolution';
import { optionExpirations } from '../expiration-calendar';
import { OrderEventsService } from '../order-events.service';
import { AlpacaBrokerGateway } from './alpaca-broker.gateway';
import { FetchImpl } from './alpaca-client';

/** A recorded outbound call. */
interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

const SYMBOL = 'SPY';
const EXP = optionExpirations(SYMBOL, new Date())[0];
const UNDER = 100;
const CALL_STRIKE = 105;
const EXPECTED_OCC = formatOccSymbol(SYMBOL, EXP, 'call', CALL_STRIKE);

/** The Webull-equivalent OCC the gateway should build for the placed order. */
function stockSnap(_symbol: string) {
  return {
    latestQuote: { bp: UNDER - 1, ap: UNDER + 1, bps: 10, aps: 20, t: '2025-06-21T13:30:00.000Z' },
    latestTrade: { p: UNDER, s: 5, t: '2025-06-21T13:30:00.000Z' },
  };
}
function optionSnap(_symbol: string) {
  return {
    latestQuote: { bp: 5, ap: 5.5, bps: 3, aps: 4, t: '2025-06-21T13:30:00.000Z' },
  };
}

describe('AlpacaBrokerGateway', () => {
  let calls: Call[];
  let fetchImpl: FetchImpl;
  let gateway: AlpacaBrokerGateway;
  let events: OrderEventsService;
  /** Per-user trading mode the fake Prisma reports. */
  let tradingMode: string;
  /** Fake credential store (flipped per test). */
  let credentials: ConstructorParameters<typeof AlpacaBrokerGateway>[0];

  beforeEach(() => {
    calls = [];
    tradingMode = 'live';
    fetchImpl = jest.fn(async (url: string, init) => {
      let parsedBody: Record<string, unknown> | undefined;
      try {
        parsedBody = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      } catch {
        parsedBody = undefined;
      }
      calls.push({ url, method: init.method, body: parsedBody });
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        u = new URL('http://localhost');
      }
      const path = u.pathname;
      const respond = (status: number, payload: unknown) => ({
        status,
        headers: { get: () => null },
        json: async () => payload,
      });
      if (path.endsWith('/v2/stocks/snapshots')) {
        return respond(200, { [u.searchParams.get('symbols')!]: stockSnap(SYMBOL) });
      }
      if (path.endsWith('/v2/options/snapshots')) {
        return respond(200, { [u.searchParams.get('symbols')!]: optionSnap(EXPECTED_OCC) });
      }
      if (path.endsWith(`/v2/stocks/${SYMBOL}/bars`)) {
        return respond(200, [
          { t: '2025-06-21T13:00:00.000Z', o: 99, h: 101, l: 98, c: 100, v: 1000 },
          { t: '2025-06-21T13:01:00.000Z', o: 100, h: 102, l: 99, c: 101, v: 1100 },
        ]);
      }
      if (path.endsWith('/v2/options/chains')) {
        return respond(200, {
          underlying: { symbol: SYMBOL },
          options: [
            {
              symbol: EXPECTED_OCC,
              strike: CALL_STRIKE,
              type: 'call',
              expiration_date: EXP,
              bid: 4,
              ask: 4.5,
            },
            {
              symbol: formatOccSymbol(SYMBOL, EXP, 'put', 95),
              strike: 95,
              type: 'put',
              expiration_date: EXP,
              bid: 3,
              ask: 3.5,
            },
          ],
        });
      }
      if (path.endsWith('/v2/positions')) {
        return respond(200, [
          {
            symbol: EXPECTED_OCC,
            qty: '2',
            avg_entry_price: '5',
            current_price: '5.5',
            unrealized_pl: '1',
            asset_class: 'us_option',
          },
        ]);
      }
      if (path.endsWith('/v2/orders') && init.method === 'POST') {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(init.body!) as Record<string, unknown>;
        } catch {
          body = {};
        }
        return respond(200, {
          id: 'ord-1',
          client_order_id: body.client_order_id,
          status: 'new',
          symbol: body.symbol,
          side: 'buy',
          type: 'limit',
          qty: '1',
          submitted_at: '2025-06-21T13:30:00.000Z',
        });
      }
      if (path.endsWith('/v2/orders') && init.method === 'GET') {
        return respond(200, [
          {
            id: 'ord-1',
            client_order_id: 'cid-1',
            status: 'new',
            symbol: EXPECTED_OCC,
            side: 'buy',
            type: 'limit',
            qty: '1',
            submitted_at: '2025-06-21T13:30:00.000Z',
          },
        ]);
      }
      if (/\/v2\/orders\/client:.+/.test(url)) {
        return respond(204, null);
      }
      if (/\/v2\/orders\/.+/.test(path)) {
        return respond(200, {
          id: 'ord-1',
          client_order_id: 'cid-1',
          status: 'filled',
          symbol: EXPECTED_OCC,
          side: 'buy',
          type: 'limit',
          qty: '1',
          filled_avg_price: '5',
          submitted_at: '2025-06-21T13:30:00.000Z',
        });
      }
      return respond(404, { message: 'not found' });
    });

    const config = new ConfigService({
      alpaca: {
        tradingBaseUrl: 'https://api.alpaca.markets',
        paperTradingBaseUrl: 'https://paper-api.alpaca.markets',
        dataBaseUrl: 'https://data.alpaca.markets',
        paperDataBaseUrl: 'https://paper-data.alpaca.markets',
      },
    });
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ id: 'u1', tradingMode })) },
    } as unknown as ConstructorParameters<typeof AlpacaBrokerGateway>[3];
    credentials = {
      getDecrypted: jest.fn(
        async (_u: string, _p: 'webull' | 'alpaca', environment: 'live' | 'practice') =>
          environment === 'practice'
            ? { provider: 'alpaca', apiKey: 'PAK', apiSecret: 'PAS' }
            : { provider: 'alpaca', apiKey: 'AK', apiSecret: 'AS' },
      ),
    } as unknown as ConstructorParameters<typeof AlpacaBrokerGateway>[0];
    events = { emit: jest.fn() } as unknown as OrderEventsService;

    gateway = new AlpacaBrokerGateway(credentials, config, events, prisma, fetchImpl);
  });

  describe('trading mode (live / practice)', () => {
    it('live mode uses the live hosts and the live credential set', async () => {
      await gateway.getQuote('u1', SYMBOL);
      expect(calls.some((c) => c.url.startsWith('https://data.alpaca.markets'))).toBe(true);
      await gateway.getPositions('u1');
      expect(calls.some((c) => c.url.startsWith('https://api.alpaca.markets'))).toBe(true);
      expect((credentials.getDecrypted as jest.Mock).mock.calls.some((c) => c[2] === 'live')).toBe(
        true,
      );
    });

    it('practice mode uses the paper hosts and the practice credential set', async () => {
      tradingMode = 'practice';
      await gateway.getQuote('u1', SYMBOL);
      expect(calls.some((c) => c.url.startsWith('https://paper-data.alpaca.markets'))).toBe(true);
      await gateway.getPositions('u1');
      expect(calls.some((c) => c.url.startsWith('https://paper-api.alpaca.markets'))).toBe(true);
      expect(
        (credentials.getDecrypted as jest.Mock).mock.calls.some((c) => c[2] === 'practice'),
      ).toBe(true);
    });

    it('practice mode fails with an auth error when no practice credentials exist', async () => {
      tradingMode = 'practice';
      (credentials.getDecrypted as jest.Mock).mockResolvedValue(null);
      await expect(gateway.getQuote('u1', SYMBOL)).rejects.toMatchObject({
        code: 'BROKER_AUTH_FAILED',
      });
    });
  });

  it('GETs a stock snapshot from the data host', async () => {
    const q: Quote = await gateway.getQuote('u1', SYMBOL);
    expect(calls.some((c) => c.url.includes('/v2/stocks/snapshots'))).toBe(true);
    expect(q).toMatchObject({ symbol: SYMBOL, bid: UNDER - 1, ask: UNDER + 1, last: UNDER });
  });

  it('GETs an option snapshot (OCC) from the data host', async () => {
    const q: Quote = await gateway.getQuote('u1', EXPECTED_OCC);
    expect(calls.some((c) => c.url.includes('/v2/options/snapshots'))).toBe(true);
    expect(q).toMatchObject({ symbol: EXPECTED_OCC, bid: 5, ask: 5.5 });
  });

  it('fetches bars sorted ascending by time', async () => {
    const bars: Candle[] = await gateway.getCandles('u1', SYMBOL, {
      interval: '1m',
    });
    expect(bars).toHaveLength(2);
    expect(bars[0].time <= bars[1].time).toBe(true);
  });

  it('uses the real options-chain endpoint (no strike-grid probe)', async () => {
    const chain = await gateway.getOptionsChain('u1', SYMBOL);
    expect(calls.some((c) => c.url.includes('/v2/options/chains'))).toBe(true);
    expect(chain.underlyingPrice).toBe(UNDER);
    expect(chain.contracts.map((c) => c.symbol)).toContain(EXPECTED_OCC);
  });

  it('previews with a local buying-power estimate and 0DTE warning', async () => {
    const preview = await gateway.previewOrder('u1', {
      underlying: SYMBOL,
      assetClass: 'option',
      side: 'buy',
      quantity: 1,
      orderType: 'mid',
      selection: { mode: 'auto_otm', optionType: 'call' },
    });
    expect(preview.resolved.contractSymbol).toBe(EXPECTED_OCC);
    expect(preview.resolved.estBuyingPower).toBeGreaterThan(0);
    expect(preview.warnings.some((w) => w.includes('0DTE'))).toBe(true);
  });

  it('places an order with an OCC symbol and a deterministic client_order_id', async () => {
    const order: OrderRequest = {
      underlying: SYMBOL,
      assetClass: 'option',
      side: 'buy',
      quantity: 1,
      orderType: 'mid',
      selection: { mode: 'explicit', optionType: 'call', expiration: EXP, strike: CALL_STRIKE },
    };
    const result = await gateway.placeOrder('u1', order, 'idem-key');
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/v2/orders'));
    expect(post).toBeDefined();
    expect(post!.body!.symbol).toBe(EXPECTED_OCC);
    expect(post!.body!.client_order_id).toMatch(/^[a-f0-9]{32}$/);
    expect(result.contractSymbol).toBe(EXPECTED_OCC);
    expect(result.orderId).toBe(post!.body!.client_order_id);
    expect(events.emit).toHaveBeenCalled();
  });

  it('cancels an order by its client_order_id', async () => {
    await gateway.cancelOrder('u1', 'cid-1');
    const del = calls.find(
      (c) => c.method === 'DELETE' && /\/v2\/orders\/client:cid-1/.test(c.url),
    );
    expect(del).toBeDefined();
    expect(events.emit).toHaveBeenCalled();
  });

  it('maps positions (option multiplier 100)', async () => {
    const positions = await gateway.getPositions('u1');
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ symbol: EXPECTED_OCC, multiplier: 100 });
  });

  it('reauthenticate is a no-op returning the trading mode', async () => {
    expect(await gateway.reauthenticate('u1')).toBe('live');
  });
});
