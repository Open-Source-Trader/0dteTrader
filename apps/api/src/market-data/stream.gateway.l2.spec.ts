import { IncomingMessage } from 'node:http';
import { Subject } from 'rxjs';
import { WebSocket } from 'ws';
import { BrokerGateway } from '../broker/broker-gateway.interface';
import { DurableUserEvent, EventTransportService } from '../events/event-transport.service';
import { CryptoDataService } from './crypto-data.service';
import { IndexDataService } from './index-data.service';
import { OrderBookService } from './order-book.service';
import { StreamGateway } from './stream.gateway';

function socketHarness() {
  const handlers = new Map<string, (value?: unknown) => void>();
  const socket = {
    readyState: WebSocket.OPEN,
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn((event: string, handler: (value?: unknown) => void) =>
      handlers.set(event, handler),
    ),
  };
  return { socket, emit: (event: string, value?: unknown) => handlers.get(event)?.(value) };
}

describe('StreamGateway Level 2 protocol', () => {
  function setup() {
    const books = {
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      disconnect: jest.fn(),
      destroy: jest.fn(),
    };
    const events = new Subject<DurableUserEvent>();
    const gateway = new StreamGateway(
      { getQuote: jest.fn() } as unknown as BrokerGateway,
      { isCryptoSymbol: jest.fn(() => false) } as unknown as CryptoDataService,
      { isIndexSymbol: jest.fn(() => false) } as unknown as IndexDataService,
      { verify: jest.fn(() => ({ sub: 'user-1' })) } as never,
      { getOrThrow: jest.fn(() => 'secret') } as never,
      {
        events$: events.asObservable(),
        latestSequence: jest.fn(async () => 0),
        pollOnce: jest.fn(async () => undefined),
      } as unknown as EventTransportService,
      books as unknown as OrderBookService,
    );
    const harness = socketHarness();
    gateway.handleConnection(
      harness.socket as unknown as WebSocket,
      { url: '/v1/stream?token=valid' } as IncomingMessage,
    );
    return { gateway, books, ...harness };
  }

  it('subscribes, fans canonical messages, unsubscribes, and disconnects independently', async () => {
    const { gateway, books, socket, emit } = setup();
    await Promise.resolve();
    emit('message', JSON.stringify({ type: 'l2Subscribe', symbol: 'spy', levels: 10 }));
    expect(books.subscribe).toHaveBeenCalledWith(socket, 'SPY', 10, expect.any(Function));
    const listener = books.subscribe.mock.calls[0][3];
    listener({
      type: 'l2Status',
      data: {
        availability: 'unavailable',
        symbol: 'SPY',
        provider: 'webull',
        capability: 'nasdaq_totalview_non_display',
        freshness: null,
        reason: 'entitlement_missing',
        message: 'missing',
        retryable: false,
      },
    });
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"l2Status"'));

    emit('message', JSON.stringify({ type: 'l2Unsubscribe', symbol: 'SPY' }));
    expect(books.unsubscribe).toHaveBeenCalledWith(socket, 'SPY');
    gateway.handleDisconnect(socket as unknown as WebSocket);
    expect(books.disconnect).toHaveBeenCalledWith(socket);
    gateway.onModuleDestroy();
    expect(books.destroy).toHaveBeenCalled();
  });

  it.each([
    { type: 'l2Subscribe', symbol: 'SPY', levels: 0 },
    { type: 'l2Subscribe', symbol: 'SPY', levels: 51 },
    { type: 'l2Subscribe', symbol: '$BAD', levels: 5 },
    { type: 'l2Subscribe', symbol: ['SPY'], levels: 5 },
    { type: 'l2Unsubscribe', symbol: '$BAD' },
  ])('rejects malformed L2 messages without registering work', async (message) => {
    const { books, socket, emit } = setup();
    await Promise.resolve();
    emit('message', JSON.stringify(message));
    expect(books.subscribe).not.toHaveBeenCalled();
    expect(books.unsubscribe).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"code":"BAD_MESSAGE"'));
  });

  it('caps each authenticated socket at 50 unique L2 symbols and frees capacity on unsubscribe', async () => {
    const { books, socket, emit } = setup();
    await Promise.resolve();
    for (let index = 0; index < 51; index += 1) {
      emit('message', JSON.stringify({ type: 'l2Subscribe', symbol: `S${index}`, levels: 5 }));
    }

    expect(books.subscribe).toHaveBeenCalledTimes(50);
    expect(socket.send).toHaveBeenCalledWith(
      expect.stringContaining('"code":"SUBSCRIPTION_LIMIT"'),
    );

    emit('message', JSON.stringify({ type: 'l2Unsubscribe', symbol: 'S0' }));
    emit('message', JSON.stringify({ type: 'l2Subscribe', symbol: 'S50', levels: 5 }));
    expect(books.subscribe).toHaveBeenCalledTimes(51);
  });

  it('frees per-socket capacity when a terminal L2 status tears down the service subscription', async () => {
    const { books, emit } = setup();
    await Promise.resolve();
    for (let index = 0; index < 50; index += 1) {
      emit('message', JSON.stringify({ type: 'l2Subscribe', symbol: `S${index}`, levels: 5 }));
    }
    const firstListener = books.subscribe.mock.calls[0][3];
    firstListener({
      type: 'l2Status',
      data: {
        availability: 'unavailable',
        symbol: 'S0',
        provider: 'webull',
        capability: 'nasdaq_totalview_non_display',
        freshness: null,
        reason: 'unsupported_instrument',
        message: 'unsupported',
        retryable: false,
      },
    });

    emit('message', JSON.stringify({ type: 'l2Subscribe', symbol: 'S50', levels: 5 }));

    expect(books.subscribe).toHaveBeenCalledTimes(51);
  });
});
