// RequestRegistry — Electron main's authoritative request-lifecycle
// registry. Canonical spec: docs/apple-intelligence/lifecycle-and-concurrency.md
// ("Request ownership") and protocol.md ("Main owns deadlines... Exactly one
// terminal event is permitted"). Mirrors supervisor.test.mjs's plain
// vi.useFakeTimers()/vi.advanceTimersByTimeAsync() style since this module
// is also timer-driven and has no real child process to frame against.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RequestRegistry, DEFAULT_DEADLINE_MS } = require('./requestRegistry.cjs');

function makeRegistry(overrides = {}) {
  const sent = [];
  const dispatched = [];
  const registry = new RequestRegistry({
    send: (request) => sent.push(request),
    dispatch: (webContentsId, payload) => dispatched.push({ webContentsId, payload }),
    ...overrides,
  });
  return { registry, sent, dispatched };
}

describe('RequestRegistry — normal completion', () => {
  it('routes a completed event to the originating webContents and removes the entry', () => {
    const { registry, dispatched } = makeRegistry();
    registry.register({ requestId: 'r1', originatingWebContentsId: 7 });

    const result = registry.handleNativeEvent({
      protocolVersion: 1,
      requestId: 'r1',
      event: 'completed',
      payload: { text: 'ok' },
    });

    expect(result).toEqual({ routed: true, terminal: true });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual({
      webContentsId: 7,
      payload: expect.objectContaining({ requestId: 'r1', event: 'completed' }),
    });
    expect(registry.has('r1')).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('routes non-terminal events without removing the entry', () => {
    const { registry, dispatched } = makeRegistry();
    registry.register({ requestId: 'r1', originatingWebContentsId: 1 });

    const result = registry.handleNativeEvent({
      protocolVersion: 1,
      requestId: 'r1',
      event: 'accepted',
    });

    expect(result).toEqual({ routed: true, terminal: false });
    expect(dispatched).toHaveLength(1);
    expect(registry.has('r1')).toBe(true);
  });
});

describe('RequestRegistry — duplicate active request IDs', () => {
  it('rejects registering a second active request with the same ID', () => {
    const { registry } = makeRegistry();
    registry.register({ requestId: 'r1', originatingWebContentsId: 1 });
    expect(() => registry.register({ requestId: 'r1', originatingWebContentsId: 2 })).toThrow(
      /duplicate active requestId/,
    );
  });

  it('allows re-registering the same ID once the prior entry reached terminal', () => {
    const { registry } = makeRegistry();
    registry.register({ requestId: 'r1', originatingWebContentsId: 1 });
    registry.handleNativeEvent({ protocolVersion: 1, requestId: 'r1', event: 'completed' });

    expect(() => registry.register({ requestId: 'r1', originatingWebContentsId: 2 })).not.toThrow();
  });
});

describe('RequestRegistry — timeout / deadline enforcement', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends cooperative cancellation and emits exactly one failed/request_timeout terminal event on expiry', () => {
    const { registry, sent, dispatched } = makeRegistry();
    registry.register({ requestId: 'r1', originatingWebContentsId: 5 });

    vi.advanceTimersByTime(DEFAULT_DEADLINE_MS);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ requestId: 'r1', method: 'analysis.cancel' });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual({
      webContentsId: 5,
      payload: expect.objectContaining({
        requestId: 'r1',
        event: 'failed',
        error: expect.objectContaining({ code: 'request_timeout' }),
      }),
    });
    expect(registry.has('r1')).toBe(false);
  });

  it('assigns a bounded deadlineAt at registration time', () => {
    const { registry } = makeRegistry();
    const before = Date.now();
    const entry = registry.register({ requestId: 'r1', originatingWebContentsId: 1 });
    const deadlineMs = new Date(entry.deadlineAt).getTime();

    expect(deadlineMs).toBeGreaterThan(before);
    expect(deadlineMs).toBeLessThanOrEqual(before + DEFAULT_DEADLINE_MS + 5);
  });

  it('does not fire the timeout if the request already completed', () => {
    const { registry, sent } = makeRegistry();
    registry.register({ requestId: 'r1', originatingWebContentsId: 1 });
    registry.handleNativeEvent({ protocolVersion: 1, requestId: 'r1', event: 'completed' });

    vi.advanceTimersByTime(DEFAULT_DEADLINE_MS);

    expect(sent).toHaveLength(0); // no cooperative cancel sent post-completion
  });
});

describe('RequestRegistry — native completion after timeout (late completion)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ignores a late completed event after the deadline already fired and does not revive the request', () => {
    const { registry, dispatched } = makeRegistry();
    registry.register({ requestId: 'r1', originatingWebContentsId: 1 });
    vi.advanceTimersByTime(DEFAULT_DEADLINE_MS);
    expect(dispatched).toHaveLength(1); // the synthetic failed/request_timeout

    const result = registry.handleNativeEvent({
      protocolVersion: 1,
      requestId: 'r1',
      event: 'completed',
      payload: { text: 'too late' },
    });

    expect(result).toEqual({ routed: false, reason: 'already-terminal' });
    // Still exactly one dispatch — the late completion never reached anyone.
    expect(dispatched).toHaveLength(1);
    expect(registry.has('r1')).toBe(false);
  });
});

describe('RequestRegistry — duplicate terminal events', () => {
  it('only propagates the first of two terminal events for the same request', () => {
    const { registry, dispatched } = makeRegistry();
    registry.register({ requestId: 'r1', originatingWebContentsId: 1 });

    const first = registry.handleNativeEvent({ protocolVersion: 1, requestId: 'r1', event: 'completed' });
    const second = registry.handleNativeEvent({ protocolVersion: 1, requestId: 'r1', event: 'failed' });

    expect(first).toEqual({ routed: true, terminal: true });
    expect(second).toEqual({ routed: false, reason: 'already-terminal' });
    expect(dispatched).toHaveLength(1);
  });
});

describe('RequestRegistry — unknown request IDs', () => {
  it('handles an event for an unregistered requestId gracefully, without throwing', () => {
    const { registry, dispatched } = makeRegistry();

    const result = registry.handleNativeEvent({
      protocolVersion: 1,
      requestId: 'never-registered',
      event: 'completed',
    });

    expect(result).toEqual({ routed: false, reason: 'unknown-request' });
    expect(dispatched).toHaveLength(0);
  });
});

describe('RequestRegistry — renderer/webContents destruction', () => {
  it('cancels every active request owned by the destroyed webContents and sends cooperative cancellation', () => {
    const { registry, sent } = makeRegistry();
    registry.register({ requestId: 'r1', originatingWebContentsId: 1 });
    registry.register({ requestId: 'r2', originatingWebContentsId: 1 });
    registry.register({ requestId: 'r3', originatingWebContentsId: 2 });

    registry.cancelForWebContents(1);

    expect(sent.map((r) => r.requestId).sort()).toEqual(['r1', 'r2']);
    expect(registry.has('r1')).toBe(false);
    expect(registry.has('r2')).toBe(false);
    expect(registry.has('r3')).toBe(true); // a different window's request is untouched
  });

  it('is a no-op for a webContents with no pending requests', () => {
    const { registry, sent } = makeRegistry();
    registry.register({ requestId: 'r1', originatingWebContentsId: 1 });

    registry.cancelForWebContents(999);

    expect(sent).toHaveLength(0);
    expect(registry.has('r1')).toBe(true);
  });
});

describe('RequestRegistry — sidecar exit', () => {
  it('rejects every pending request with native_process_exited when the sidecar exits', () => {
    const { registry, dispatched } = makeRegistry();
    registry.register({ requestId: 'r1', originatingWebContentsId: 1 });
    registry.register({ requestId: 'r2', originatingWebContentsId: 2 });

    registry.rejectAll();

    expect(dispatched).toHaveLength(2);
    for (const { payload } of dispatched) {
      expect(payload.event).toBe('failed');
      expect(payload.error.code).toBe('native_process_exited');
    }
    expect(registry.size).toBe(0);
  });

  it('does not double-reject a request that already completed before the exit', () => {
    const { registry, dispatched } = makeRegistry();
    registry.register({ requestId: 'r1', originatingWebContentsId: 1 });
    registry.handleNativeEvent({ protocolVersion: 1, requestId: 'r1', event: 'completed' });

    registry.rejectAll();

    expect(dispatched).toHaveLength(1); // only the original completion
  });
});

describe('RequestRegistry — shutdown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('clears all timers on shutdown so no timeout fires afterward', () => {
    const { registry, sent, dispatched } = makeRegistry();
    registry.register({ requestId: 'r1', originatingWebContentsId: 1 });
    registry.register({ requestId: 'r2', originatingWebContentsId: 2 });

    registry.clear();
    expect(registry.size).toBe(0);

    vi.advanceTimersByTime(DEFAULT_DEADLINE_MS * 2);

    expect(sent).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
  });
});

describe('RequestRegistry — exactly-one-terminal-event invariant (stress)', () => {
  it('delivers exactly one terminal event per request across a burst of interleaved races', () => {
    const { registry, dispatched } = makeRegistry();
    const ids = Array.from({ length: 50 }, (_, i) => `r${i}`);
    for (const id of ids) {
      registry.register({ requestId: id, originatingWebContentsId: 1 });
    }

    // Each request receives a completed, then a failed, then another
    // completed — simulating out-of-order/duplicate native lines racing a
    // hypothetical retry. Only the first should ever be routed.
    for (const id of ids) {
      registry.handleNativeEvent({ protocolVersion: 1, requestId: id, event: 'completed' });
      registry.handleNativeEvent({ protocolVersion: 1, requestId: id, event: 'failed' });
      registry.handleNativeEvent({ protocolVersion: 1, requestId: id, event: 'completed' });
    }

    const terminalCountByRequest = new Map();
    for (const { payload } of dispatched) {
      terminalCountByRequest.set(payload.requestId, (terminalCountByRequest.get(payload.requestId) ?? 0) + 1);
    }

    expect(terminalCountByRequest.size).toBe(ids.length);
    for (const count of terminalCountByRequest.values()) {
      expect(count).toBe(1);
    }
    expect(registry.size).toBe(0);
  });
});

describe('RequestRegistry — registry cleanup', () => {
  it('does not leak entries across many completed requests', () => {
    const { registry } = makeRegistry();
    for (let i = 0; i < 100; i++) {
      const id = `r${i}`;
      registry.register({ requestId: id, originatingWebContentsId: 1 });
      registry.handleNativeEvent({ protocolVersion: 1, requestId: id, event: 'completed' });
    }
    expect(registry.size).toBe(0);
  });
});

describe('RequestRegistry — cross-window isolation', () => {
  it('never dispatches a result for window A to window B', () => {
    const { registry, dispatched } = makeRegistry();
    registry.register({ requestId: 'a-1', originatingWebContentsId: 100 });
    registry.register({ requestId: 'b-1', originatingWebContentsId: 200 });

    registry.handleNativeEvent({ protocolVersion: 1, requestId: 'a-1', event: 'completed' });
    registry.handleNativeEvent({ protocolVersion: 1, requestId: 'b-1', event: 'completed' });

    const forA = dispatched.filter((d) => d.payload.requestId === 'a-1');
    const forB = dispatched.filter((d) => d.payload.requestId === 'b-1');
    expect(forA).toEqual([expect.objectContaining({ webContentsId: 100 })]);
    expect(forB).toEqual([expect.objectContaining({ webContentsId: 200 })]);
  });

  it('isOwnedBy correctly scopes cancel authorization per window', () => {
    const { registry } = makeRegistry();
    registry.register({ requestId: 'a-1', originatingWebContentsId: 100 });

    expect(registry.isOwnedBy('a-1', 100)).toBe(true);
    expect(registry.isOwnedBy('a-1', 200)).toBe(false);
    expect(registry.isOwnedBy('unknown', 100)).toBe(false);
  });
});
