import { WebSocket } from 'ws';
import { Subject } from 'rxjs';
import { ChartOrder, Quote } from '@0dtetrader/shared-types';
import { BrokerGateway } from '../broker/broker-gateway.interface';
import { DurableUserEvent, EventTransportService } from '../events/event-transport.service';
import { CryptoDataService } from './crypto-data.service';
import { IndexDataService } from './index-data.service';
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
  let index: { isIndexSymbol: jest.Mock; getQuote: jest.Mock };
  let gateway: StreamGateway;
  let durableEvents: Subject<DurableUserEvent>;
  let replay: jest.Mock;

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
    index = {
      isIndexSymbol: jest.fn(() => false),
      getQuote: jest.fn(async (symbol: string) => quoteFor(symbol, 400)),
    };
    durableEvents = new Subject<DurableUserEvent>();
    replay = jest.fn(async () => []);
    gateway = new StreamGateway(
      broker as unknown as BrokerGateway,
      crypto as unknown as CryptoDataService,
      index as unknown as IndexDataService,
      // jwt/config are only used during connection auth, not by ticks.
      {} as never,
      {} as never,
      {
        events$: durableEvents.asObservable(),
        replay,
      } as unknown as EventTransportService,
    );
  });

  afterEach(() => {
    gateway.onModuleDestroy();
  });

  function subscribe(symbol: string, sockets: Array<[unknown, string]>): void {
    const internals = gateway as unknown as {
      clients: Map<
        unknown,
        {
          userId: string;
          symbols: Set<string>;
          lastSequence: number;
          replaying: boolean;
          pending: DurableUserEvent[];
        }
      >;
      subscribers: Map<string, Set<unknown>>;
    };
    internals.subscribers.set(symbol, new Set(sockets.map(([socket]) => socket)));
    for (const [socket, userId] of sockets) {
      internals.clients.set(socket, {
        userId,
        symbols: new Set([symbol]),
        lastSequence: 0,
        replaying: false,
        pending: [],
      });
    }
  }

  it('addresses a watcher chart-order update to its owner only', () => {
    const owner = fakeSocket();
    const other = fakeSocket();
    subscribe('SPY', [
      [owner, 'u1'],
      [other, 'u2'],
    ]);

    durableEvents.next({
      id: '11111111-1111-1111-1111-111111111111',
      userId: 'u1',
      sequence: 1,
      type: 'chartOrder',
      payload: { id: 'co-1', status: 'triggered' } as ChartOrder,
    });

    expect(other.send).not.toHaveBeenCalled();
    expect(owner.send).toHaveBeenCalledTimes(1);
    const message = JSON.parse(owner.send.mock.calls[0][0]);
    expect(message.type).toBe('chartOrder');
    expect(message.data.id).toBe('co-1');
  });

  it('paginates reconnect replay until the cursor is fully caught up', async () => {
    const socket = fakeSocket();
    const page = Array.from({ length: 1_000 }, (_, index): DurableUserEvent => ({
      id: `event-${index + 1}`,
      userId: 'u1',
      sequence: index + 1,
      type: 'orderUpdate',
      payload: { orderId: `order-${index + 1}` },
    }));
    replay.mockResolvedValueOnce(page).mockResolvedValueOnce([
      {
        id: 'event-1001',
        userId: 'u1',
        sequence: 1_001,
        type: 'orderUpdate',
        payload: { orderId: 'order-1001' },
      },
    ]);
    const internals = gateway as unknown as {
      clients: Map<
        unknown,
        {
          userId: string;
          symbols: Set<string>;
          lastSequence: number;
          replaying: boolean;
          pending: DurableUserEvent[];
        }
      >;
      replayClient(client: unknown, userId: string, cursor: number): Promise<void>;
    };
    internals.clients.set(socket, {
      userId: 'u1',
      symbols: new Set(),
      lastSequence: 0,
      replaying: true,
      pending: [],
    });

    await internals.replayClient(socket, 'u1', 0);

    expect(replay).toHaveBeenNthCalledWith(1, 'u1', 0, 1_000);
    expect(replay).toHaveBeenNthCalledWith(2, 'u1', 1_000, 1_000);
    expect(socket.send).toHaveBeenCalledTimes(1_001);
  });

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

  it('index symbols are fetched per user so a stored Tradier key streams its own feed', async () => {
    index.isIndexSymbol.mockReturnValue(true);
    const socket1 = fakeSocket();
    const socket2 = fakeSocket();
    subscribe('SPX', [
      [socket1, 'u1'],
      [socket2, 'u2'],
    ]);

    await (gateway as unknown as { tickSymbol(symbol: string): Promise<void> }).tickSymbol('SPX');

    // One fetch per user (IndexDataService's scope-keyed cache collapses
    // same-credential users to a single Tradier call downstream).
    expect(index.getQuote).toHaveBeenCalledTimes(2);
    expect(index.getQuote).toHaveBeenCalledWith('SPX', 'u1');
    expect(index.getQuote).toHaveBeenCalledWith('SPX', 'u2');
    expect(broker.getQuote).not.toHaveBeenCalled();
    expect(socket1.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(socket1.send.mock.calls[0][0]).data.last).toBe(400);
    expect(socket2.send).toHaveBeenCalledTimes(1);
  });
});
