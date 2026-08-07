// Canonical spec: docs/apple-intelligence/testing-and-observability.md
// ("Required metrics" — analysis_queue_wait_ms, analysis_duration_ms,
// analysis_terminal_state, analysis_trigger_kind). Spies on console.info to
// assert the registry's telemetry emissions carry correct timing and
// terminal-state metadata, using an injected `now()` for deterministic
// duration math (mirrors requestRegistry.test.mjs's existing style).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RequestRegistry } = require('./requestRegistry.cjs');

function makeRegistry({ now } = {}) {
  const sent = [];
  const dispatched = [];
  let clock = now ?? 0;
  const registry = new RequestRegistry({
    send: (request) => sent.push(request),
    dispatch: (webContentsId, payload) => dispatched.push({ webContentsId, payload }),
    now: () => clock,
  });
  return {
    registry,
    sent,
    dispatched,
    advance: (ms) => {
      clock += ms;
    },
  };
}

function capturedTelemetry(infoSpy) {
  return infoSpy.mock.calls
    .map((call) => call[0])
    .filter((line) => typeof line === 'string' && line.startsWith('[apple-intelligence] '))
    .map((line) => JSON.parse(line.slice('[apple-intelligence] '.length)));
}

describe('RequestRegistry telemetry', () => {
  let infoSpy;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits analysis_queue_wait_ms as the gap between register and the accepted event', () => {
    const { registry, advance } = makeRegistry({ now: 1000 });
    registry.register({ requestId: 'r1', originatingWebContentsId: 1, triggerKind: 'manual' });

    advance(150);
    registry.handleNativeEvent({ protocolVersion: 1, requestId: 'r1', event: 'accepted' });

    const queueWaitEvent = capturedTelemetry(infoSpy).find((e) => e.event === 'analysis_queue_wait');
    expect(queueWaitEvent).toMatchObject({
      requestId: 'r1',
      analysisQueueWaitMs: 150,
      analysisTriggerKind: 'manual',
    });
  });

  it('emits analysis_duration_ms and analysis_terminal_state=completed on normal completion', () => {
    const { registry, advance } = makeRegistry({ now: 1000 });
    registry.register({ requestId: 'r1', originatingWebContentsId: 1, triggerKind: 'candle-close' });

    advance(500);
    registry.handleNativeEvent({ protocolVersion: 1, requestId: 'r1', event: 'completed', payload: { text: 'ok' } });

    const terminalEvent = capturedTelemetry(infoSpy).find((e) => e.event === 'analysis_terminal');
    expect(terminalEvent).toMatchObject({
      requestId: 'r1',
      analysisTerminalState: 'completed',
      analysisDurationMs: 500,
      analysisTriggerKind: 'candle-close',
    });
  });

  it('emits analysis_terminal_state=failed with request_timeout on deadline expiry', () => {
    vi.useFakeTimers();
    const registry = new RequestRegistry({ send: () => {}, dispatch: () => {} });
    registry.register({ requestId: 'r1', originatingWebContentsId: 1 });

    vi.advanceTimersByTime(30000);

    const terminalEvent = capturedTelemetry(infoSpy).find((e) => e.event === 'analysis_terminal');
    expect(terminalEvent).toMatchObject({
      requestId: 'r1',
      analysisTerminalState: 'failed',
      errorCode: 'request_timeout',
    });
    expect(terminalEvent.analysisDurationMs).toBeGreaterThanOrEqual(0);
    vi.useRealTimers();
  });

  it('emits analysis_terminal_state=cancelled when the owning webContents is destroyed', () => {
    const { registry, advance } = makeRegistry({ now: 1000 });
    registry.register({ requestId: 'r1', originatingWebContentsId: 7 });
    advance(75);

    registry.cancelForWebContents(7);

    const terminalEvent = capturedTelemetry(infoSpy).find((e) => e.event === 'analysis_terminal');
    expect(terminalEvent).toMatchObject({
      requestId: 'r1',
      analysisTerminalState: 'cancelled',
      analysisDurationMs: 75,
    });
  });

  it('emits analysis_terminal_state=failed for every pending request on rejectAll', () => {
    const { registry, advance } = makeRegistry({ now: 1000 });
    registry.register({ requestId: 'r1', originatingWebContentsId: 1 });
    registry.register({ requestId: 'r2', originatingWebContentsId: 2 });
    advance(10);

    registry.rejectAll('native_process_exited');

    const terminalEvents = capturedTelemetry(infoSpy).filter((e) => e.event === 'analysis_terminal');
    expect(terminalEvents).toHaveLength(2);
    for (const event of terminalEvents) {
      expect(event).toMatchObject({ analysisTerminalState: 'failed', errorCode: 'native_process_exited' });
    }
  });
});
