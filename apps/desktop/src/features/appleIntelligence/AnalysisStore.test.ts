import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisStore } from './AnalysisStore';
import type {
  AppleIntelligenceBridge,
  NativeEventPayload,
} from '../../core/desktop/appleIntelligence';
import type { AnalysisSnapshot } from './types';

// Fixed to a regular-hours weekday (Wed 11:00 ET) so market-session-derived
// behavior — the fingerprint cache only short-circuits outside `live` mode —
// doesn't flip on and off depending on the real wall-clock time the suite
// happens to run at.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-29T15:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

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
    market: { last: 578.5, bid: 578.4, ask: 578.6 },
    candles: {
      recent: [
        { time: 1, open: 578, high: 579, low: 577, close: 578.5, volume: 1000 },
        { time: 2, open: 578.5, high: 579.2, low: 578.1, close: 578.9, volume: 900 },
      ],
    },
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
    expect(store.getState().lastDiscard?.message).toContain('invalid result');
    expect(store.getState().lastDiscard?.code).toBe('invalid-result');
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

    expect(store.getState().lastDiscard?.message).toBe('boom');
    expect(store.getState().lastDiscard?.code).toBe('runtime-failed');
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

  describe('eligibility gate', () => {
    it('never calls the bridge for an ineligible snapshot, and records the rejection reason', async () => {
      const { bridge, analyzeMock } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      const invalid = makeSnapshot();
      (invalid as unknown as { market: unknown }).market = { last: null, bid: null, ask: null };

      await store.analyze(invalid);

      expect(analyzeMock).not.toHaveBeenCalled();
      expect(store.getState().isAnalyzing).toBe(false);
      expect(store.getState().lastIneligibility).toMatchObject({
        reason: 'missing-underlying-quote',
      });
    });

    it('clears lastIneligibility once a subsequent eligible snapshot is submitted', async () => {
      const { bridge, analyzeMock } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      const invalid = makeSnapshot();
      (invalid as unknown as { market: unknown }).market = { last: null, bid: null, ask: null };
      await store.analyze(invalid);
      expect(store.getState().lastIneligibility).not.toBeNull();

      await store.analyze(makeSnapshot());

      expect(analyzeMock).toHaveBeenCalledTimes(1);
      expect(store.getState().lastIneligibility).toBeNull();
    });
  });

  describe('bridge error handling', () => {
    it('recovers from a rejected analyze() instead of leaving isAnalyzing stuck true', async () => {
      const bridge: AppleIntelligenceBridge = {
        getAvailability: vi.fn(async () => ({ state: 'ready' })),
        analyze: vi.fn(async () => {
          throw new Error('IPC channel closed');
        }),
        cancel: vi.fn(async () => undefined),
        subscribe: () => () => undefined,
      };
      const store = new AnalysisStore(bridge);

      await store.analyze(makeSnapshot());

      expect(store.getState().isAnalyzing).toBe(false);
      expect(store.getState().activeRequestId).toBeNull();
      expect(store.getState().lastDiscard?.message).toBe('IPC channel closed');
      expect(store.getState().lastDiscard?.code).toBe('request-failed');
    });

    it('allows a subsequent analyze() to proceed after a prior one rejected', async () => {
      let shouldReject = true;
      const analyzeMock = vi.fn(async ({ requestId }: { requestId: string }) => {
        if (shouldReject) {
          shouldReject = false;
          throw new Error('boom');
        }
        return { requestId };
      });
      const bridge: AppleIntelligenceBridge = {
        getAvailability: vi.fn(async () => ({ state: 'ready' })),
        analyze: analyzeMock,
        cancel: vi.fn(async () => undefined),
        subscribe: () => () => undefined,
      };
      const store = new AnalysisStore(bridge);

      await store.analyze(makeSnapshot({ snapshotId: 'first' }));
      expect(store.getState().isAnalyzing).toBe(false);

      await store.analyze(makeSnapshot({ snapshotId: 'second' }));
      expect(analyzeMock).toHaveBeenCalledTimes(2);
      expect(store.getState().isAnalyzing).toBe(true);
      expect(store.getState().activeRequestId).toBeTruthy();
    });

    it('a rejected cancel() does not block the preempting request from starting', async () => {
      const bridge: AppleIntelligenceBridge = {
        getAvailability: vi.fn(async () => ({ state: 'ready' })),
        analyze: vi.fn(async ({ requestId }: { requestId: string }) => ({ requestId })),
        cancel: vi.fn(async () => {
          throw new Error('already gone');
        }),
        subscribe: () => () => undefined,
      };
      const store = new AnalysisStore(bridge);

      await store.analyze(makeSnapshot({ snapshotId: 'background-1' }), 'background');
      await store.analyze(makeSnapshot({ snapshotId: 'manual-1' }), 'manual');

      expect(store.getState().activePriority).toBe('manual');
      expect(store.getState().isAnalyzing).toBe(true);
    });
  });

  describe('scheduling (Phase 4)', () => {
    it('queues a candle-close request submitted while manual work is active', async () => {
      const { bridge, analyzeMock } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      await store.analyze(makeSnapshot({ snapshotId: 'manual-1' }), 'manual');
      await store.submitCandleClose(makeSnapshot({ snapshotId: 'candle-1' }));

      expect(analyzeMock).toHaveBeenCalledTimes(1);
      expect(store.getState().queueDepth).toBe(1);
    });

    it('runs the next queued request automatically once the active one completes', async () => {
      const { bridge, emit, analyzeMock } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      await store.analyze(makeSnapshot({ snapshotId: 'manual-1' }), 'manual');
      const firstRequestId = store.getState().activeRequestId;
      await store.submitCandleClose(makeSnapshot({ snapshotId: 'candle-1' }));
      expect(store.getState().queueDepth).toBe(1);

      emit({
        protocolVersion: 1,
        requestId: firstRequestId!,
        event: 'completed',
        payload: validResultPayload({ analysisId: 'manual-result' }),
      });

      expect(analyzeMock).toHaveBeenCalledTimes(2);
      expect(store.getState().queueDepth).toBe(0);
      expect(store.getState().isAnalyzing).toBe(true);
    });

    it('validates and promotes the completed request against its OWN snapshot, not the newly-dequeued one', async () => {
      // Regression test: handleCompleted's finishActive() call synchronously
      // starts the next queued request (runNextQueued -> runNow), which
      // reassigns the store's internal snapshot reference before
      // handleCompleted used to read it — grounding a result's levels
      // against the wrong (queued) snapshot's candidate levels, and gating
      // staleness/promotion against the wrong context entirely.
      const { bridge, emit } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      // The manual request's snapshot only grounds 'lvl-1' (makeSnapshot's default).
      await store.analyze(makeSnapshot({ snapshotId: 'manual-1', snapshotSequence: 1 }), 'manual');
      const firstRequestId = store.getState().activeRequestId;

      // A queued candle-close snapshot with a DIFFERENT candidate level set
      // — if the bug is present, the manual result gets validated/grounded
      // against 'lvl-99' instead of 'lvl-1' and its support level is
      // incorrectly dropped as "ungrounded".
      const queuedSnapshot: AnalysisSnapshot = {
        ...makeSnapshot({ snapshotId: 'candle-1', snapshotSequence: 2 }),
        levels: [
          {
            id: 'lvl-99',
            kind: 'pivot',
            role: 'support',
            price: 999,
            evidence: 'different snapshot entirely',
            testCount: 1,
            recency: 'today',
            strength: 0.9,
            source: 'pivot-low',
          },
        ],
      };
      await store.submitCandleClose(queuedSnapshot);
      expect(store.getState().queueDepth).toBe(1);

      emit({
        protocolVersion: 1,
        requestId: firstRequestId!,
        event: 'completed',
        payload: validResultPayload({
          analysisId: 'manual-result',
          context: { symbol: 'SPY', timeframe: '5m', snapshotSequence: 1, positionVersion: 0 },
          levels: { support: { levelId: 'lvl-1', price: 578.5 } },
        }),
      });

      // Must be grounded against the manual request's own snapshot (lvl-1
      // survives), promoted as current (snapshotSequence 1 matches what was
      // actually analyzed), not discarded or mismatched against candle-1's
      // snapshot (sequence 2, lvl-99).
      expect(store.getState().latestResult?.analysisId).toBe('manual-result');
      expect(store.getState().latestResult?.levels.support).toEqual({
        levelId: 'lvl-1',
        price: 578.5,
      });
      expect(store.getState().latestResult?.context.snapshotSequence).toBe(1);
      expect(store.getState().lastDiscard).toBeNull();
    });

    it('position-critical work preempts an active candle-close request', async () => {
      const { bridge, cancelMock, analyzeMock } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      await store.submitCandleClose(makeSnapshot({ snapshotId: 'candle-1' }));
      await store.analyze(makeSnapshot({ snapshotId: 'critical-1' }), 'position-critical');

      expect(cancelMock).toHaveBeenCalledTimes(1);
      expect(analyzeMock).toHaveBeenCalledTimes(2);
      expect(store.getState().activePriority).toBe('position-critical');
    });

    it('manual work does not preempt active position-critical work', async () => {
      const { bridge, cancelMock, analyzeMock } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      await store.analyze(makeSnapshot({ snapshotId: 'critical-1' }), 'position-critical');
      await store.analyze(makeSnapshot({ snapshotId: 'manual-1' }), 'manual');

      expect(cancelMock).not.toHaveBeenCalled();
      expect(analyzeMock).toHaveBeenCalledTimes(1);
      expect(store.getState().queueDepth).toBe(1);
    });

    it('discardStaleBackgroundWork clears only queued background work', async () => {
      const { bridge } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      await store.analyze(makeSnapshot({ snapshotId: 'manual-1' }), 'manual');
      await store.analyze(makeSnapshot({ snapshotId: 'bg-1' }), 'background');
      store.discardStaleBackgroundWork();
      expect(store.getState().queueDepth).toBe(0);
    });
  });

  describe('history (Phase 4)', () => {
    it('records a promoted result in history', async () => {
      const { bridge, emit } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();
      await store.analyze(makeSnapshot());
      const { activeRequestId } = store.getState();
      emit({
        protocolVersion: 1,
        requestId: activeRequestId!,
        event: 'completed',
        payload: validResultPayload(),
      });

      expect(store.getState().history).toHaveLength(1);
      expect(store.getState().history[0].wasPromoted).toBe(true);
    });

    it('retains a stale result in history without promoting it to latestResult', async () => {
      const { bridge, emit } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      await store.analyze(makeSnapshot({ snapshotSequence: 1 }));
      const firstRequestId = store.getState().activeRequestId;
      emit({
        protocolVersion: 1,
        requestId: firstRequestId!,
        event: 'completed',
        payload: validResultPayload({ analysisId: 'first' }),
      });
      expect(store.getState().latestResult?.analysisId).toBe('first');

      await store.analyze(makeSnapshot({ snapshotSequence: 2 }));
      const secondRequestId = store.getState().activeRequestId;
      emit({
        protocolVersion: 1,
        requestId: secondRequestId!,
        event: 'completed',
        payload: validResultPayload({
          analysisId: 'stale-second',
          context: { symbol: 'SPY', timeframe: '5m', snapshotSequence: 1, positionVersion: 0 },
        }),
      });

      // Stale result is retained in history for diagnostics...
      expect(store.getState().history.some((h) => h.result.analysisId === 'stale-second')).toBe(
        true,
      );
      expect(
        store.getState().history.find((h) => h.result.analysisId === 'stale-second')?.wasPromoted,
      ).toBe(false);
      // ...but must never replace current guidance.
      expect(store.getState().latestResult?.analysisId).toBe('first');
    });

    it('caps history at 20 entries', async () => {
      const { bridge, emit } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      for (let i = 0; i < 25; i++) {
        await store.analyze(makeSnapshot({ snapshotId: `s${i}`, snapshotSequence: i }));
        const requestId = store.getState().activeRequestId;
        emit({
          protocolVersion: 1,
          requestId: requestId!,
          event: 'completed',
          payload: validResultPayload({
            analysisId: `a${i}`,
            context: { symbol: 'SPY', timeframe: '5m', snapshotSequence: i, positionVersion: 0 },
          }),
        });
      }

      expect(store.getState().history).toHaveLength(20);
      expect(store.getState().history[0].result.analysisId).toBe('a24');
    });

    it('records analysis duration on completion', async () => {
      const { bridge, emit } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();
      await store.analyze(makeSnapshot());
      const { activeRequestId } = store.getState();
      emit({
        protocolVersion: 1,
        requestId: activeRequestId!,
        event: 'completed',
        payload: validResultPayload(),
      });

      expect(store.getState().lastAnalysisDurationMs).not.toBeNull();
      expect(store.getState().lastAnalysisDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('repeated analysis', () => {
    /** No result cache while the market is live: every analyze() call —
     * including a Refresh whose snapshot content happens to be unchanged —
     * always invokes the bridge again. An earlier, unconditional content-
     * keyed cache was tried and reverted: live market/candle data ticks on
     * nearly every capture, so "unchanged" essentially never occurred while
     * markets were open, making the cache both ineffective (rarely hit) and
     * confusing (a rare hit produced no visible feedback, reading as
     * "Refresh does nothing"). The current fingerprint cache reintroduces
     * caching but scoped to non-live mode only — see the closed-market case
     * below — for exactly the scenario an unconditional cache couldn't
     * usefully serve: a market-closed Refresh against genuinely unchanged
     * data. */
    it('calls the bridge again for a snapshot with identical content to the last one, while the market is live', async () => {
      const { bridge, emit, analyzeMock } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      const first = makeSnapshot({ snapshotSequence: 1 });
      await store.analyze(first);
      const firstRequestId = store.getState().activeRequestId;
      emit({
        protocolVersion: 1,
        requestId: firstRequestId!,
        event: 'completed',
        payload: validResultPayload({ analysisId: 'a1' }),
      });
      expect(analyzeMock).toHaveBeenCalledTimes(1);

      const second = makeSnapshot({ snapshotId: 'different-snapshot-id', snapshotSequence: 2 });
      await store.analyze(second);

      expect(analyzeMock).toHaveBeenCalledTimes(2);
    });

    it('reuses the cached result instead of calling the bridge again for identical content while the market is closed', async () => {
      vi.setSystemTime(new Date('2026-08-01T15:00:00.000Z')); // Saturday — market closed
      const { bridge, emit, analyzeMock } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      const first = makeSnapshot({ snapshotSequence: 1 });
      await store.analyze(first);
      const firstRequestId = store.getState().activeRequestId;
      emit({
        protocolVersion: 1,
        requestId: firstRequestId!,
        event: 'completed',
        payload: validResultPayload({ analysisId: 'a1' }),
      });
      expect(analyzeMock).toHaveBeenCalledTimes(1);
      expect(store.getState().latestResult?.analysisId).toBe('a1');

      // Same content, different identity fields (as a manual Refresh would
      // produce) — must reuse the cached result, not call the bridge again.
      const second = makeSnapshot({ snapshotId: 'different-snapshot-id', snapshotSequence: 2 });
      await store.analyze(second);

      expect(analyzeMock).toHaveBeenCalledTimes(1);
      expect(store.getState().latestResult?.analysisId).toBe('a1');
    });

    it('calls the bridge again when content actually changes, even while the market is closed', async () => {
      vi.setSystemTime(new Date('2026-08-01T15:00:00.000Z')); // Saturday — market closed
      const { bridge, emit, analyzeMock } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      const first = makeSnapshot({ snapshotSequence: 1 });
      await store.analyze(first);
      emit({
        protocolVersion: 1,
        requestId: store.getState().activeRequestId!,
        event: 'completed',
        payload: validResultPayload({ analysisId: 'a1' }),
      });
      expect(analyzeMock).toHaveBeenCalledTimes(1);

      const changed = makeSnapshot({ snapshotSequence: 2 });
      (changed as unknown as { market: unknown }).market = { last: 999, bid: 998.9, ask: 999.1 };
      await store.analyze(changed);

      expect(analyzeMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('action hysteresis', () => {
    /** Runs one analyze()/completed round trip and returns the resulting
     * state — the test's unit of "one sample". */
    async function analyzeOnce(
      store: AnalysisStore,
      emit: (event: NativeEventPayload) => void,
      overrides: { snapshotSequence: number; payload: Record<string, unknown> },
    ) {
      await store.analyze(makeSnapshot({ snapshotSequence: overrides.snapshotSequence }));
      const requestId = store.getState().activeRequestId;
      emit({
        protocolVersion: 1,
        requestId: requestId!,
        event: 'completed',
        payload: validResultPayload({
          context: {
            symbol: 'SPY',
            timeframe: '5m',
            snapshotSequence: overrides.snapshotSequence,
            positionVersion: 0,
          },
          ...overrides.payload,
        }),
      });
      return store.getState();
    }

    it('promotes the first-ever result immediately, with nothing pending', async () => {
      const { bridge, emit } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      const state = await analyzeOnce(store, emit, {
        snapshotSequence: 1,
        payload: { recommendation: 'hold' },
      });

      expect(state.latestResult?.recommendation).toBe('hold');
      expect(state.pendingActionChange).toBeNull();
    });

    it('holds a lone contrary action instead of flipping immediately', async () => {
      const { bridge, emit } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      await analyzeOnce(store, emit, { snapshotSequence: 1, payload: { recommendation: 'hold' } });
      const afterSecond = await analyzeOnce(store, emit, {
        snapshotSequence: 2,
        payload: { analysisId: 'a2', recommendation: 'exit', summary: 'fresh prose' },
      });

      // Action stays held at 'hold' — a single contrary sample is not enough.
      expect(afterSecond.latestResult?.recommendation).toBe('hold');
      // But freshness (prose) still visibly updates, per the product
      // requirement that advice stay up to date as markets run.
      expect(afterSecond.latestResult?.summary).toBe('fresh prose');
      expect(afterSecond.pendingActionChange).toEqual({ action: 'exit' });
    });

    it('confirms and promotes a changed action once seen twice in a row', async () => {
      const { bridge, emit } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      await analyzeOnce(store, emit, { snapshotSequence: 1, payload: { recommendation: 'hold' } });
      await analyzeOnce(store, emit, {
        snapshotSequence: 2,
        payload: { analysisId: 'a2', recommendation: 'exit' },
      });
      const afterThird = await analyzeOnce(store, emit, {
        snapshotSequence: 3,
        payload: { analysisId: 'a3', recommendation: 'exit' },
      });

      expect(afterThird.latestResult?.recommendation).toBe('exit');
      expect(afterThird.latestResult?.analysisId).toBe('a3');
      expect(afterThird.pendingActionChange).toBeNull();
    });

    it('does not accumulate partial confirmation across two different candidates', async () => {
      const { bridge, emit } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      await analyzeOnce(store, emit, { snapshotSequence: 1, payload: { recommendation: 'hold' } });
      await analyzeOnce(store, emit, {
        snapshotSequence: 2,
        payload: { analysisId: 'a2', recommendation: 'exit' },
      });
      const afterThird = await analyzeOnce(store, emit, {
        snapshotSequence: 3,
        payload: { analysisId: 'a3', recommendation: 'avoid' },
      });

      // Two different contrary candidates in a row — neither confirmed.
      expect(afterThird.latestResult?.recommendation).toBe('hold');
      expect(afterThird.pendingActionChange).toEqual({ action: 'avoid' });
    });
  });

  describe('setup lifecycle persistence', () => {
    function setupPlanPayload(
      resultOverrides: Record<string, unknown> = {},
      planOverrides: Record<string, unknown> = {},
    ) {
      return validResultPayload({
        bias: 'bullish',
        ...resultOverrides,
        tradeDeskPlan: {
          action: 'wait',
          setupLifecycle: 'developing',
          setupLabel: 'Bullish reversal',
          summary: 'Reclaim in progress.',
          // developing (and beyond) requires invalidation + targets —
          // only the entry itself legitimately waits for a real trigger.
          invalidation: {
            underlying: {
              operator: 'below',
              price: {
                value: 578,
                priceDomain: 'underlying',
                evidenceId: 'swing-low',
                snapshotId: 's1',
              },
            },
          },
          targets: {
            contract: [],
            underlying: [
              {
                role: 'first',
                price: {
                  value: 582,
                  priceDomain: 'underlying',
                  evidenceId: 'vwap',
                  snapshotId: 's1',
                },
              },
            ],
          },
          management: { holdConditions: [], scaleConditions: [], exitConditions: [] },
          ...planOverrides,
        },
      });
    }

    it('omits priorSetup from the outgoing snapshot when nothing is tracked yet', async () => {
      const { bridge, analyzeMock } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      await store.analyze(makeSnapshot());
      const sentSnapshot = analyzeMock.mock.calls[0][0].payload;
      expect(sentSnapshot.priorSetup).toBeUndefined();
    });

    it('attaches priorSetup on the next request once a setup has been promoted', async () => {
      const { bridge, emit, analyzeMock } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      await store.analyze(makeSnapshot({ snapshotSequence: 1 }));
      const firstRequestId = store.getState().activeRequestId;
      emit({
        protocolVersion: 1,
        requestId: firstRequestId!,
        event: 'completed',
        payload: setupPlanPayload({
          context: { symbol: 'SPY', timeframe: '5m', snapshotSequence: 1, positionVersion: 0 },
        }),
      });

      await store.analyze(makeSnapshot({ snapshotSequence: 2 }));
      const secondSentSnapshot = analyzeMock.mock.calls[1][0].payload;
      expect(secondSentSnapshot.priorSetup).toMatchObject({
        direction: 'bullish',
        label: 'Bullish reversal',
        lifecycle: 'developing',
      });
    });

    it('does not attach priorSetup for a different instrument (symbol changed)', async () => {
      const { bridge, emit, analyzeMock } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      await store.analyze(makeSnapshot({ snapshotSequence: 1 }));
      const firstRequestId = store.getState().activeRequestId;
      emit({
        protocolVersion: 1,
        requestId: firstRequestId!,
        event: 'completed',
        payload: setupPlanPayload({
          context: { symbol: 'SPY', timeframe: '5m', snapshotSequence: 1, positionVersion: 0 },
        }),
      });

      await store.analyze(makeSnapshot({ symbol: 'QQQ', snapshotSequence: 2 } as never));
      const secondSentSnapshot = analyzeMock.mock.calls[1][0].payload;
      expect(secondSentSnapshot.priorSetup).toBeUndefined();
    });

    it('keeps the real setupLabel in latestResult across an analysis where entry data is absent (extended setup)', async () => {
      const { bridge, emit } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      await store.analyze(makeSnapshot({ snapshotSequence: 1 }));
      emit({
        protocolVersion: 1,
        requestId: store.getState().activeRequestId!,
        event: 'completed',
        payload: setupPlanPayload({
          context: { symbol: 'SPY', timeframe: '5m', snapshotSequence: 1, positionVersion: 0 },
        }),
      });
      expect(store.getState().latestResult?.tradeDeskPlan?.setupLabel).toBe('Bullish reversal');

      await store.analyze(makeSnapshot({ snapshotSequence: 2 }));
      emit({
        protocolVersion: 1,
        requestId: store.getState().activeRequestId!,
        event: 'completed',
        payload: setupPlanPayload(
          {
            analysisId: 'a2',
            context: { symbol: 'SPY', timeframe: '5m', snapshotSequence: 2, positionVersion: 0 },
          },
          { setupLifecycle: 'extended', summary: 'Extended — do not chase.' },
        ),
      });

      expect(store.getState().latestResult?.tradeDeskPlan?.setupLifecycle).toBe('extended');
      expect(store.getState().latestResult?.tradeDeskPlan?.setupLabel).toBe('Bullish reversal');
    });
  });

  describe('lastDiscard persistence (error-state clobber fix)', () => {
    it('survives automatic next-run start instead of being cleared the instant a new request begins', async () => {
      const { bridge, emit } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      // First request fails (schema-invalid payload).
      await store.analyze(makeSnapshot());
      emit({
        protocolVersion: 1,
        requestId: store.getState().activeRequestId!,
        event: 'completed',
        payload: { garbage: true },
      });
      expect(store.getState().lastDiscard?.code).toBe('invalid-result');

      // A second request starts for the SAME instrument (e.g. an automatic
      // candle-close retry) — the old bug cleared errorMessage right here,
      // before the trader ever saw the discard reason.
      await store.analyze(makeSnapshot());
      expect(store.getState().lastDiscard?.code).toBe('invalid-result');
      expect(store.getState().isAnalyzing).toBe(true);
    });

    it('clears the discard once a matching successful result is promoted', async () => {
      const { bridge, emit } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      await store.analyze(makeSnapshot());
      emit({
        protocolVersion: 1,
        requestId: store.getState().activeRequestId!,
        event: 'completed',
        payload: { garbage: true },
      });
      expect(store.getState().lastDiscard).not.toBeNull();

      await store.analyze(makeSnapshot());
      emit({
        protocolVersion: 1,
        requestId: store.getState().activeRequestId!,
        event: 'completed',
        payload: validResultPayload(),
      });

      expect(store.getState().latestResult?.analysisId).toBe('a1');
      expect(store.getState().lastDiscard).toBeNull();
    });

    it('an unrelated (different-instrument) successful result does not clear the discard', async () => {
      const { bridge, emit } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      // Discard recorded for AAPL.
      await store.analyze(makeSnapshot({ symbol: 'AAPL' }));
      emit({
        protocolVersion: 1,
        requestId: store.getState().activeRequestId!,
        event: 'completed',
        payload: { garbage: true },
      });
      expect(store.getState().lastDiscard?.symbol).toBe('AAPL');

      // A different instrument's request starts and succeeds — starting it
      // clears the AAPL discard only because SPY is a materially different
      // context (isDiscardStillRelevant), matching runNow's own gating, not
      // because of the promotion itself.
      await store.analyze(makeSnapshot({ symbol: 'SPY' }));
      emit({
        protocolVersion: 1,
        requestId: store.getState().activeRequestId!,
        event: 'completed',
        payload: validResultPayload({
          context: { symbol: 'SPY', timeframe: '5m', snapshotSequence: 1, positionVersion: 0 },
        }),
      });

      expect(store.getState().latestResult?.context.symbol).toBe('SPY');
      expect(store.getState().lastDiscard).toBeNull();
    });

    it('a stale-context result is recorded as a discard and does not overwrite newer state', async () => {
      const { bridge, emit } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      await store.analyze(makeSnapshot({ snapshotSequence: 1 }));
      emit({
        protocolVersion: 1,
        requestId: store.getState().activeRequestId!,
        event: 'completed',
        payload: validResultPayload({
          context: { symbol: 'SPY', timeframe: '5m', snapshotSequence: 1, positionVersion: 0 },
        }),
      });
      expect(store.getState().latestResult?.analysisId).toBe('a1');

      // A newer snapshot supersedes the one that was analyzed, without a new
      // analyze() call completing yet.
      await store.analyze(makeSnapshot({ snapshotSequence: 2 }));

      // Completes with STALE context (still sequence 1) even though the
      // snapshot actually analyzed was sequence 2 — must be recorded as a
      // stale-context discard rather than silently vanishing, and must not
      // overwrite the still-valid prior result.
      emit({
        protocolVersion: 1,
        requestId: store.getState().activeRequestId!,
        event: 'completed',
        payload: validResultPayload({
          analysisId: 'a2-stale',
          context: { symbol: 'SPY', timeframe: '5m', snapshotSequence: 1, positionVersion: 0 },
        }),
      });

      expect(store.getState().latestResult?.analysisId).toBe('a1');
      expect(store.getState().lastDiscard?.code).toBe('stale-context');

      // A subsequent request that completes WITH a matching context
      // promotes normally and clears the discard.
      await store.analyze(makeSnapshot({ snapshotSequence: 3 }));
      emit({
        protocolVersion: 1,
        requestId: store.getState().activeRequestId!,
        event: 'completed',
        payload: validResultPayload({
          analysisId: 'a3-current',
          context: { symbol: 'SPY', timeframe: '5m', snapshotSequence: 3, positionVersion: 0 },
        }),
      });
      expect(store.getState().latestResult?.analysisId).toBe('a3-current');
      expect(store.getState().lastDiscard).toBeNull();
    });

    it('repeated automatic runs against a persistently invalid result do not oscillate the discard away', async () => {
      const { bridge, emit } = makeFakeBridge();
      const store = new AnalysisStore(bridge);
      store.start();

      for (let i = 0; i < 3; i++) {
        await store.analyze(makeSnapshot());
        emit({
          protocolVersion: 1,
          requestId: store.getState().activeRequestId!,
          event: 'completed',
          payload: { garbage: true },
        });
        expect(store.getState().lastDiscard?.code).toBe('invalid-result');
      }
      expect(store.getState().latestResult).toBeNull();
    });
  });
});
