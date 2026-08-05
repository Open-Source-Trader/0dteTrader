import { BrokerGateway } from './broker-gateway.interface';
import { DispatchingBrokerGateway } from './dispatching-broker.gateway';

/** Builds a minimal jest mock gateway. */
function makeGateway(): jest.Mocked<BrokerGateway> {
  return {
    getQuote: jest.fn(),
    getCandles: jest.fn(),
    getOptionsChain: jest.fn(),
    previewOrder: jest.fn(),
    placeOrder: jest.fn(),
    cancelOrder: jest.fn(),
    getPositions: jest.fn(),
    getOpenOrders: jest.fn(),
    reauthenticate: jest.fn(),
  } as unknown as jest.Mocked<BrokerGateway>;
}

describe('DispatchingBrokerGateway', () => {
  let prisma: { user: { findUnique: jest.Mock } };
  let webull: jest.Mocked<BrokerGateway>;
  let alpaca: jest.Mocked<BrokerGateway>;
  let snaptrade: jest.Mocked<BrokerGateway>;
  let gw: DispatchingBrokerGateway;
  let provider: 'webull' | 'alpaca' | 'snaptrade';

  beforeEach(() => {
    provider = 'webull';
    prisma = {
      user: {
        findUnique: jest.fn(async () => ({ id: 'u1', tradingProvider: provider })),
      },
    };
    webull = makeGateway();
    alpaca = makeGateway();
    snaptrade = makeGateway();
    gw = new DispatchingBrokerGateway(
      prisma as any,
      webull as any,
      alpaca as any,
      snaptrade as any,
    );
  });

  it('routes market-data and trading calls to Webull when tradingProvider is webull', async () => {
    await gw.getQuote('u1', 'SPY');
    await gw.getCandles('u1', 'SPY', { interval: '1m' });
    await gw.getOptionsChain('u1', 'SPY');
    await gw.previewOrder('u1', {} as never);
    expect(webull.getQuote).toHaveBeenCalledWith('u1', 'SPY');
    expect(webull.getCandles).toHaveBeenCalledWith('u1', 'SPY', { interval: '1m' });
    expect(webull.getOptionsChain).toHaveBeenCalledWith('u1', 'SPY', undefined);
    expect(webull.previewOrder).toHaveBeenCalledWith('u1', {} as never);
    expect(alpaca.getQuote).not.toHaveBeenCalled();
  });

  it('routes market-data and trading calls to Alpaca when tradingProvider is alpaca', async () => {
    provider = 'alpaca';
    await gw.getQuote('u1', 'SPY');
    await gw.getCandles('u1', 'SPY', { interval: '1m' });
    await gw.getOptionsChain('u1', 'SPY');
    await gw.previewOrder('u1', {} as never);
    expect(alpaca.getQuote).toHaveBeenCalledWith('u1', 'SPY');
    expect(alpaca.getCandles).toHaveBeenCalledWith('u1', 'SPY', { interval: '1m' });
    expect(alpaca.getOptionsChain).toHaveBeenCalledWith('u1', 'SPY', undefined);
    expect(alpaca.previewOrder).toHaveBeenCalledWith('u1', {} as never);
    expect(webull.getQuote).not.toHaveBeenCalled();
  });

  it('routes market-data and trading calls to SnapTrade when tradingProvider is snaptrade', async () => {
    provider = 'snaptrade';
    await gw.getQuote('u1', 'SPY');
    await gw.getCandles('u1', 'SPY', { interval: '1m' });
    await gw.getOptionsChain('u1', 'SPY');
    await gw.placeOrder('u1', {} as never, 'key');
    expect(snaptrade.getQuote).toHaveBeenCalledWith('u1', 'SPY');
    expect(snaptrade.getCandles).toHaveBeenCalledWith('u1', 'SPY', { interval: '1m' });
    expect(snaptrade.getOptionsChain).toHaveBeenCalledWith('u1', 'SPY', undefined);
    expect(snaptrade.placeOrder).toHaveBeenCalledWith(
      'u1',
      {} as never,
      'key',
      undefined,
      undefined,
      undefined,
    );
    expect(webull.getQuote).not.toHaveBeenCalled();
    expect(alpaca.getQuote).not.toHaveBeenCalled();
  });

  it('delegates placeOrder + idempotency to the right gateway', async () => {
    provider = 'alpaca';
    const order = {
      underlying: 'SPY',
      assetClass: 'option',
      side: 'buy',
      quantity: 1,
      orderType: 'mid',
      selection: { mode: 'auto_otm', optionType: 'call' },
    } as never;
    await gw.placeOrder('u1', order, 'key');
    expect(alpaca.placeOrder).toHaveBeenCalledWith(
      'u1',
      order,
      'key',
      undefined,
      undefined,
      undefined,
    );
    expect(webull.placeOrder).not.toHaveBeenCalled();
  });

  it('forwards the already-resolved contract to avoid resolving it again at the provider', async () => {
    const order = {} as never;
    const contract = {
      symbol: 'SPY260805C00500000',
      underlying: 'SPY',
      expiration: '2026-08-05',
      strike: 500,
      optionType: 'call' as const,
      bid: 1.2,
      ask: 1.3,
      last: 1.25,
    };

    await gw.placeOrder('u1', order, 'key', 'live', 2, contract);

    expect(webull.placeOrder).toHaveBeenCalledWith('u1', order, 'key', 'live', 2, contract);
  });

  it('delegates reauthenticate (Webull = token reset, Alpaca = no-op)', async () => {
    await gw.reauthenticate('u1');
    expect(webull.reauthenticate).toHaveBeenCalledWith('u1');
    // A distinct user so the provider cache (keyed per user) doesn't serve
    // u1's already-cached 'webull' back for this alpaca assertion.
    provider = 'alpaca';
    await gw.reauthenticate('u2');
    expect(alpaca.reauthenticate).toHaveBeenCalledWith('u2');
  });

  it('routes every method by provider for alpaca', async () => {
    provider = 'alpaca';
    await gw.getCandles('u1', 'SPY', { interval: '1m' });
    await gw.getOptionsChain('u1', 'SPY');
    await gw.previewOrder('u1', {} as never);
    await gw.getPositions('u1');
    await gw.getOpenOrders('u1');
    await gw.cancelOrder('u1', 'oid');
    expect(alpaca.getCandles).toHaveBeenCalledWith('u1', 'SPY', { interval: '1m' });
    expect(alpaca.getOptionsChain).toHaveBeenCalledWith('u1', 'SPY', undefined);
    expect(alpaca.previewOrder).toHaveBeenCalled();
    expect(alpaca.getPositions).toHaveBeenCalled();
    expect(alpaca.getOpenOrders).toHaveBeenCalled();
    expect(alpaca.cancelOrder).toHaveBeenCalledWith('u1', 'oid');
    expect(webull.getCandles).not.toHaveBeenCalled();
  });

  it('getAccountSummary forwards to the routed gateway, defaulting to null when unsupported', async () => {
    provider = 'alpaca';
    alpaca.getAccountSummary = jest.fn(async () => ({
      equity: 1000,
      lastEquity: 1075.97,
      dailyPnl: -75.97,
    }));
    await expect(gw.getAccountSummary('u1')).resolves.toEqual({
      equity: 1000,
      lastEquity: 1075.97,
      dailyPnl: -75.97,
    });

    // Webull's mock (from makeGateway) has no getAccountSummary at all —
    // the dispatching gateway must not throw, just report unsupported.
    provider = 'webull';
    await expect(gw.getAccountSummary('u2')).resolves.toBeNull();
  });

  describe('fresh provider routing', () => {
    it('re-reads the provider for every call', async () => {
      await gw.getQuote('u1', 'SPY');
      await gw.getPositions('u1');
      await gw.getOpenOrders('u1');

      expect(prisma.user.findUnique).toHaveBeenCalledTimes(3);
      expect(webull.getQuote).toHaveBeenCalled();
      expect(webull.getPositions).toHaveBeenCalled();
      expect(webull.getOpenOrders).toHaveBeenCalled();
    });

    it('keeps users isolated when their selected providers differ', async () => {
      await gw.getQuote('u1', 'SPY');
      provider = 'alpaca';
      await gw.getQuote('u2', 'SPY');

      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
      expect(webull.getQuote).toHaveBeenCalledWith('u1', 'SPY');
      expect(alpaca.getQuote).toHaveBeenCalledWith('u2', 'SPY');
    });

    it('picks up a provider switch on the very next call', async () => {
      await gw.getQuote('u1', 'SPY');
      expect(webull.getQuote).toHaveBeenCalledTimes(1);

      provider = 'alpaca';
      await gw.getQuote('u1', 'SPY');

      expect(alpaca.getQuote).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
    });

    it('pins interrupted-order history to the expected provider and account', async () => {
      provider = 'snaptrade';
      snaptrade.executionScope = jest.fn(async () => ({
        provider: 'snaptrade' as const,
        environment: 'live' as const,
        accountId: 'account-b',
      }));
      snaptrade.getRecentOrders = jest.fn(async () => []);
      const expected = {
        provider: 'snaptrade' as const,
        environment: 'live' as const,
        accountId: 'account-a',
      };

      await expect(gw.getRecentOrders('u1', new Date(0), expected)).rejects.toThrow(
        'selected account changed',
      );
      expect(snaptrade.getRecentOrders).not.toHaveBeenCalled();

      (snaptrade.executionScope as jest.Mock).mockResolvedValue({
        ...expected,
        accountId: 'account-a',
      });
      await gw.getRecentOrders('u1', new Date(0), expected);
      expect(snaptrade.getRecentOrders).toHaveBeenCalledWith('u1', new Date(0), expected);
    });

    it('routes exact keyed recovery only after the provider account scope matches', async () => {
      const expected = {
        provider: 'webull' as const,
        environment: 'live' as const,
        accountId: 'account-a',
      };
      webull.executionScope = jest.fn(async () => expected);
      webull.recoverOrder = jest.fn(async () => null);

      await expect(gw.recoverOrder('u1', 'chartorder:1', expected)).resolves.toBeNull();
      expect(webull.recoverOrder).toHaveBeenCalledWith('u1', 'chartorder:1', expected);

      (webull.executionScope as jest.Mock).mockResolvedValue({
        ...expected,
        accountId: 'account-b',
      });
      await expect(gw.recoverOrder('u1', 'chartorder:2', expected)).rejects.toThrow(
        'selected account changed',
      );
      expect(webull.recoverOrder).toHaveBeenCalledTimes(1);
    });
  });
});
