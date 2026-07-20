import { Logger } from '@nestjs/common';
import { TradierClient } from './tradier.client';

const NOW = new Date('2026-07-20T14:00:00.000Z');
const QUOTE_TIME = NOW.getTime() - 5_000;

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
