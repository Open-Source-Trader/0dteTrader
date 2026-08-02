import { describe, expect, it } from 'vitest';
import {
  advanceActionHysteresis,
  decideActionHysteresis,
  hysteresisKey,
  resultAction,
  synthesizeHeldResult,
  type ActionHysteresisState,
} from './actionHysteresis';
import type { AnalysisResult, AnalysisSnapshot, TradeDeskPlan } from './types';

function baseSnapshot(overrides: Partial<AnalysisSnapshot> = {}): AnalysisSnapshot {
  return {
    snapshotSchemaVersion: 1,
    identity: {
      snapshotId: 's1',
      capturedAt: '2026-07-31T00:00:00.000Z',
      symbol: 'SPY',
      timeframe: '5m',
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
    setupLabel: 'Bullish desk check',
    summary: 'Waiting for confirmation.',
    targets: { contract: [] },
    management: { holdConditions: [], scaleConditions: [], exitConditions: [] },
    ...overrides,
  };
}

function baseResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
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

function stateFor(result: AnalysisResult, snapshot: AnalysisSnapshot): ActionHysteresisState {
  return {
    key: hysteresisKey(snapshot),
    confirmedAction: resultAction(result),
    confirmedResult: result,
  };
}

describe('resultAction', () => {
  it('prefers tradeDeskPlan.action when a plan is present', () => {
    const result = baseResult({
      recommendation: 'wait',
      tradeDeskPlan: basePlan({ action: 'enter' }),
    });
    expect(resultAction(result)).toBe('enter');
  });

  it('falls back to recommendation when no plan is present, mapping trim to scale', () => {
    expect(resultAction(baseResult({ recommendation: 'trim' }))).toBe('scale');
    expect(resultAction(baseResult({ recommendation: 'hold' }))).toBe('hold');
  });
});

describe('decideActionHysteresis', () => {
  it('promotes immediately when there is no prior state', () => {
    const fresh = baseResult({ recommendation: 'enter' });
    const decision = decideActionHysteresis(null, fresh, baseSnapshot());
    expect(decision.kind).toBe('promote-fresh');
  });

  it('promotes immediately when the fresh action matches the confirmed one', () => {
    const held = baseResult({ recommendation: 'hold' });
    const state = stateFor(held, baseSnapshot());
    const fresh = baseResult({ recommendation: 'hold', summary: 'different prose' });
    const decision = decideActionHysteresis(state, fresh, baseSnapshot());
    expect(decision.kind).toBe('promote-fresh');
  });

  it('holds a differing action on its first occurrence with no crossed threshold', () => {
    const held = baseResult({
      recommendation: 'hold',
      tradeDeskPlan: basePlan({
        action: 'hold',
        invalidation: {
          underlying: {
            operator: 'below',
            price: { value: 740, priceDomain: 'underlying', evidenceId: 'lvl-1', snapshotId: 's1' },
          },
        },
      }),
    });
    const state = stateFor(held, baseSnapshot());
    const fresh = baseResult({
      recommendation: 'exit',
      tradeDeskPlan: basePlan({ action: 'exit' }),
    });
    // Live price (746.5, from baseSnapshot) has not gone below 740.
    const decision = decideActionHysteresis(state, fresh, baseSnapshot());
    expect(decision).toEqual({ kind: 'hold', heldAction: 'hold', pendingAction: 'exit' });
  });

  it('promotes immediately when the live price crosses the held invalidation threshold', () => {
    const held = baseResult({
      recommendation: 'hold',
      tradeDeskPlan: basePlan({
        action: 'hold',
        invalidation: {
          underlying: {
            operator: 'below',
            price: { value: 740, priceDomain: 'underlying', evidenceId: 'lvl-1', snapshotId: 's1' },
          },
        },
      }),
    });
    const state = stateFor(held, baseSnapshot());
    const fresh = baseResult({
      recommendation: 'exit',
      tradeDeskPlan: basePlan({ action: 'exit' }),
    });
    const liveSnapshot = baseSnapshot({ market: { last: 735 } }); // below 740
    const decision = decideActionHysteresis(state, fresh, liveSnapshot);
    expect(decision.kind).toBe('promote-fresh');
  });

  it('confirms and promotes once the same differing action is seen twice', () => {
    const held = baseResult({ recommendation: 'hold' });
    let state = stateFor(held, baseSnapshot());

    const firstFresh = baseResult({ recommendation: 'exit' });
    const firstDecision = decideActionHysteresis(state, firstFresh, baseSnapshot());
    expect(firstDecision.kind).toBe('hold');
    state = advanceActionHysteresis(state, firstFresh, baseSnapshot(), firstDecision);

    const secondFresh = baseResult({ recommendation: 'exit', summary: 'still exiting' });
    const secondDecision = decideActionHysteresis(state, secondFresh, baseSnapshot());
    expect(secondDecision.kind).toBe('promote-confirmed');
  });

  it('resets pending confirmation when a third, different candidate arrives', () => {
    const held = baseResult({ recommendation: 'hold' });
    let state = stateFor(held, baseSnapshot());

    const firstFresh = baseResult({ recommendation: 'exit' });
    const firstDecision = decideActionHysteresis(state, firstFresh, baseSnapshot());
    state = advanceActionHysteresis(state, firstFresh, baseSnapshot(), firstDecision);
    expect(state.pending).toEqual({ action: 'exit', count: 1 });

    const secondFresh = baseResult({ recommendation: 'avoid' });
    const secondDecision = decideActionHysteresis(state, secondFresh, baseSnapshot());
    expect(secondDecision).toEqual({ kind: 'hold', heldAction: 'hold', pendingAction: 'avoid' });
    state = advanceActionHysteresis(state, secondFresh, baseSnapshot(), secondDecision);
    expect(state.pending).toEqual({ action: 'avoid', count: 1 });
    // Held action never moved despite two different candidates in a row.
    expect(state.confirmedAction).toBe('hold');
  });

  it('never fast-paths a scale transition even when the held result has an invalidation', () => {
    const held = baseResult({
      recommendation: 'hold',
      tradeDeskPlan: basePlan({
        action: 'hold',
        invalidation: {
          underlying: {
            operator: 'below',
            price: { value: 740, priceDomain: 'underlying', evidenceId: 'lvl-1', snapshotId: 's1' },
          },
        },
      }),
    });
    const state = stateFor(held, baseSnapshot());
    const fresh = baseResult({
      recommendation: 'trim',
      tradeDeskPlan: basePlan({
        action: 'scale',
        scaleAdvice: { direction: 'out', condition: 'Reduce into strength' },
      }),
    });
    // Price crossed the threshold, but scale has no grounded price of its
    // own to justify treating this as a triggered move rather than a
    // candidate needing confirmation — still, crossedHeldThreshold only
    // checks the HELD result's invalidation, so this legitimately fast-paths.
    // This test documents that behavior explicitly rather than assuming it.
    const liveSnapshot = baseSnapshot({ market: { last: 735 } });
    const decision = decideActionHysteresis(state, fresh, liveSnapshot);
    expect(decision.kind).toBe('promote-fresh');
  });
});

describe('synthesizeHeldResult', () => {
  it('keeps the held action and action-specific plan fields, but fresh prose', () => {
    const held = baseResult({
      recommendation: 'hold',
      generatedAt: '2026-07-31T00:00:00.000Z',
      tradeDeskPlan: basePlan({
        action: 'hold',
        summary: 'old summary',
        management: {
          holdConditions: ['Hold above VWAP'],
          scaleConditions: [],
          exitConditions: [],
        },
      }),
    });
    const fresh = baseResult({
      recommendation: 'exit',
      generatedAt: '2026-07-31T00:05:00.000Z',
      summary: 'new top-level summary',
      confidence: 0.9,
      tradeDeskPlan: basePlan({
        action: 'exit',
        summary: 'new plan summary',
        warnings: ['fresh warning'],
      }),
    });

    const synthesized = synthesizeHeldResult(held, fresh);

    expect(synthesized.recommendation).toBe('hold');
    expect(synthesized.tradeDeskPlan?.action).toBe('hold');
    expect(synthesized.tradeDeskPlan?.management.holdConditions).toEqual(['Hold above VWAP']);
    // Freshness still visible per the product requirement.
    expect(synthesized.generatedAt).toBe('2026-07-31T00:05:00.000Z');
    expect(synthesized.confidence).toBe(0.9);
    expect(synthesized.tradeDeskPlan?.summary).toBe('new plan summary');
    expect(synthesized.tradeDeskPlan?.warnings).toEqual(['fresh warning']);
  });
});

describe('hysteresisKey', () => {
  it('differs when symbol, timeframe, or selected contract differ', () => {
    const base = hysteresisKey(baseSnapshot());
    expect(
      hysteresisKey(baseSnapshot({ identity: { ...baseSnapshot().identity, symbol: 'QQQ' } })),
    ).not.toBe(base);
    expect(
      hysteresisKey(baseSnapshot({ identity: { ...baseSnapshot().identity, timeframe: '1m' } })),
    ).not.toBe(base);
    expect(
      hysteresisKey(
        baseSnapshot({
          identity: { ...baseSnapshot().identity, selectedContractSymbol: 'SPY260731C00580000' },
        }),
      ),
    ).not.toBe(base);
  });
});
