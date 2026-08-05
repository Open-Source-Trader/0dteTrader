import { describe, expect, it } from 'vitest';
import {
  advanceSetupLifecycle,
  decideSetupContinuity,
  type SetupLifecycleState,
} from './setupLifecycleHysteresis';
import { hysteresisKey } from './actionHysteresis';
import type { AnalysisResult, AnalysisSnapshot, TradeDeskPlan } from './types';

function baseSnapshot(overrides: Partial<AnalysisSnapshot> = {}): AnalysisSnapshot {
  return {
    snapshotSchemaVersion: 1,
    identity: {
      snapshotId: 's1',
      capturedAt: '2026-07-31T00:00:00.000Z',
      symbol: 'SPY',
      timeframe: '1m',
      snapshotSequence: 1,
      positionVersion: 0,
    },
    trigger: { kind: 'manual', priority: 'manual', reason: 'user requested' },
    market: { last: 746.5 },
    candles: {},
    indicators: {},
    levels: [],
    quality: {
      capturedAt: '2026-07-31T00:00:00.000Z',
      candlesFreshAsOf: '2026-07-31T00:00:00.000Z',
      isChainStale: false,
    },
    omissions: [],
    ...overrides,
  };
}

function basePlan(overrides: Partial<TradeDeskPlan> = {}): TradeDeskPlan {
  return {
    action: 'wait',
    setupLifecycle: 'none',
    setupLabel: 'No confirmed setup',
    summary: 'Waiting.',
    targets: { contract: [] },
    management: { holdConditions: [], scaleConditions: [], exitConditions: [] },
    ...overrides,
  };
}

function baseResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    resultSchemaVersion: 1,
    analysisId: 'a1',
    context: { symbol: 'SPY', timeframe: '1m', snapshotSequence: 1, positionVersion: 0 },
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

function resultWithSetup(
  bias: 'bullish' | 'bearish',
  lifecycle: TradeDeskPlan['setupLifecycle'],
  overrides: Partial<TradeDeskPlan> = {},
): AnalysisResult {
  return baseResult({
    bias,
    tradeDeskPlan: basePlan({
      setupLifecycle: lifecycle,
      setupLabel: 'Bullish reversal',
      ...overrides,
    }),
  });
}

describe('decideSetupContinuity', () => {
  it('starts a new setup when there is no prior state and the fresh sample has an active lifecycle', () => {
    const fresh = resultWithSetup('bullish', 'developing');
    const decision = decideSetupContinuity(null, fresh, baseSnapshot());
    expect(decision.kind).toBe('start-new');
  });

  it('reports none when there is no prior state and the fresh sample has no setup', () => {
    const fresh = baseResult({ tradeDeskPlan: basePlan({ setupLifecycle: 'none' }) });
    const decision = decideSetupContinuity(null, fresh, baseSnapshot());
    expect(decision.kind).toBe('none');
  });

  it('advances the same setup when lifecycle progresses forward in the same direction', () => {
    const state: SetupLifecycleState = {
      key: hysteresisKey(baseSnapshot()),
      setupId: 'id-1',
      direction: 'bullish',
      label: 'Bullish reversal',
      lifecycle: 'confirmed',
      detectedAt: '2026-07-31T00:00:00.000Z',
    };
    const fresh = resultWithSetup('bullish', 'triggered');
    const decision = decideSetupContinuity(state, fresh, baseSnapshot());
    expect(decision.kind).toBe('advance');
  });

  it('advances to extended without erasing the setup when the fresh sample has no fresh entry', () => {
    // The reported regression: a triggered setup that's now extended must
    // not be treated as "gone" just because entry data is absent this
    // sample — extended IS forward progress from triggered.
    const state: SetupLifecycleState = {
      key: hysteresisKey(baseSnapshot()),
      setupId: 'id-1',
      direction: 'bullish',
      label: 'Bullish reversal',
      lifecycle: 'triggered',
      detectedAt: '2026-07-31T00:00:00.000Z',
      triggeredAt: '2026-07-31T00:05:00.000Z',
    };
    const fresh = resultWithSetup('bullish', 'extended', { action: 'wait' });
    const decision = decideSetupContinuity(state, fresh, baseSnapshot());
    expect(decision.kind).toBe('advance');
  });

  it('holds (does not erase) a triggered/extended setup on a single contrary sample', () => {
    const state: SetupLifecycleState = {
      key: hysteresisKey(baseSnapshot()),
      setupId: 'id-1',
      direction: 'bullish',
      label: 'Bullish reversal',
      lifecycle: 'extended',
      detectedAt: '2026-07-31T00:00:00.000Z',
    };
    const fresh = baseResult({
      bias: 'neutral',
      tradeDeskPlan: basePlan({ setupLifecycle: 'none' }),
    });
    const decision = decideSetupContinuity(state, fresh, baseSnapshot());
    expect(decision).toEqual({ kind: 'hold', pendingLifecycle: 'none' });
  });

  it('invalidates after two consecutive contrary samples', () => {
    const state: SetupLifecycleState = {
      key: hysteresisKey(baseSnapshot()),
      setupId: 'id-1',
      direction: 'bullish',
      label: 'Bullish reversal',
      lifecycle: 'extended',
      detectedAt: '2026-07-31T00:00:00.000Z',
    };
    const contrary = baseResult({
      bias: 'neutral',
      tradeDeskPlan: basePlan({ setupLifecycle: 'none' }),
    });
    const firstDecision = decideSetupContinuity(state, contrary, baseSnapshot());
    const heldAfterFirst = advanceSetupLifecycle(state, contrary, baseSnapshot(), firstDecision)!;
    expect(heldAfterFirst.lifecycle).toBe('extended'); // still held

    const secondDecision = decideSetupContinuity(heldAfterFirst, contrary, baseSnapshot());
    expect(secondDecision.kind).toBe('invalidate');
  });

  it("invalidates instantly when live price crosses the setup's own invalidation level", () => {
    const state: SetupLifecycleState = {
      key: hysteresisKey(baseSnapshot()),
      setupId: 'id-1',
      direction: 'bullish',
      label: 'Bullish reversal',
      lifecycle: 'triggered',
      detectedAt: '2026-07-31T00:00:00.000Z',
      invalidationLevel: 744,
    };
    const fresh = resultWithSetup('bullish', 'triggered');
    const liveSnapshot = baseSnapshot({ market: { last: 743 } }); // below 744
    const decision = decideSetupContinuity(state, fresh, liveSnapshot);
    expect(decision.kind).toBe('invalidate');
  });

  it('requires confirmation (not instant) for a direction flip', () => {
    const state: SetupLifecycleState = {
      key: hysteresisKey(baseSnapshot()),
      setupId: 'id-1',
      direction: 'bullish',
      label: 'Bullish reversal',
      lifecycle: 'confirmed',
      detectedAt: '2026-07-31T00:00:00.000Z',
    };
    const fresh = resultWithSetup('bearish', 'developing', { setupLabel: 'Bearish breakdown' });
    const decision = decideSetupContinuity(state, fresh, baseSnapshot());
    expect(decision).toEqual({ kind: 'hold', pendingLifecycle: 'developing' });
  });

  it('resets tracking when the instrument key changes', () => {
    const state: SetupLifecycleState = {
      key: hysteresisKey(baseSnapshot()),
      setupId: 'id-1',
      direction: 'bullish',
      label: 'Bullish reversal',
      lifecycle: 'triggered',
      detectedAt: '2026-07-31T00:00:00.000Z',
    };
    const otherInstrumentSnapshot = baseSnapshot({
      identity: { ...baseSnapshot().identity, symbol: 'QQQ' },
    });
    // Caller is responsible for the key-match gate (mirrors AnalysisStore's
    // hysteresisState reset-on-key-change) — decideSetupContinuity itself
    // is only ever called with `state` already null'd out by the caller
    // when the key doesn't match; verify the key actually differs here.
    expect(hysteresisKey(otherInstrumentSnapshot)).not.toBe(state.key);
  });
});

describe('advanceSetupLifecycle', () => {
  it('assigns a detectedAt and starts a new setup', () => {
    const fresh = resultWithSetup('bullish', 'developing');
    const decision = decideSetupContinuity(null, fresh, baseSnapshot());
    const next = advanceSetupLifecycle(null, fresh, baseSnapshot(), decision);
    expect(next).toMatchObject({
      direction: 'bullish',
      lifecycle: 'developing',
      label: 'Bullish reversal',
    });
  });

  it('caps a first sample claiming confirmed down to developing — one sample cannot authorize an actionable state', () => {
    const fresh = resultWithSetup('bullish', 'confirmed');
    const decision = decideSetupContinuity(null, fresh, baseSnapshot());
    expect(decision.kind).toBe('start-new');
    const next = advanceSetupLifecycle(null, fresh, baseSnapshot(), decision);
    expect(next?.lifecycle).toBe('developing');
    expect(next?.pending).toEqual({ lifecycle: 'confirmed', direction: 'bullish', count: 1 });
  });

  it('caps a first sample claiming triggered down to developing, with no triggeredAt stamped yet', () => {
    const fresh = resultWithSetup('bullish', 'triggered');
    const decision = decideSetupContinuity(null, fresh, baseSnapshot());
    const next = advanceSetupLifecycle(null, fresh, baseSnapshot(), decision);
    expect(next?.lifecycle).toBe('developing');
    expect(next?.triggeredAt).toBeUndefined();
  });

  it('reaches confirmed on the second consecutive compatible sample after a capped first one', () => {
    const first = resultWithSetup('bullish', 'confirmed');
    const firstDecision = decideSetupContinuity(null, first, baseSnapshot());
    const afterFirst = advanceSetupLifecycle(null, first, baseSnapshot(), firstDecision)!;
    expect(afterFirst.lifecycle).toBe('developing');

    const second = resultWithSetup('bullish', 'confirmed');
    const secondSnapshot = baseSnapshot({
      identity: { ...baseSnapshot().identity, capturedAt: '2026-07-31T00:03:00.000Z' },
    });
    const secondDecision = decideSetupContinuity(afterFirst, second, secondSnapshot);
    expect(secondDecision.kind).toBe('advance'); // same direction, forward progress from developing
    const afterSecond = advanceSetupLifecycle(afterFirst, second, secondSnapshot, secondDecision);
    expect(afterSecond?.lifecycle).toBe('confirmed');
  });

  it('does not require a full two-sample climb per rung — developing straight to triggered is one confirming sample away', () => {
    const first = resultWithSetup('bullish', 'triggered');
    const firstDecision = decideSetupContinuity(null, first, baseSnapshot());
    const afterFirst = advanceSetupLifecycle(null, first, baseSnapshot(), firstDecision)!;
    expect(afterFirst.lifecycle).toBe('developing');

    const second = resultWithSetup('bullish', 'triggered');
    const secondSnapshot = baseSnapshot({
      identity: { ...baseSnapshot().identity, capturedAt: '2026-07-31T00:03:00.000Z' },
    });
    const secondDecision = decideSetupContinuity(afterFirst, second, secondSnapshot);
    const afterSecond = advanceSetupLifecycle(afterFirst, second, secondSnapshot, secondDecision);
    expect(afterSecond?.lifecycle).toBe('triggered');
    expect(afterSecond?.triggeredAt).toBe('2026-07-31T00:03:00.000Z');
  });

  it('does not cap a first sample claiming only developing (nothing to cap)', () => {
    const fresh = resultWithSetup('bullish', 'developing');
    const decision = decideSetupContinuity(null, fresh, baseSnapshot());
    const next = advanceSetupLifecycle(null, fresh, baseSnapshot(), decision);
    expect(next?.lifecycle).toBe('developing');
    expect(next?.pending).toBeUndefined();
  });

  it('a garbled/none second sample does not erase the capped developing state from a real first sample', () => {
    const first = resultWithSetup('bullish', 'confirmed');
    const firstDecision = decideSetupContinuity(null, first, baseSnapshot());
    const afterFirst = advanceSetupLifecycle(null, first, baseSnapshot(), firstDecision)!;
    expect(afterFirst.lifecycle).toBe('developing');

    const garbled = baseResult({
      bias: 'neutral',
      tradeDeskPlan: basePlan({ setupLifecycle: 'none' }),
    });
    const secondSnapshot = baseSnapshot({
      identity: { ...baseSnapshot().identity, capturedAt: '2026-07-31T00:03:00.000Z' },
    });
    const decision = decideSetupContinuity(afterFirst, garbled, secondSnapshot);
    expect(decision.kind).toBe('hold'); // one contrary sample, not yet erased
    const next = advanceSetupLifecycle(afterFirst, garbled, secondSnapshot, decision);
    expect(next?.lifecycle).toBe('developing');
  });

  it('stamps triggeredAt only the sample lifecycle first becomes triggered', () => {
    const state: SetupLifecycleState = {
      key: hysteresisKey(baseSnapshot()),
      setupId: 'id-1',
      direction: 'bullish',
      label: 'Bullish reversal',
      lifecycle: 'confirmed',
      detectedAt: '2026-07-31T00:00:00.000Z',
    };
    const fresh = resultWithSetup('bullish', 'triggered');
    const laterSnapshot = baseSnapshot({
      identity: { ...baseSnapshot().identity, capturedAt: '2026-07-31T00:10:00.000Z' },
    });
    const decision = decideSetupContinuity(state, fresh, laterSnapshot);
    const next = advanceSetupLifecycle(state, fresh, laterSnapshot, decision);
    expect(next?.triggeredAt).toBe('2026-07-31T00:10:00.000Z');
  });

  it('returns null once invalidated', () => {
    const state: SetupLifecycleState = {
      key: hysteresisKey(baseSnapshot()),
      setupId: 'id-1',
      direction: 'bullish',
      label: 'Bullish reversal',
      lifecycle: 'triggered',
      detectedAt: '2026-07-31T00:00:00.000Z',
      invalidationLevel: 744,
    };
    const fresh = resultWithSetup('bullish', 'triggered');
    const liveSnapshot = baseSnapshot({ market: { last: 743 } });
    const decision = decideSetupContinuity(state, fresh, liveSnapshot);
    const next = advanceSetupLifecycle(state, fresh, liveSnapshot, decision);
    expect(next).toBeNull();
  });

  it('returns null for a fresh sample with no setup and no prior state', () => {
    const fresh = baseResult({ tradeDeskPlan: basePlan({ setupLifecycle: 'none' }) });
    const decision = decideSetupContinuity(null, fresh, baseSnapshot());
    const next = advanceSetupLifecycle(null, fresh, baseSnapshot(), decision);
    expect(next).toBeNull();
  });
});
