import { BrokerGateway } from './broker-gateway.interface';
import { DispatchingBrokerGateway } from './dispatching-broker.gateway';

/** Builds a 9-method jest mock gateway. */
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
    expect(snaptrade.placeOrder).toHaveBeenCalledWith('u1', {} as never, 'key');
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
    expect(alpaca.placeOrder).toHaveBeenCalledWith('u1', order, 'key');
    expect(webull.placeOrder).not.toHaveBeenCalled();
  });

  it('delegates reauthenticate (Webull = token reset, Alpaca = no-op)', async () => {
    await gw.reauthenticate('u1');
    expect(webull.reauthenticate).toHaveBeenCalledWith('u1');
    provider = 'alpaca';
    await gw.reauthenticate('u1');
    expect(alpaca.reauthenticate).toHaveBeenCalledWith('u1');
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
});
