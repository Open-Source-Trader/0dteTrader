import { describe, expect, it, vi } from 'vitest';
import { AnalysisStore } from './AnalysisStore';
import type {
  AppleIntelligenceBridge,
  NativeEventPayload,
} from '../../core/desktop/appleIntelligence';
import type { AnalysisSnapshot } from './types';

function makeSnapshot(overrides: Partial<AnalysisSnapshot['identity']> = {}): AnalysisSnapshot {
  return {
    snapshotSchemaVersion: 1,
    identity: {
      snapshotId: 's1',
      capturedAt: '2026-07-31T00:00:00.000Z',
      symbol: 'SPY',
      timeframe: '5m',
      snapshotSequence: 1,
      positionVersion: 0,
      ...overrides,
    },
    trigger: { kind: 'manual', priority: 'manual', reason: 'user requested' },
    market: {},
    candles: {},
    indicators: {},
    levels: [
      {
        id: 'lvl-1',
        kind: 'pivot',
        role: 'support',
        price: 578.5,
        evidence: 'tested',
        testCount: 2,
        recency: 'today',
        strength: 0.7,
        source: 'pivot-low',
      },
    ],
    quality: {
      capturedAt: '2026-07-31T00:00:00.000Z',
      candlesFreshAsOf: '2026-07-31T00:00:00.000Z',
      isChainStale: false,
    },
    omissions: [],
  };
}

function validResultPayload(overrides: Record<string, unknown> = {}) {
  return {
    resultSchemaVersion: 1,
    analysisId: 'a1',
    context: { symbol: 'SPY', timeframe: '5m', snapshotSequence: 1, positionVersion: 0 },
    generatedAt: '2026-07-31T00:00:00.000Z',
    recommendation: 'wait',
    setupState: 'none',
    bias: 'neutral',
    levels: {},
    confidence: 0.5,
    reasons: [],
    warnings: [],
    assumptions: [],
    observedOmissions: [],
    summary: 'no setup yet',
    ...overrides,
  };
}

/** Fake bridge whose subscribe() lets the test push events directly. */
function makeFakeBridge(): {
  bridge: AppleIntelligenceBridge;
  emit: (event: NativeEventPayload) => void;
  analyzeMock: ReturnType<typeof vi.fn>;
  cancelMock: ReturnType<typeof vi.fn>;
} {
  let listener: ((event: NativeEventPayload) => void) | null = null;
  const analyzeMock = vi.fn(async ({ requestId }: { requestId: string }) => ({ requestId }));
  const cancelMock = vi.fn(async () => undefined);
  const bridge: AppleIntelligenceBridge = {
    getAvailability: vi.fn(async () => ({ state: 'ready' })),
    analyze: analyzeMock,
    cancel: cancelMock,
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  return {
    bridge,
    emit: (event) => listener?.(event),
    analyzeMock,
    cancelMock,
  };
}

describe('AnalysisStore', () => {
  it('reports unavailable when no bridge is present', () => {
    const store = new AnalysisStore(null);
    expect(store.getState().availability).toEqual({
      state: 'unavailable',
      reason: 'bridge-not-present',
    });
  });

  it('refreshes availability from the bridge', async () => {
    const { bridge } = makeFakeBridge();
    const store = new AnalysisStore(bridge);
    await store.refreshAvailability();
    expect(store.getState().availability).toEqual({ state: 'ready' });
  });

  it('promotes a valid, current, grounded result to latestResult', async () => {
    const { bridge, emit } = makeFakeBridge();
    const store = new AnalysisStore(bridge);
    store.start();

    const snapshot = makeSnapshot();
    await store.analyze(snapshot);
    const { activeRequestId } = store.getState();
    expect(activeRequestId).toBeTruthy();

    emit({
      protocolVersion: 1,
      requestId: activeRequestId!,
      event: 'completed',
      payload: validResultPayload({ levels: { support: { levelId: 'lvl-1', price: 578.5 } } }),
    });

    expect(store.getState().isAnalyzing).toBe(false);
    expect(store.getState().latestResult?.levels.support).toEqual({
      levelId: 'lvl-1',
      price: 578.5,
    });
  });

  it('drops an ungrounded level instead of promoting it', async () => {
    const { bridge, emit } = makeFakeBridge();
    const store = new AnalysisStore(bridge);
    store.start();

    await store.analyze(makeSnapshot());
    const { activeRequestId } = store.getState();

    emit({
      protocolVersion: 1,
      requestId: activeRequestId!,
      event: 'completed',
      payload: validResultPayload({ levels: { support: { levelId: 'ghost-level', price: 999 } } }),
    });

    expect(store.getState().latestResult?.levels.support).toBeUndefined();
  });

  it('discards a result whose context is stale (snapshot sequence moved on)', async () => {
    const { bridge, emit } = makeFakeBridge();
    const store = new AnalysisStore(bridge);
    store.start();

    await store.analyze(makeSnapshot({ snapshotSequence: 1 }));
    const { activeRequestId } = store.getState();

    emit({
      protocolVersion: 1,
      requestId: activeRequestId!,
      event: 'completed',
      payload: validResultPayload({
        context: { symbol: 'SPY', timeframe: '5m', snapshotSequence: 1, positionVersion: 0 },
      }),
    });
    expect(store.getState().latestResult).not.toBeNull();

    // A newer snapshot supersedes the one that was analyzed, without a new
    // analyze() call completing yet.
    await store.analyze(makeSnapshot({ snapshotSequence: 2 }));
    const secondRequestId = store.getState().activeRequestId;

    emit({
      protocolVersion: 1,
      requestId: secondRequestId!,
      event: 'completed',
      payload: validResultPayload({
        analysisId: 'a2',
        context: { symbol: 'SPY', timeframe: '5m', snapshotSequence: 1, positionVersion: 0 }, // stale: still sequence 1
      }),
    });

    // Result carries stale context (sequence 1) even though the snapshot
    // analyzed was sequence 2 — must not overwrite latestResult with it.
    expect(store.getState().latestResult?.analysisId).toBe('a1');
  });

  it('discards a structurally invalid result instead of crashing', async () => {
    const { bridge, emit } = makeFakeBridge();
    const store = new AnalysisStore(bridge);
    store.start();

    await store.analyze(makeSnapshot());
    const { activeRequestId } = store.getState();

    emit({
      protocolVersion: 1,
      requestId: activeRequestId!,
      event: 'completed',
      payload: { garbage: true },
    });

    expect(store.getState().latestResult).toBeNull();
    expect(store.getState().errorMessage).toContain('invalid result');
  });

  it('ignores events for a request it did not originate', async () => {
    const { bridge, emit } = makeFakeBridge();
    const store = new AnalysisStore(bridge);
    store.start();

    await store.analyze(makeSnapshot());
    emit({
      protocolVersion: 1,
      requestId: 'someone-elses-request',
      event: 'completed',
      payload: validResultPayload(),
    });

    expect(store.getState().latestResult).toBeNull();
    expect(store.getState().isAnalyzing).toBe(true);
  });

  it('clears isAnalyzing and activeRequestId on cancellation', async () => {
    const { bridge, emit } = makeFakeBridge();
    const store = new AnalysisStore(bridge);
    store.start();

    await store.analyze(makeSnapshot());
    const { activeRequestId } = store.getState();
    emit({ protocolVersion: 1, requestId: activeRequestId!, event: 'cancelled' });

    expect(store.getState().isAnalyzing).toBe(false);
    expect(store.getState().activeRequestId).toBeNull();
  });

  it('surfaces a failure message and clears the active request', async () => {
    const { bridge, emit } = makeFakeBridge();
    const store = new AnalysisStore(bridge);
    store.start();

    await store.analyze(makeSnapshot());
    const { activeRequestId } = store.getState();
    emit({
      protocolVersion: 1,
      requestId: activeRequestId!,
      event: 'failed',
      error: { code: 'model_runtime_failure', message: 'boom' },
    });

    expect(store.getState().errorMessage).toBe('boom');
    expect(store.getState().isAnalyzing).toBe(false);
  });

  it('does not start a second analysis while one is in flight', async () => {
    const { bridge, analyzeMock } = makeFakeBridge();
    const store = new AnalysisStore(bridge);
    await store.analyze(makeSnapshot());
    await store.analyze(makeSnapshot());
    expect(analyzeMock).toHaveBeenCalledTimes(1);
  });

  it('cancel() calls the bridge with the active request id', async () => {
    const { bridge, cancelMock } = makeFakeBridge();
    const store = new AnalysisStore(bridge);
    await store.analyze(makeSnapshot());
    const { activeRequestId } = store.getState();
    await store.cancel();
    expect(cancelMock).toHaveBeenCalledWith(activeRequestId);
  });

  it('cancel() is a no-op when nothing is active', async () => {
    const { bridge, cancelMock } = makeFakeBridge();
    const store = new AnalysisStore(bridge);
    await store.cancel();
    expect(cancelMock).not.toHaveBeenCalled();
  });
});
