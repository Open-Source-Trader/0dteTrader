import { TradierClient } from './tradier.client';

function fakeFetch(body: unknown) {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  });
}

describe('TradierClient', () => {
  it('parses the chain from the real Tradier response shape ({options: {option: [...]}})', async () => {
    const fetchImpl = fakeFetch({
      options: {
        option: [
          {
            symbol: 'SPY260720P00500000',
            strike: 500,
            option_type: 'put',
            open_interest: 1234,
            bid: 0.1,
            ask: 0.2,
            last: 0.15,
            greeks: { delta: -0.01, gamma: 0.001, mid_iv: 0.3 },
          },
        ],
      },
    });
    const client = new TradierClient('token', 'https://example.test', fetchImpl);
    const chain = await client.getChain('SPY', '2026-07-20');
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({
      symbol: 'SPY260720P00500000',
      strike: 500,
      optionType: 'put',
      openInterest: 1234,
      bid: 0.1,
      ask: 0.2,
      midIv: 0.3,
      delta: -0.01,
      gamma: 0.001,
    });
  });

  it('wraps a single-contract chain (Tradier unwraps one-element arrays)', async () => {
    const fetchImpl = fakeFetch({
      options: {
        option: {
          symbol: 'SPY260720C00700000',
          strike: 700,
          option_type: 'call',
          open_interest: 5,
        },
      },
    });
    const client = new TradierClient('token', 'https://example.test', fetchImpl);
    const chain = await client.getChain('SPY', '2026-07-20');
    expect(chain).toHaveLength(1);
    expect(chain[0].optionType).toBe('call');
    expect(chain[0].openInterest).toBe(5);
  });

  it('returns an empty list when Tradier reports no options (null body)', async () => {
    const fetchImpl = fakeFetch({ options: null });
    const client = new TradierClient('token', 'https://example.test', fetchImpl);
    await expect(client.getChain('SPY', '2026-07-20')).resolves.toEqual([]);
  });
});
