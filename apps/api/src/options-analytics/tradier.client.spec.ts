import { Logger } from '@nestjs/common';
import { TradierClient } from './tradier.client';

const NOW = new Date('2026-07-20T14:00:00.000Z');
const QUOTE_TIME = NOW.getTime() - 5_000;
const SUNDAY_NIGHT = new Date('2026-07-20T01:43:16.000Z');
const FRIDAY_CLOSE_QUOTE_TIME = Date.parse('2026-07-17T19:59:55.000Z');

function option(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: 'SPY260820C00100000',
    root_symbol: 'SPY',
    expiration_date: '2026-08-20',
    strike: 100,
    option_type: 'call',
    open_interest: 25,
    volume: 10,
    bid: 2.1,
    ask: 2.2,
    bidsize: 15,
    asksize: 20,
    bid_date: QUOTE_TIME,
    ask_date: QUOTE_TIME + 500,
    contract_size: 100,
    last: 2.15,
    trade_date: QUOTE_TIME - 500,
    greeks: {
      updated_at: new Date(QUOTE_TIME - 1_000).toISOString(),
      delta: 0.5,
      gamma: 0.02,
      mid_iv: 0.2,
    },
    ...overrides,
  };
}

function response(
  body: unknown,
  headers: Record<string, string> = {},
): {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
} {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => body,
  };
}

describe('TradierClient normalization', () => {
  it('uses X-Ratelimit-Available and X-Ratelimit-Expiry and preserves fresh OI', async () => {
    let fetchCount = 0;
    const fetchImpl = jest.fn().mockImplementation(async () => {
      fetchCount += 1;
      return response(
        {
          options: {
            option: option({ open_interest: fetchCount === 1 ? 25 : 40 }),
          },
        },
        {
          'x-ratelimit-available': '119',
          'x-ratelimit-expiry': String(NOW.getTime() + 60_000),
          // This obsolete/wrong header must not drive the budget.
          'x-ratelimit-remaining': '2',
        },
      );
    });
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    const first = await client.getChain('SPY', '2026-08-20');
    const second = await client.getChain('SPY', '2026-08-20');

    expect(first.contracts[0].openInterest).toBe(25);
    expect(second.contracts[0].openInterest).toBe(40);
    expect(client.availableRequests).toBe(119);
    expect(client.rateLimitExpiry).toBe(new Date(NOW.getTime() + 60_000).toISOString());
  });

  it('accepts the versioned maximum relative spread boundary and excludes wider markets', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        options: {
          option: [
            option({ symbol: 'AT-BOUNDARY', bid: 1, ask: 3 }),
            option({ symbol: 'OVER-BOUNDARY', bid: 1, ask: 3.01 }),
          ],
        },
      }),
    );
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    const chain = await client.getChain('SPY', '2026-08-20');

    expect(chain.contracts.map((contract) => contract.symbol)).toEqual(['AT-BOUNDARY']);
    expect(chain.warnings.join(' ')).toMatch(/wide.*OVER-BOUNDARY/i);
  });

  it('validates rate-limit expiry and blocks requests until a future exhausted reset', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const malformedFetch = jest
      .fn()
      .mockResolvedValue(
        response({ expirations: { date: ['2026-08-20'] } }, { 'x-ratelimit-expiry': 'invalid' }),
      );
    const malformed = new TradierClient(
      'token',
      'https://api.tradier.com',
      malformedFetch,
      () => NOW,
    );
    await malformed.getExpirations('SPY');
    expect(malformed.rateLimitExpiry).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/rate.limit.*expiry.*invalid/i));

    const reset = NOW.getTime() + 60_000;
    const exhaustedFetch = jest.fn().mockResolvedValue(
      response(
        { expirations: { date: ['2026-08-20'] } },
        {
          'x-ratelimit-available': '0',
          'x-ratelimit-expiry': String(reset),
        },
      ),
    );
    const exhausted = new TradierClient(
      'token',
      'https://api.tradier.com',
      exhaustedFetch,
      () => NOW,
    );
    await exhausted.getExpirations('SPY');
    await expect(exhausted.getExpirations('SPY')).rejects.toThrow(/rate limit.*until/i);
    expect(exhaustedFetch).toHaveBeenCalledTimes(1);
    expect(exhausted.rateLimitExpiry).toBe(new Date(reset).toISOString());
  });

  it('excludes incomplete, crossed, stale, wrong-root, and wrong-expiration contracts', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        options: {
          option: [
            option(),
            option({ symbol: 'NO-MULTIPLIER', contract_size: undefined }),
            option({ symbol: 'CROSSED', bid: 2.5, ask: 2.4 }),
            option({
              symbol: 'STALE',
              bid_date: NOW.getTime() - 31 * 60_000,
              ask_date: NOW.getTime() - 31 * 60_000,
            }),
            option({ symbol: 'WRONG-ROOT', root_symbol: 'QQQ' }),
            option({ symbol: 'WRONG-EXP', expiration_date: '2026-08-21' }),
            option({ symbol: 'TOO-WIDE', bid: 1, ask: 4 }),
          ],
        },
      }),
    );
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    const chain = await client.getChain('SPY', '2026-08-20');

    expect(chain.contracts).toHaveLength(1);
    expect(chain.contractsTotal).toBe(7);
    expect(chain.contractsTotalByRoot).toEqual({ SPY: 6, QQQ: 1 });
    expect(chain.warnings.join(' ')).toMatch(/multiplier|crossed|stale|root|expiration|wide/i);
    expect(chain.warnings.join(' ')).toMatch(/open interest.*inferred/i);
  });

  it('accepts both standard AM-settled SPX roots and PM-settled SPXW roots', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        options: {
          option: [
            option({ symbol: 'SPX-AM', root_symbol: 'SPX' }),
            option({ symbol: 'SPXW-PM', root_symbol: 'SPXW' }),
          ],
        },
      }),
    );
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    const chain = await client.getChain('SPX', '2026-08-20');

    expect(chain.contracts.map((contract) => contract.symbol)).toEqual(['SPX-AM', 'SPXW-PM']);
  });

  it('requires a finite timestamped spot and reports sandbox/delayed feed modes', async () => {
    const sandboxFetch = jest.fn().mockResolvedValue(
      response({
        quotes: {
          quote: {
            symbol: 'SPY',
            last: 100,
            trade_date: QUOTE_TIME,
            delayed: false,
          },
        },
      }),
    );
    const sandbox = new TradierClient(
      'token',
      'https://sandbox.tradier.com',
      sandboxFetch,
      () => NOW,
    );
    await expect(sandbox.getQuote('SPY')).resolves.toMatchObject({
      spot: 100,
      quoteAsOf: new Date(QUOTE_TIME).toISOString(),
      feedMode: 'sandbox',
    });

    const delayedFetch = jest.fn().mockResolvedValue(
      response({
        quotes: {
          quote: {
            symbol: 'SPY',
            last: 100,
            trade_date: QUOTE_TIME,
            delayed: true,
          },
        },
      }),
    );
    const delayed = new TradierClient('token', 'https://api.tradier.com', delayedFetch, () => NOW);
    await expect(delayed.getQuote('SPY')).resolves.toMatchObject({
      feedMode: 'delayed',
    });
  });

  it('accepts the latest completed-session underlying quote on Sunday with an explicit warning', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        quotes: {
          quote: {
            symbol: 'AAPL',
            bid: 210,
            ask: 210.2,
            bid_date: FRIDAY_CLOSE_QUOTE_TIME,
            ask_date: FRIDAY_CLOSE_QUOTE_TIME + 500,
            last: 210.1,
            trade_date: FRIDAY_CLOSE_QUOTE_TIME,
            delayed: false,
          },
        },
      }),
    );
    const client = new TradierClient(
      'token',
      'https://api.tradier.com',
      fetchImpl,
      () => SUNDAY_NIGHT,
    );

    await expect(client.getQuote('AAPL')).resolves.toMatchObject({
      spot: 210.1,
      quoteAsOf: new Date(FRIDAY_CLOSE_QUOTE_TIME).toISOString(),
      warnings: [expect.stringMatching(/market is closed.*2026-07-17/i)],
    });
  });

  it('accepts latest completed-session option quotes but rejects an older session', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        options: {
          option: [
            option({
              symbol: 'AAPL260724C00210000',
              root_symbol: 'AAPL',
              expiration_date: '2026-07-24',
              bid_date: FRIDAY_CLOSE_QUOTE_TIME,
              ask_date: FRIDAY_CLOSE_QUOTE_TIME + 500,
              trade_date: FRIDAY_CLOSE_QUOTE_TIME,
            }),
            option({
              symbol: 'AAPL260724C00215000',
              root_symbol: 'AAPL',
              expiration_date: '2026-07-24',
              bid_date: Date.parse('2026-07-16T19:59:55.000Z'),
              ask_date: Date.parse('2026-07-16T19:59:55.500Z'),
            }),
          ],
        },
      }),
    );
    const client = new TradierClient(
      'token',
      'https://api.tradier.com',
      fetchImpl,
      () => SUNDAY_NIGHT,
    );

    const chain = await client.getChain('AAPL', '2026-07-24');

    expect(chain.contracts.map((contract) => contract.symbol)).toEqual(['AAPL260724C00210000']);
    expect(chain.warnings.join(' ')).toMatch(/market is closed.*2026-07-17/i);
    expect(chain.warnings.join(' ')).toMatch(/stale quote timestamp.*AAPL260724C00215000/i);
  });

  it('accepts provider epoch timestamps encoded as numeric strings', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        quotes: {
          quote: {
            symbol: 'SPY',
            bid: 100,
            ask: 100.2,
            bid_date: String(QUOTE_TIME),
            ask_date: String(QUOTE_TIME + 500),
            delayed: false,
          },
        },
      }),
    );
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    await expect(client.getQuote('SPY')).resolves.toMatchObject({
      spot: 100.1,
      quoteAsOf: new Date(QUOTE_TIME).toISOString(),
    });
  });

  it.each([
    {
      label: 'Monday premarket',
      now: new Date('2026-07-20T13:00:00.000Z'),
      source: FRIDAY_CLOSE_QUOTE_TIME,
      sessionDate: '2026-07-17',
    },
    {
      label: 'Monday postmarket',
      now: new Date('2026-07-20T20:30:00.000Z'),
      source: Date.parse('2026-07-20T19:59:55.000Z'),
      sessionDate: '2026-07-20',
    },
  ])('selects the correct latest completed session during $label', async (scenario) => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        quotes: {
          quote: {
            symbol: 'SPY',
            bid: 100,
            ask: 100.2,
            bid_date: scenario.source,
            ask_date: scenario.source + 500,
            delayed: false,
          },
        },
      }),
    );
    const client = new TradierClient(
      'token',
      'https://api.tradier.com',
      fetchImpl,
      () => scenario.now,
    );

    await expect(client.getQuote('SPY')).resolves.toMatchObject({
      warnings: [expect.stringContaining(scenario.sessionDate)],
    });
  });

  it('rejects a latest-session quote outside the final 30-minute window', async () => {
    const tooEarly = Date.parse('2026-07-17T19:29:59.000Z');
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        quotes: {
          quote: {
            symbol: 'AAPL',
            bid: 210,
            ask: 210.2,
            bid_date: tooEarly,
            ask_date: tooEarly + 500,
            delayed: false,
          },
        },
      }),
    );
    const client = new TradierClient(
      'token',
      'https://api.tradier.com',
      fetchImpl,
      () => SUNDAY_NIGHT,
    );

    await expect(client.getQuote('AAPL')).rejects.toThrow(/no finite, fresh timestamped spot/i);
  });

  it('prefers a fresh valid underlying NBBO midpoint with the conservative timestamp', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        quotes: {
          quote: {
            symbol: 'SPY',
            bid: 100,
            ask: 100.2,
            bid_date: QUOTE_TIME - 2_000,
            ask_date: QUOTE_TIME,
            last: 99,
            trade_date: QUOTE_TIME + 1_000,
            delayed: false,
          },
        },
      }),
    );
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    await expect(client.getQuote('SPY')).resolves.toMatchObject({
      spot: 100.1,
      quoteAsOf: new Date(QUOTE_TIME - 2_000).toISOString(),
      warnings: [],
    });
  });

  it('falls back to a fresh last trade with an explicit warning when NBBO is invalid', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        quotes: {
          quote: {
            symbol: 'SPY',
            bid: 101,
            ask: 100,
            bid_date: QUOTE_TIME,
            ask_date: QUOTE_TIME,
            last: 100.5,
            trade_date: QUOTE_TIME,
            delayed: false,
          },
        },
      }),
    );
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    const quote = await client.getQuote('SPY');
    expect(quote.spot).toBe(100.5);
    expect(quote.warnings.join(' ')).toMatch(/last trade.*NBBO/i);
  });

  it('does not combine underlying bid and ask timestamps more than one minute apart', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        quotes: {
          quote: {
            symbol: 'SPY',
            bid: 99,
            ask: 101,
            bid_date: NOW.getTime() - 29 * 60_000,
            ask_date: QUOTE_TIME,
            last: 100.25,
            trade_date: QUOTE_TIME,
            delayed: false,
          },
        },
      }),
    );
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    await expect(client.getQuote('SPY')).resolves.toMatchObject({
      spot: 100.25,
      warnings: [expect.stringMatching(/last trade.*NBBO/i)],
    });
  });

  it('excludes an option whose bid and ask timestamps are more than one minute apart', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        options: {
          option: option({
            symbol: 'SKEWED-NBBO',
            bid_date: NOW.getTime() - 29 * 60_000,
            ask_date: QUOTE_TIME,
          }),
        },
      }),
    );
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    const chain = await client.getChain('SPY', '2026-08-20');

    expect(chain.contracts).toEqual([]);
    expect(chain.warnings.join(' ')).toMatch(/bid\/ask timestamps.*60000ms/i);
  });

  it('normalizes valid provider comparison data and nulls malformed or stale diagnostics', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        options: {
          option: [
            option({ symbol: 'VALID-COMPARISON' }),
            option({
              symbol: 'INVALID-COMPARISON',
              last: Number.NaN,
              trade_date: NOW.getTime() - 31 * 60_000,
              greeks: {
                updated_at: new Date(NOW.getTime() - 31 * 60_000).toISOString(),
                delta: 5,
                gamma: -1,
                mid_iv: Number.NaN,
              },
            }),
          ],
        },
      }),
    );
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    const chain = await client.getChain('SPY', '2026-08-20');
    expect(chain.contracts[0]).toMatchObject({
      last: 2.15,
      lastTradeAsOf: new Date(QUOTE_TIME - 500).toISOString(),
      providerDelta: 0.5,
      providerGamma: 0.02,
      providerImpliedVolatility: 0.2,
      providerGreeksAsOf: new Date(QUOTE_TIME - 1_000).toISOString(),
    });
    expect(chain.contracts[1]).toMatchObject({
      last: null,
      lastTradeAsOf: null,
      providerDelta: null,
      providerGamma: null,
      providerImpliedVolatility: null,
      providerGreeksAsOf: null,
    });
    expect(chain.warnings.join(' ')).toMatch(/comparison.*last|comparison.*Greek/i);
  });

  it('retains hourly provider Greeks for comparison when they are 45 minutes old', async () => {
    const providerTime = new Date(NOW.getTime() - 45 * 60_000);
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        options: {
          option: option({
            greeks: {
              updated_at: providerTime.toISOString(),
              delta: 0.45,
              gamma: 0.018,
              mid_iv: 0.24,
            },
          }),
        },
      }),
    );
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    const chain = await client.getChain('SPY', '2026-08-20');

    expect(chain.contracts[0]).toMatchObject({
      providerDelta: 0.45,
      providerGamma: 0.018,
      providerImpliedVolatility: 0.24,
      providerGreeksAsOf: providerTime.toISOString(),
    });
  });

  it('bounds repeated comparison warnings for a large valid chain', async () => {
    const many = Array.from({ length: 100 }, (_, index) =>
      option({
        symbol: `STALE-DIAGNOSTIC-${index}`,
        last: 2,
        trade_date: NOW.getTime() - 31 * 60_000,
        greeks: {
          updated_at: new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString(),
          delta: 0.5,
          gamma: 0.02,
          mid_iv: 0.2,
        },
      }),
    );
    const fetchImpl = jest.fn().mockResolvedValue(response({ options: { option: many } }));
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    const chain = await client.getChain('SPY', '2026-08-20');

    expect(chain.contracts).toHaveLength(100);
    expect(chain.warnings).toHaveLength(3);
    expect(chain.warnings.join(' ')).toMatch(/100 contracts/);
    expect(chain.warnings.join(' ')).toContain('STALE-DIAGNOSTIC-0');
    expect(chain.warnings.join(' ')).not.toContain('STALE-DIAGNOSTIC-99');
  });
});

describe('TradierClient chart data (index symbols)', () => {
  it('getChartQuote accepts a delayed index quote with no NBBO', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        quotes: {
          quote: {
            symbol: 'SPX',
            last: 6_300.5,
            volume: 0,
            trade_date: NOW.getTime() - 20 * 60_000, // stale for analytics, fine for charts
            delayed: true,
          },
        },
      }),
    );
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    const quote = await client.getChartQuote('SPX');

    expect(quote.symbol).toBe('SPX');
    expect(quote.last).toBe(6_300.5);
    expect(quote.bid).toBe(0);
    expect(quote.ask).toBe(0);
    expect(quote.timestamp).toBe(new Date(NOW.getTime() - 20 * 60_000).toISOString());
  });

  it('getChartQuote throws only when no finite price exists at all', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(response({ quotes: { quote: { symbol: 'SPX', last: null } } }));
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    await expect(client.getChartQuote('SPX')).rejects.toThrow(/no finite price/);
  });

  it('strict getQuote still rejects the stale quote getChartQuote accepts', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        quotes: {
          quote: {
            symbol: 'SPX',
            last: 6_300.5,
            trade_date: NOW.getTime() - 40 * 60_000,
          },
        },
      }),
    );
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    await expect(client.getQuote('SPX')).rejects.toThrow();
  });

  it('getDailyHistory maps day rows to UTC-midnight candles and skips bad rows', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        history: {
          day: [
            { date: '2026-07-16', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
            { date: '2026-07-17', open: 1.5, high: 3, low: 1, close: 2.5 }, // volume absent → 0
            { open: 9, high: 9, low: 9, close: 9 }, // no date → skipped
          ],
        },
      }),
    );
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    const candles = await client.getDailyHistory('SPX', '2026-07-01', '2026-07-18');

    expect(candles).toEqual([
      { time: '2026-07-16T00:00:00.000Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
      { time: '2026-07-17T00:00:00.000Z', open: 1.5, high: 3, low: 1, close: 2.5, volume: 0 },
    ]);
  });

  it('getTimeSales uses the epoch timestamp field and Eastern-formatted range params', async () => {
    const epoch = Math.floor(FRIDAY_CLOSE_QUOTE_TIME / 1000);
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        series: {
          data: [
            { timestamp: epoch, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
            { time: '2026-07-17T15:45:00', open: 9, high: 9, low: 9, close: 9 }, // no epoch → skipped
          ],
        },
      }),
    );
    const client = new TradierClient('token', 'https://api.tradier.com', fetchImpl, () => NOW);

    const candles = await client.getTimeSales(
      'SPX',
      '15min',
      new Date('2026-07-17T13:30:00.000Z'),
      new Date('2026-07-17T20:00:00.000Z'),
    );

    expect(candles).toEqual([
      {
        time: new Date(epoch * 1000).toISOString(),
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 10,
      },
    ]);
    const url = fetchImpl.mock.calls[0][0] as string;
    // 13:30Z on 2026-07-17 is 09:30 Eastern (EDT).
    expect(url).toContain('interval=15min');
    expect(url).toContain(encodeURIComponent('2026-07-17 09:30'));
  });
});
