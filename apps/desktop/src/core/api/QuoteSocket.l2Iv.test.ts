import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  IVAlert,
  IVAlertConfigurationState,
  StreamL2SnapshotMessage,
  StreamL2StatusMessage,
} from '@0dtetrader/shared-types';
import { MAX_L2_CLIENT_SYMBOLS, QuoteSocket, decodeQuoteSocketMessage } from './QuoteSocket';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
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

const snapshotMessage: StreamL2SnapshotMessage = {
  type: 'l2Snapshot',
  data: {
    snapshot: {
      symbol: 'SPY',
      provider: 'webull',
      capability: 'nasdaq_totalview_non_display',
      freshness: 'fresh',
      timestamp: '2026-08-05T14:30:00.000Z',
      receivedAt: '2026-08-05T14:30:00.500Z',
      depth: 2,
      bids: [
        { price: 500, size: 12 },
        { price: 499.99, size: 9 },
      ],
      asks: [
        { price: 500.01, size: 8 },
        { price: 500.02, size: 13 },
      ],
    },
    indicators: {
      spreadAbs: 0.01,
      spreadBps: 0.2,
      spreadPercentile: 0.4,
      topBookImbalance: 0.2,
      tickPressure: -0.1,
      depthImbalance: 0.05,
      cumulativePressure: 0.2,
      touchDepletion: null,
    },
  },
};

const unavailableMessage: StreamL2StatusMessage = {
  type: 'l2Status',
  data: {
    availability: 'unavailable',
    symbol: 'SPY',
    provider: 'webull',
    capability: 'nasdaq_totalview_non_display',
    freshness: 'stale',
    reason: 'stale',
    message: 'Last book is older than five seconds',
    retryable: true,
  },
};

const alert: IVAlert = {
  symbol: 'SPX',
  direction: 'expansion',
  currentIv: 0.241,
  baselineIv: 0.213,
  zScore: 3.2,
  timestamp: '2026-08-05T14:31:00.000Z',
};

const configuration: IVAlertConfigurationState = {
  enabled: true,
  symbols: ['SPX', 'NDX'],
  lookbackMinutes: 30,
  thresholdK: 3,
  consecutiveBreaches: 2,
  warmupMinutes: 10,
  warmupSamples: 5,
  cooldownMinutes: 15,
  schemaVersion: 1,
  updatedAt: '2026-08-05T14:00:00.000Z',
};

describe('QuoteSocket exact L2 and IV decoding', () => {
  it('decodes only the canonical shared DTO field names', () => {
    expect(decodeQuoteSocketMessage(JSON.stringify(snapshotMessage))).toEqual(snapshotMessage);
    expect(decodeQuoteSocketMessage(JSON.stringify(unavailableMessage))).toEqual(
      unavailableMessage,
    );
    expect(
      decodeQuoteSocketMessage(
        JSON.stringify({
          type: 'l2Status',
          data: {
            availability: 'available',
            symbol: 'SPY',
            provider: 'webull',
            capability: 'nasdaq_totalview_non_display',
            freshness: 'fresh',
          },
        }),
      ),
    ).not.toBeNull();
    expect(decodeQuoteSocketMessage(JSON.stringify({ type: 'ivAlert', data: alert }))).toEqual({
      type: 'ivAlert',
      data: alert,
    });
    expect(
      decodeQuoteSocketMessage(
        JSON.stringify({ type: 'ivAlertConfiguration', data: configuration }),
      ),
    ).toEqual({ type: 'ivAlertConfiguration', data: configuration });

    const timestampAlias = structuredClone(snapshotMessage) as unknown as Record<string, unknown>;
    const aliasedSnapshot = (timestampAlias.data as { snapshot: Record<string, unknown> }).snapshot;
    aliasedSnapshot.observedAt = aliasedSnapshot.timestamp;
    delete aliasedSnapshot.timestamp;
    expect(decodeQuoteSocketMessage(JSON.stringify(timestampAlias))).toBeNull();

    const sizeAlias = structuredClone(snapshotMessage) as unknown as Record<string, unknown>;
    const firstBid = (sizeAlias.data as { snapshot: { bids: Record<string, unknown>[] } }).snapshot
      .bids[0];
    firstBid.quantity = firstBid.size;
    delete firstBid.size;
    expect(decodeQuoteSocketMessage(JSON.stringify(sizeAlias))).toBeNull();

    expect(
      decodeQuoteSocketMessage(
        JSON.stringify({
          type: 'ivAlert',
          data: { ...alert, currentATMIV: alert.currentIv, currentIv: undefined },
        }),
      ),
    ).toBeNull();
  });

  it('rejects invalid bounds, enums, dates, crossed books, and extra fields', () => {
    const cases: unknown[] = [
      { ...snapshotMessage, extra: true },
      {
        ...snapshotMessage,
        data: {
          ...snapshotMessage.data,
          snapshot: { ...snapshotMessage.data.snapshot, depth: 51 },
        },
      },
      {
        ...snapshotMessage,
        data: {
          ...snapshotMessage.data,
          snapshot: { ...snapshotMessage.data.snapshot, timestamp: 'not-a-date' },
        },
      },
      {
        ...snapshotMessage,
        data: {
          ...snapshotMessage.data,
          snapshot: {
            ...snapshotMessage.data.snapshot,
            receivedAt: '2026-08-05T14:29:58.999Z',
          },
        },
      },
      {
        ...snapshotMessage,
        data: {
          ...snapshotMessage.data,
          snapshot: {
            ...snapshotMessage.data.snapshot,
            bids: [{ price: 501, size: 1 }],
            asks: [{ price: 500, size: 1 }],
          },
        },
      },
      { type: 'ivAlert', data: { ...alert, direction: 'up' } },
      { type: 'ivAlertConfiguration', data: { ...configuration, symbols: ['SPY'] } },
    ];
    for (const candidate of cases) {
      expect(decodeQuoteSocketMessage(JSON.stringify(candidate))).toBeNull();
    }
  });

  it('accepts canonical zero-size levels', () => {
    const zeroSize = structuredClone(snapshotMessage);
    zeroSize.data.snapshot.bids[0].size = 0;

    expect(decodeQuoteSocketMessage(JSON.stringify(zeroSize))).toEqual(zeroSize);
  });

  it('accepts a canonical locked book', () => {
    const locked = structuredClone(snapshotMessage);
    locked.data.snapshot.asks[0].price = locked.data.snapshot.bids[0].price;
    locked.data.indicators.spreadAbs = 0;
    locked.data.indicators.spreadBps = 0;

    expect(decodeQuoteSocketMessage(JSON.stringify(locked))).toEqual(locked);
  });

  it.each([0, 50, 100])('accepts canonical spread percentile %s', (spreadPercentile) => {
    const canonical = structuredClone(snapshotMessage);
    canonical.data.indicators.spreadPercentile = spreadPercentile;

    expect(decodeQuoteSocketMessage(JSON.stringify(canonical))).toEqual(canonical);
  });

  it('accepts the canonical one-second provider future-skew boundary', () => {
    const skewed = structuredClone(snapshotMessage);
    skewed.data.snapshot.receivedAt = '2026-08-05T14:29:59.000Z';

    expect(decodeQuoteSocketMessage(JSON.stringify(skewed))).toEqual(skewed);
  });

  it('rejects a spread percentile above the canonical 100-point range', () => {
    const invalid = structuredClone(snapshotMessage);
    invalid.data.indicators.spreadPercentile = 100.01;

    expect(decodeQuoteSocketMessage(JSON.stringify(invalid))).toBeNull();
  });
});

describe('QuoteSocket bounded fail-closed L2 lifecycle and IV delivery', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.stubGlobal('WebSocket', MockWebSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not subscribe while capability is disabled', async () => {
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => 'token');
    expect(socket.l2CapabilityEnabled).toBe(false);
    expect(socket.subscribeL2('SPY', 50)).toBe(false);
    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    MockWebSocket.instances[0].onopen?.();
    expect(MockWebSocket.instances[0].send).not.toHaveBeenCalledWith(
      expect.stringContaining('l2Subscribe'),
    );
    socket.disconnect();
  });

  it('bounds subscriptions, sends exact messages, restores them, and ignores unrequested data', async () => {
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => 'token', {
      l2CapabilityEnabled: true,
    });
    const updates = vi.fn();
    socket.onL2Update(updates);
    expect(socket.subscribeL2('spy', 5)).toBe(true);
    for (let index = 1; index < MAX_L2_CLIENT_SYMBOLS; index += 1) {
      expect(socket.subscribeL2(`S${index}`, 1)).toBe(true);
    }
    expect(socket.subscribeL2('OVERFLOW', 1)).toBe(false);

    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const webSocket = MockWebSocket.instances[0];
    webSocket.onopen?.();
    expect(webSocket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'l2Subscribe', symbol: 'SPY', levels: 5 }),
    );

    const freshSnapshotMessage = structuredClone(snapshotMessage);
    const receivedAt = new Date().toISOString();
    freshSnapshotMessage.data.snapshot.timestamp = receivedAt;
    freshSnapshotMessage.data.snapshot.receivedAt = receivedAt;
    webSocket.onmessage?.({
      data: JSON.stringify({
        ...freshSnapshotMessage,
        data: {
          ...freshSnapshotMessage.data,
          snapshot: { ...freshSnapshotMessage.data.snapshot, symbol: 'QQQ' },
        },
      }),
    });
    expect(updates).not.toHaveBeenCalled();
    webSocket.onmessage?.({ data: JSON.stringify(freshSnapshotMessage) });
    expect(updates).toHaveBeenCalledWith({
      kind: 'available',
      snapshot: freshSnapshotMessage.data.snapshot,
      indicators: freshSnapshotMessage.data.indicators,
    });

    socket.reconnect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const reconnected = MockWebSocket.instances[1];
    reconnected.onopen?.();
    expect(reconnected.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'l2Subscribe', symbol: 'SPY', levels: 5 }),
    );
    const configurationRequest = {
      enabled: configuration.enabled,
      symbols: configuration.symbols,
      lookbackMinutes: configuration.lookbackMinutes,
      thresholdK: configuration.thresholdK,
      consecutiveBreaches: configuration.consecutiveBreaches,
      warmupMinutes: configuration.warmupMinutes,
      warmupSamples: configuration.warmupSamples,
      cooldownMinutes: configuration.cooldownMinutes,
    };
    expect(socket.configureIvAlerts(configurationRequest)).toBe(true);
    expect(reconnected.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'ivAlertConfigure', data: configurationRequest }),
    );

    expect(socket.unsubscribeL2('SPY')).toBe(true);
    expect(reconnected.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'l2Unsubscribe', symbol: 'SPY' }),
    );
    socket.disconnect();
  });

  it('reports a synchronous IV alert configuration send failure', () => {
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => 'token');
    const webSocket = new MockWebSocket('wss://example.test/v1/stream');
    webSocket.send.mockImplementation(() => {
      throw new Error('socket write failed');
    });
    (socket as unknown as { ws: MockWebSocket }).ws = webSocket;

    const sent = socket.configureIvAlerts({
      enabled: configuration.enabled,
      symbols: configuration.symbols,
      lookbackMinutes: configuration.lookbackMinutes,
      thresholdK: configuration.thresholdK,
      consecutiveBreaches: configuration.consecutiveBreaches,
      warmupMinutes: configuration.warmupMinutes,
      warmupSamples: configuration.warmupSamples,
      cooldownMinutes: configuration.cooldownMinutes,
    });

    expect(sent).toBe(false);
    expect(socket.getState().lastErrorMessage).toBe('socket write failed');
  });

  it('delivers exact unavailable/configuration/alert events and drops malformed aliases', () => {
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => 'token', {
      l2CapabilityEnabled: true,
    });
    socket.subscribeL2('SPY', 5);
    const l2Listener = vi.fn();
    const alertListener = vi.fn();
    const configurationListener = vi.fn();
    socket.onL2Update(l2Listener);
    socket.onIvAlert(alertListener);
    socket.onIvAlertConfiguration(configurationListener);
    const internals = socket as unknown as { processMessage(raw: string): void };

    internals.processMessage(JSON.stringify(unavailableMessage));
    internals.processMessage(JSON.stringify({ type: 'ivAlert', data: alert }));
    internals.processMessage(JSON.stringify({ type: 'ivAlertConfiguration', data: configuration }));
    internals.processMessage(
      JSON.stringify({
        type: 'ivAlert',
        data: { ...alert, baseline: alert.baselineIv, baselineIv: undefined },
      }),
    );

    expect(l2Listener).toHaveBeenCalledWith({
      kind: 'unavailable',
      status: unavailableMessage.data,
    });
    expect(alertListener).toHaveBeenCalledTimes(1);
    expect(alertListener).toHaveBeenCalledWith(alert);
    expect(configurationListener).toHaveBeenCalledWith(configuration);
  });

  it('bounds retained per-symbol state during terminal-status churn', () => {
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => 'token', {
      l2CapabilityEnabled: true,
    });
    const internals = socket as unknown as { processMessage(raw: string): void };
    for (let index = 0; index < 60; index += 1) {
      const symbol = `S${index}`;
      expect(socket.subscribeL2(symbol, 1)).toBe(true);
      internals.processMessage(
        JSON.stringify({
          type: 'l2Status',
          data: {
            availability: 'unavailable',
            symbol,
            provider: 'webull',
            capability: 'nasdaq_totalview_non_display',
            freshness: null,
            reason: 'unsupported_instrument',
            message: 'Unsupported instrument',
            retryable: false,
          },
        }),
      );
    }
    expect(Object.keys(socket.getState().l2BySymbol)).toHaveLength(MAX_L2_CLIENT_SYMBOLS);
    expect(socket.getState().l2BySymbol.S0).toBeUndefined();
    expect(socket.getState().l2BySymbol.S59).toBeDefined();
  });

  it('expires retained numeric L2 state five seconds after its provider timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(snapshotMessage.data.snapshot.timestamp));
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => 'token', {
      l2CapabilityEnabled: true,
    });
    socket.subscribeL2('SPY', 5);
    const updates = vi.fn();
    socket.onL2Update(updates);
    const internals = socket as unknown as { processMessage(raw: string): void };

    internals.processMessage(JSON.stringify(snapshotMessage));
    expect(socket.getState().l2BySymbol.SPY?.kind).toBe('available');

    vi.advanceTimersByTime(4_999);
    expect(socket.getState().l2BySymbol.SPY?.kind).toBe('available');

    vi.advanceTimersByTime(1);
    expect(socket.getState().l2BySymbol.SPY).toMatchObject({
      kind: 'unavailable',
      status: { freshness: 'stale', reason: 'stale' },
    });
    expect(updates).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'unavailable',
        status: expect.objectContaining({ freshness: 'stale', reason: 'stale' }),
      }),
    );
  });

  it('keeps allowed future-skew L2 data until provider timestamp plus five seconds', () => {
    vi.useFakeTimers();
    const receivedAt = Date.parse(snapshotMessage.data.snapshot.timestamp);
    vi.setSystemTime(receivedAt);
    const futureSnapshot = structuredClone(snapshotMessage);
    futureSnapshot.data.snapshot.timestamp = new Date(receivedAt + 1_000).toISOString();
    futureSnapshot.data.snapshot.receivedAt = new Date(receivedAt).toISOString();
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => 'token', {
      l2CapabilityEnabled: true,
    });
    socket.subscribeL2('SPY', 5);
    const internals = socket as unknown as { processMessage(raw: string): void };

    internals.processMessage(JSON.stringify(futureSnapshot));
    expect(socket.getState().l2BySymbol.SPY?.kind).toBe('available');

    vi.advanceTimersByTime(5_999);
    expect(socket.getState().l2BySymbol.SPY?.kind).toBe('available');

    vi.advanceTimersByTime(1);
    expect(socket.getState().l2BySymbol.SPY).toMatchObject({
      kind: 'unavailable',
      status: { freshness: 'stale', reason: 'stale' },
    });
  });

  it('never publishes a snapshot that is already five seconds old', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(snapshotMessage.data.snapshot.timestamp) + 5_000));
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => 'token', {
      l2CapabilityEnabled: true,
    });
    socket.subscribeL2('SPY', 5);
    const internals = socket as unknown as { processMessage(raw: string): void };

    internals.processMessage(JSON.stringify(snapshotMessage));

    expect(socket.getState().l2BySymbol.SPY).toMatchObject({
      kind: 'unavailable',
      status: { freshness: 'stale', reason: 'stale' },
    });
  });

  it('clears user-scoped IV configuration and L2 freshness state on explicit disconnect', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(snapshotMessage.data.snapshot.timestamp));
    const socket = new QuoteSocket('wss://example.test/v1/stream', async () => 'token', {
      l2CapabilityEnabled: true,
    });
    socket.subscribeL2('SPY', 5);
    const internals = socket as unknown as { processMessage(raw: string): void };
    internals.processMessage(JSON.stringify(snapshotMessage));
    internals.processMessage(JSON.stringify({ type: 'ivAlertConfiguration', data: configuration }));
    expect(vi.getTimerCount()).toBe(1);

    socket.disconnect();

    expect(socket.getState().ivAlertConfiguration).toBeNull();
    expect(socket.getState().l2BySymbol).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });
});
