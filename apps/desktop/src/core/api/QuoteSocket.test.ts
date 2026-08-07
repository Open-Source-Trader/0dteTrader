import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderResult } from '@0dtetrader/shared-types';
import { DurableEventCursor } from './DurableEventCursor';
import { QuoteSocket } from './QuoteSocket';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class ThrowingCommitStorage extends MemoryStorage {
  writes = 0;

  override setItem(key: string, value: string): void {
    this.writes += 1;
    if (this.writes > 1) throw new Error('storage unavailable');
    super.setItem(key, value);
  }
}

class ThrowingReadStorage extends MemoryStorage {
  reads = 0;

  override getItem(): string | null {
    this.reads += 1;
    throw new Error('cursor storage blocked');
  }
}

class MockWebSocket {
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];
  readonly readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly send = vi.fn();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }
}

function tokenFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replaceAll('+', '-')
    .replaceAll('/', '_');
  return `header.${payload}.signature`;
}

const update: OrderResult = {
  orderId: 'order-1',
  status: 'filled',
  contractSymbol: 'SPY260805C00600000',
  side: 'buy',
  quantity: 1,
  orderType: 'market',
  timestamp: '2026-08-05T14:30:00.000Z',
};

describe('QuoteSocket durable delivery', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('localStorage', new MemoryStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('checkpoints only after a synchronous consumer observes the event', () => {
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => 'unused');
    const internals = socket as unknown as {
      durableCursor: DurableEventCursor;
      processMessage(raw: string): void;
    };
    internals.durableCursor.activate(tokenFor('user-a'));

    internals.processMessage(
      JSON.stringify({
        type: 'orderUpdate',
        eventId: 'event-1',
        sequence: 1,
        data: update,
      }),
    );
    expect(internals.durableCursor.sequence).toBe(0);

    const listener = vi.fn();
    socket.onOrderUpdate(listener);
    expect(listener).toHaveBeenCalledWith(update);
    expect(internals.durableCursor.sequence).toBe(1);
  });

  it('does not checkpoint when a consumer throws', () => {
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => 'unused');
    const internals = socket as unknown as {
      durableCursor: DurableEventCursor;
      processMessage(raw: string): void;
    };
    internals.durableCursor.activate(tokenFor('user-a'));
    socket.onOrderUpdate(() => {
      throw new Error('consumer failed');
    });

    internals.processMessage(
      JSON.stringify({
        type: 'orderUpdate',
        eventId: 'event-1',
        sequence: 1,
        data: update,
      }),
    );

    expect(internals.durableCursor.sequence).toBe(0);
    expect(socket.getState().lastErrorMessage).toBe('consumer failed');
  });

  it('keeps rolling-deploy messages without cursor metadata deliverable', () => {
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => 'unused');
    const internals = socket as unknown as {
      durableCursor: DurableEventCursor;
      processMessage(raw: string): void;
    };
    internals.durableCursor.activate(tokenFor('user-a'));
    internals.processMessage(JSON.stringify({ type: 'orderUpdate', data: update }));

    const listener = vi.fn();
    socket.onOrderUpdate(listener);

    expect(listener).toHaveBeenCalledWith(update);
    expect(internals.durableCursor.sequence).toBe(0);
  });

  it('reconnects without advancing when cursor persistence throws', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const storage = new ThrowingCommitStorage();
    vi.stubGlobal('localStorage', storage);
    const tokenProvider = vi.fn(async () => tokenFor('user-a'));
    const socket = new QuoteSocket('wss://example.test/v1/stream', tokenProvider);
    const internals = socket as unknown as {
      durableCursor: DurableEventCursor;
    };
    try {
      const listener = vi.fn();
      socket.onOrderUpdate(listener);
      socket.connect();
      await Promise.resolve();
      await Promise.resolve();
      expect(MockWebSocket.instances).toHaveLength(1);
      const first = MockWebSocket.instances[0];
      first.onopen?.();

      first.onmessage?.({
        data: JSON.stringify({
          type: 'orderUpdate',
          eventId: 'event-1',
          sequence: 1,
          data: update,
        }),
      });

      expect(internals.durableCursor.sequence).toBe(0);
      expect(listener).toHaveBeenCalledOnce();
      expect(storage.writes).toBe(2);
      expect(socket.getState().lastErrorMessage).toBe('storage unavailable');
      expect(socket.getState().connectionState).toBe('disconnected');
      expect(first.close).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(tokenProvider).toHaveBeenCalledTimes(2);
      expect(MockWebSocket.instances).toHaveLength(2);
      expect(MockWebSocket.instances[1].url).toContain('cursor=0');
    } finally {
      socket.disconnect();
      vi.useRealTimers();
    }
  });

  it('catches cursor read failures and retries instead of staying connecting', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const storage = new ThrowingReadStorage();
    vi.stubGlobal('localStorage', storage);
    const tokenProvider = vi.fn(async () => tokenFor('user-a'));
    const socket = new QuoteSocket('wss://example.test/v1/stream', tokenProvider);
    try {
      socket.connect();
      await Promise.resolve();
      await Promise.resolve();

      expect(socket.getState()).toMatchObject({
        connectionState: 'disconnected',
        lastErrorMessage: 'cursor storage blocked',
      });
      expect(MockWebSocket.instances).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(tokenProvider).toHaveBeenCalledTimes(2);
      expect(storage.reads).toBe(2);
      expect(socket.getState().connectionState).toBe('disconnected');
    } finally {
      socket.disconnect();
      vi.useRealTimers();
    }
  });

  it('ignores a stale token attempt after a forced reconnect', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const resolvers: Array<(token: string) => void> = [];
    const socket = new QuoteSocket(
      'wss://example.test/v1/stream',
      () => new Promise<string>((resolve) => resolvers.push(resolve)),
    );
    socket.connect();
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    socket.reconnect();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    resolvers[1](tokenFor('user-a'));
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    resolvers[0](tokenFor('user-a'));
    await Promise.resolve();
    await Promise.resolve();

    expect(MockWebSocket.instances).toHaveLength(1);
    socket.disconnect();
  });

  it('reports connected only after the replay cursor handshake', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => tokenFor('user-a'));
    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const webSocket = MockWebSocket.instances[0];
    webSocket.onopen?.();
    expect(socket.getState().connectionState).toBe('connecting');

    webSocket.onmessage?.({ data: JSON.stringify({ type: 'eventCursor', sequence: 0 }) });
    expect(socket.getState().connectionState).toBe('connected');
    socket.disconnect();
  });

  it('defers the replay checkpoint and ready state until a consumer is installed', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => tokenFor('user-a'));
    const internals = socket as unknown as { durableCursor: DurableEventCursor };
    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const webSocket = MockWebSocket.instances[0];
    webSocket.onopen?.();
    webSocket.onmessage?.({
      data: JSON.stringify({
        type: 'orderUpdate',
        eventId: 'event-1',
        sequence: 1,
        data: update,
      }),
    });
    webSocket.onmessage?.({ data: JSON.stringify({ type: 'eventCursor', sequence: 1 }) });

    expect(internals.durableCursor.sequence).toBe(0);
    expect(socket.getState().connectionState).toBe('connecting');

    const listener = vi.fn();
    socket.onOrderUpdate(listener);
    expect(listener).toHaveBeenCalledWith(update);
    expect(internals.durableCursor.sequence).toBe(1);
    expect(socket.getState().connectionState).toBe('connected');
    socket.disconnect();
  });

  it('saves a pre-event baseline so an unseen queued event replays after disconnect', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => tokenFor('user-a'));
    const internals = socket as unknown as { durableCursor: DurableEventCursor };
    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const first = MockWebSocket.instances[0];
    first.onopen?.();
    first.onmessage?.({
      data: JSON.stringify({
        type: 'orderUpdate',
        eventId: 'event-7',
        sequence: 7,
        data: update,
      }),
    });

    // The event itself is not acknowledged, but its safe fresh-connection
    // baseline is durable before any consumer exists.
    expect(internals.durableCursor.sequence).toBe(6);
    first.onclose?.();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(MockWebSocket.instances[1].url).toContain('cursor=6');
    socket.disconnect();
  });

  it('does not use legacy readiness after a durable cursor is deferred', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => tokenFor('user-a'));
    try {
      socket.connect();
      await Promise.resolve();
      await Promise.resolve();
      const webSocket = MockWebSocket.instances[0];
      webSocket.onopen?.();
      webSocket.onmessage?.({
        data: JSON.stringify({
          type: 'orderUpdate',
          eventId: 'event-1',
          sequence: 1,
          data: update,
        }),
      });
      webSocket.onmessage?.({ data: JSON.stringify({ type: 'eventCursor', sequence: 1 }) });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(socket.getState().connectionState).toBe('connecting');

      socket.onOrderUpdate(() => undefined);
      expect(socket.getState().connectionState).toBe('connected');
    } finally {
      socket.disconnect();
      vi.useRealTimers();
    }
  });

  it('disconnects on a sequence gap without advancing the confirmed cursor', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => tokenFor('user-a'));
    const internals = socket as unknown as { durableCursor: DurableEventCursor };
    socket.onOrderUpdate(() => undefined);
    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const webSocket = MockWebSocket.instances[0];
    webSocket.onopen?.();
    webSocket.onmessage?.({ data: JSON.stringify({ type: 'eventCursor', sequence: 1 }) });
    webSocket.onmessage?.({
      data: JSON.stringify({
        type: 'orderUpdate',
        eventId: 'event-3',
        sequence: 3,
        data: update,
      }),
    });

    expect(internals.durableCursor.sequence).toBe(1);
    expect(socket.getState()).toMatchObject({
      connectionState: 'disconnected',
      lastErrorMessage: 'Durable event gap before sequence 3',
    });
    expect(webSocket.close).toHaveBeenCalled();
    socket.disconnect();
  });

  it('falls back for a legacy server without inventing a resumable cursor', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => tokenFor('user-a'));
    const internals = socket as unknown as { durableCursor: DurableEventCursor };
    try {
      socket.connect();
      await Promise.resolve();
      await Promise.resolve();
      expect(MockWebSocket.instances).toHaveLength(1);
      MockWebSocket.instances[0].onopen?.();
      expect(socket.getState().connectionState).toBe('connecting');

      await vi.advanceTimersByTimeAsync(5_000);

      expect(socket.getState().connectionState).toBe('connected');
      expect(internals.durableCursor.resumable).toBe(false);
    } finally {
      socket.disconnect();
      vi.useRealTimers();
    }
  });
});
