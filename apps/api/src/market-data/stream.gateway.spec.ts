import { WebSocket } from 'ws';
import { Quote } from '@0dtetrader/shared-types';
import { BrokerGateway } from '../broker/broker-gateway.interface';
import { OrderEventsService } from '../broker/order-events.service';
import { CryptoDataService } from './crypto-data.service';
import { StreamGateway } from './stream.gateway';

function fakeSocket(): { readyState: number; send: jest.Mock } {
  return { readyState: WebSocket.OPEN, send: jest.fn() };
}

function quoteFor(symbol: string, last: number): Quote {
  return {
    symbol,
    bid: last - 0.01,
    ask: last + 0.01,
    last,
    bidSize: 1,
    askSize: 1,
    volume: 0,
    timestamp: '2026-07-17T14:30:00.000Z',
  };
}

describe('StreamGateway.tickSymbol', () => {
  let broker: { getQuote: jest.Mock };
  let crypto: { isCryptoSymbol: jest.Mock; getQuote: jest.Mock };
  let gateway: StreamGateway;

  beforeEach(() => {
    broker = {
      // Encode the userId in the price so the assertion can tell whose
      // credentials produced each quote.
      getQuote: jest.fn(async (userId: string, symbol: string) =>
        quoteFor(symbol, userId === 'u1' ? 100 : 200),
      ),
    };
    crypto = {
      isCryptoSymbol: jest.fn(() => false),
      getQuote: jest.fn(async (symbol: string) => quoteFor(symbol, 300)),
    };
    gateway = new StreamGateway(
      broker as unknown as BrokerGateway,
      crypto as unknown as CryptoDataService,
      // jwt/config are only used during connection auth, not by ticks.
      {} as never,
      {} as never,
      { events$: { subscribe: () => ({ unsubscribe: () => undefined }) } } as unknown as OrderEventsService,
    );
  });

  afterEach(() => {
    gateway.onModuleDestroy();
  });

  function subscribe(symbol: string, sockets: Array<[unknown, string]>): void {
    const internals = gateway as unknown as {
      clients: Map<unknown, { userId: string; symbols: Set<string> }>;
      subscribers: Map<string, Set<unknown>>;
    };
    internals.subscribers.set(symbol, new Set(sockets.map(([socket]) => socket)));
    for (const [socket, userId] of sockets) {
      internals.clients.set(socket, { userId, symbols: new Set([symbol]) });
    }
  }

  it('fetches broker quotes per user so credentials are never shared', async () => {
    const socket1 = fakeSocket();
    const socket2 = fakeSocket();
    subscribe('SPY', [
      [socket1, 'u1'],
      [socket2, 'u2'],
    ]);

    await (gateway as unknown as { tickSymbol(symbol: string): Promise<void> }).tickSymbol('SPY');

    expect(broker.getQuote).toHaveBeenCalledTimes(2);
    expect(broker.getQuote).toHaveBeenCalledWith('u1', 'SPY');
    expect(broker.getQuote).toHaveBeenCalledWith('u2', 'SPY');

    expect(socket1.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(socket1.send.mock.calls[0][0]).data.last).toBe(100);
    expect(socket2.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(socket2.send.mock.calls[0][0]).data.last).toBe(200);
  });

  it('one user failing does not starve the others', async () => {
    broker.getQuote.mockImplementation(async (userId: string, symbol: string) => {
      if (userId === 'u1') throw new Error('broker auth failed');
      return quoteFor(symbol, 200);
    });
    const socket1 = fakeSocket();
    const socket2 = fakeSocket();
    subscribe('SPY', [
      [socket1, 'u1'],
      [socket2, 'u2'],
    ]);

    await (gateway as unknown as { tickSymbol(symbol: string): Promise<void> }).tickSymbol('SPY');

    expect(socket1.send).not.toHaveBeenCalled();
    expect(socket2.send).toHaveBeenCalledTimes(1);
  });

  it('crypto symbols use one shared user-independent fetch', async () => {
    crypto.isCryptoSymbol.mockReturnValue(true);
    const socket1 = fakeSocket();
    const socket2 = fakeSocket();
    subscribe('BTC', [
      [socket1, 'u1'],
      [socket2, 'u2'],
    ]);

    await (gateway as unknown as { tickSymbol(symbol: string): Promise<void> }).tickSymbol('BTC');

    expect(crypto.getQuote).toHaveBeenCalledTimes(1);
    expect(broker.getQuote).not.toHaveBeenCalled();
    expect(socket1.send).toHaveBeenCalledTimes(1);
    expect(socket2.send).toHaveBeenCalledTimes(1);
  });
});
