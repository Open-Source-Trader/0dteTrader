import { describe, expect, it } from 'vitest';
import { decodeQuoteSocketMessage, MAX_QUOTE_SOCKET_MESSAGE_BYTES } from './QuoteSocket';

function maximumDepthPayload(): string {
  const levels = Array.from({ length: 50 }, (_, index) => ({
    price: 500 - index * 0.01,
    size: index + 1,
  }));
  return JSON.stringify({
    type: 'l2Snapshot',
    data: {
      snapshot: {
        symbol: 'SPY',
        provider: 'webull',
        capability: 'nasdaq_totalview_non_display',
        freshness: 'fresh',
        timestamp: '2026-08-05T14:30:00.000Z',
        receivedAt: '2026-08-05T14:30:00.500Z',
        depth: 50,
        bids: levels,
        asks: levels.map((level) => ({ ...level, price: 500.01 + (500 - level.price) })),
      },
      indicators: {
        spreadAbs: 0.01,
        spreadBps: 0.2,
        spreadPercentile: 50,
        topBookImbalance: 0.2,
        tickPressure: -0.1,
        depthImbalance: 0.05,
        cumulativePressure: 0.2,
        touchDepletion: null,
      },
    },
  });
}

describe('QuoteSocket decoder performance contract', () => {
  it('keeps a capped 50-level payload within the byte and decode-time thresholds', () => {
    const raw = maximumDepthPayload();
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(
      MAX_QUOTE_SOCKET_MESSAGE_BYTES,
    );
    const iterations = 2_000;
    const startedAt = performance.now();
    let decoded = null;
    for (let index = 0; index < iterations; index += 1) {
      decoded = decodeQuoteSocketMessage(raw);
    }
    const elapsedMs = performance.now() - startedAt;
    console.info(
      `L2 decoder benchmark: payloadBytes=${new TextEncoder().encode(raw).byteLength} ` +
        `iterations=${iterations} elapsedMs=${elapsedMs.toFixed(2)} thresholdMs=1000 ` +
        `payloadLimitBytes=${MAX_QUOTE_SOCKET_MESSAGE_BYTES}`,
    );
    expect(decoded).not.toBeNull();
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('rejects oversized wire payloads before parsing', () => {
    const oversized = ' '.repeat(MAX_QUOTE_SOCKET_MESSAGE_BYTES + 1);
    expect(decodeQuoteSocketMessage(oversized)).toBeNull();
  });
});
