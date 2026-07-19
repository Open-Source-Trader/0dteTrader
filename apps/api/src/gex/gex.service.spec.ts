import { GexService } from './gex.service';

const CHAIN = [
  {
    symbol: 'SPY260724C00740000',
    strike: 740,
    optionType: 'call' as const,
    openInterest: 1000,
    bid: 2,
    ask: 2.2,
    last: 2.1,
    midIv: 0.2,
    delta: 0.5,
    gamma: 0.05,
  },
  {
    symbol: 'SPY260724P00740000',
    strike: 740,
    optionType: 'put' as const,
    openInterest: 800,
    bid: 1.8,
    ask: 2,
    last: 1.9,
    midIv: 0.2,
    delta: -0.5,
    gamma: 0.05,
  },
];

function fakeConfig() {
  return {
    get: (key: string) => (key === 'tradier.token' ? 'test-token' : 'https://example.test'),
  };
}

function fakeClient(remaining: number | null) {
  return {
    calls: { expirations: 0, spot: 0, chain: 0 },
    remainingRequests: remaining,
    async getExpirations() {
      this.calls.expirations++;
      return ['2026-07-24', '2026-07-27'];
    },
    async getSpot() {
      this.calls.spot++;
      return 743;
    },
    async getChain() {
      this.calls.chain++;
      return CHAIN;
    },
  };
}

describe('GexService rate-limit backoff', () => {
  it('serves the recent cached result without spending requests when the budget is low', async () => {
    const service = new GexService(fakeConfig() as never);
    const client = fakeClient(null);
    (service as never as { client: unknown }).client = client;

    const first = await service.getLevels('SPY');
    expect(first.stale).toBe(false);
    expect(client.calls.chain).toBe(1);

    client.remainingRequests = 5; // below the floor, cache is seconds old
    const second = await service.getLevels('SPY');
    expect(second).toEqual(first);
    expect(second.stale).toBe(false); // fresh at the backed-off cadence, not stale
    expect(client.calls.chain).toBe(1); // no further Tradier spend
  });

  it('still fetches when the budget is low but the cache is older than the backoff window', async () => {
    const service = new GexService(fakeConfig() as never);
    const client = fakeClient(null);
    (service as never as { client: unknown }).client = client;

    const first = await service.getLevels('SPY');
    // Age the cached entry past the 120 s backoff window.
    const cache = (service as never as { lastGood: Map<string, { asOf: string }> }).lastGood;
    for (const entry of cache.values()) {
      entry.asOf = new Date(Date.now() - 10 * 60_000).toISOString();
    }

    client.remainingRequests = 5;
    const second = await service.getLevels('SPY');
    expect(client.calls.chain).toBe(2); // stale cache -> spend the request
    expect(Date.parse(second.asOf)).toBeGreaterThan(Date.parse(first.asOf) - 1);
  });

  it('fetches normally while the budget is healthy', async () => {
    const service = new GexService(fakeConfig() as never);
    const client = fakeClient(500);
    (service as never as { client: unknown }).client = client;

    await service.getLevels('SPY');
    await service.getLevels('SPY');
    expect(client.calls.chain).toBe(2);
  });
});
