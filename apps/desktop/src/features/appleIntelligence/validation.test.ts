import { describe, expect, it } from 'vitest';
import {
  enforceTradeDeskInvariants,
  hasValidSetupLifecycleEvidence,
  hasValidSetupLifecycleLabel,
  isTradeDeskActionSatisfied,
  parseAnalysisResult,
  rejectUngroundedLevels,
} from './validation';
import type { AnalysisResult, CandidateLevel, TradeDeskPlan } from './types';

function validResult(overrides: Partial<AnalysisResult> = {}): unknown {
  return {
    resultSchemaVersion: 1,
    analysisId: 'a1',
    context: {
      symbol: 'SPY',
      timeframe: '5m',
      snapshotSequence: 1,
      positionVersion: 0,
    },
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

describe('parseAnalysisResult', () => {
  it('accepts a well-formed result', () => {
    expect(parseAnalysisResult(validResult())).not.toBeNull();
  });

  it('rejects a missing resultSchemaVersion', () => {
    const raw = validResult() as Record<string, unknown>;
    delete raw.resultSchemaVersion;
    expect(parseAnalysisResult(raw)).toBeNull();
  });

  it('rejects confidence outside [0, 1]', () => {
    expect(parseAnalysisResult(validResult({ confidence: 1.5 }))).toBeNull();
  });

  it('rejects an unknown recommendation value', () => {
    expect(
      parseAnalysisResult(validResult({ recommendation: 'yolo' as unknown as never })),
    ).toBeNull();
  });

  it('rejects NaN/Infinity inside a grounded level price', () => {
    const raw = validResult({
      levels: { support: { levelId: 'lvl-1', price: Number.POSITIVE_INFINITY } },
    });
    expect(parseAnalysisResult(raw)).toBeNull();
  });

  it('rejects malformed JSON-shaped garbage without throwing', () => {
    expect(() => parseAnalysisResult('not an object')).not.toThrow();
    expect(parseAnalysisResult('not an object')).toBeNull();
  });
});

describe('rejectUngroundedLevels', () => {
  const supplied: CandidateLevel[] = [
    {
      id: 'lvl-1',
      kind: 'support',
      role: 'support',
      price: 400,
      evidence: 'tested 3x',
      testCount: 3,
      recency: 'today',
      strength: 0.8,
      source: 'pivot',
    },
  ];

  it('keeps a level grounded in a supplied candidate', () => {
    const result = parseAnalysisResult(
      validResult({ levels: { support: { levelId: 'lvl-1', price: 400 } } }),
    )!;
    const cleaned = rejectUngroundedLevels(result, supplied);
    expect(cleaned.levels.support).toEqual({ levelId: 'lvl-1', price: 400 });
  });

  it('drops a generated numeric level with no matching candidate id', () => {
    const result = parseAnalysisResult(
      validResult({ levels: { support: { levelId: 'ghost-level', price: 401 } } }),
    )!;
    const cleaned = rejectUngroundedLevels(result, supplied);
    expect(cleaned.levels.support).toBeUndefined();
  });

  it('leaves an absent level absent', () => {
    const result = parseAnalysisResult(validResult())!;
    const cleaned = rejectUngroundedLevels(result, supplied);
    expect(cleaned.levels).toEqual({});
  });
});

function basePlan(overrides: Partial<TradeDeskPlan> = {}): TradeDeskPlan {
  return {
    action: 'wait',
    setupLifecycle: 'none',
    setupLabel: 'Bullish desk check',
    summary: 'Waiting for confirmation.',
    targets: { contract: [] },
    management: { holdConditions: [], scaleConditions: [], exitConditions: [] },
    ...overrides,
  };
}

const groundedPrice = {
  value: 1.85,
  priceDomain: 'contract-premium' as const,
  evidenceId: 'selected-contract',
  snapshotId: 's1',
};

const groundedCondition = {
  operator: 'below' as const,
  price: {
    value: 746.28,
    priceDomain: 'underlying' as const,
    evidenceId: 'vwap',
    snapshotId: 's1',
  },
};

describe('isTradeDeskActionSatisfied', () => {
  it('accepts enter with a grounded entry and invalidation', () => {
    const plan = basePlan({
      action: 'enter',
      entry: { preferredContractPrice: groundedPrice },
      invalidation: { underlying: groundedCondition },
    });
    expect(isTradeDeskActionSatisfied(plan, false)).toBe(true);
  });

  it('rejects enter with no entry data', () => {
    const plan = basePlan({ action: 'enter', invalidation: { underlying: groundedCondition } });
    expect(isTradeDeskActionSatisfied(plan, false)).toBe(false);
  });

  it('rejects enter with entry but no invalidation', () => {
    const plan = basePlan({
      action: 'enter',
      entry: { preferredContractPrice: groundedPrice },
    });
    expect(isTradeDeskActionSatisfied(plan, false)).toBe(false);
  });

  it('accepts hold with an open position and hold/exit conditions', () => {
    const plan = basePlan({
      action: 'hold',
      management: {
        holdConditions: ['Hold above VWAP'],
        scaleConditions: [],
        exitConditions: ['Exit on failed reclaim'],
      },
    });
    expect(isTradeDeskActionSatisfied(plan, true)).toBe(true);
  });

  it('rejects hold with no open position', () => {
    const plan = basePlan({
      action: 'hold',
      management: {
        holdConditions: ['Hold above VWAP'],
        scaleConditions: [],
        exitConditions: ['Exit on failed reclaim'],
      },
    });
    expect(isTradeDeskActionSatisfied(plan, false)).toBe(false);
  });

  it('rejects hold missing an exit condition', () => {
    const plan = basePlan({
      action: 'hold',
      management: { holdConditions: ['Hold above VWAP'], scaleConditions: [], exitConditions: [] },
    });
    expect(isTradeDeskActionSatisfied(plan, true)).toBe(false);
  });

  it('accepts scale with a direction and condition on an open position', () => {
    const plan = basePlan({
      action: 'scale',
      scaleAdvice: { direction: 'in', condition: 'Reclaim VWAP' },
    });
    expect(isTradeDeskActionSatisfied(plan, true)).toBe(true);
  });

  it('rejects scale with no direction', () => {
    const plan = basePlan({ action: 'scale' });
    expect(isTradeDeskActionSatisfied(plan, true)).toBe(false);
  });

  it('rejects scale with no open position', () => {
    const plan = basePlan({
      action: 'scale',
      scaleAdvice: { direction: 'in', condition: 'Reclaim VWAP' },
    });
    expect(isTradeDeskActionSatisfied(plan, false)).toBe(false);
  });

  it('accepts exit with an invalidation', () => {
    const plan = basePlan({ action: 'exit', invalidation: { underlying: groundedCondition } });
    expect(isTradeDeskActionSatisfied(plan, true)).toBe(true);
  });

  it('accepts exit with an exit condition and no invalidation', () => {
    const plan = basePlan({
      action: 'exit',
      management: { holdConditions: [], scaleConditions: [], exitConditions: ['Cut below VWAP'] },
    });
    expect(isTradeDeskActionSatisfied(plan, true)).toBe(true);
  });

  it('rejects exit with neither invalidation nor exit condition', () => {
    const plan = basePlan({ action: 'exit' });
    expect(isTradeDeskActionSatisfied(plan, true)).toBe(false);
  });

  it('rejects exit while flat, even with a valid invalidation', () => {
    const plan = basePlan({ action: 'exit', invalidation: { underlying: groundedCondition } });
    expect(isTradeDeskActionSatisfied(plan, false)).toBe(false);
  });

  it('accepts wait with a non-empty summary', () => {
    expect(isTradeDeskActionSatisfied(basePlan({ action: 'wait' }), false)).toBe(true);
  });

  it('rejects avoid with an empty summary and no warnings', () => {
    const plan = basePlan({ action: 'avoid', summary: '' });
    expect(isTradeDeskActionSatisfied(plan, false)).toBe(false);
  });

  it('accepts avoid with warnings even if summary is empty', () => {
    const plan = basePlan({ action: 'avoid', summary: '', warnings: ['Market closed'] });
    expect(isTradeDeskActionSatisfied(plan, false)).toBe(true);
  });
});

describe('hasValidSetupLifecycleLabel', () => {
  it('accepts setupLifecycle none regardless of label content', () => {
    const plan = basePlan({ setupLifecycle: 'none', setupLabel: 'anything' });
    expect(hasValidSetupLifecycleLabel(plan)).toBe(true);
  });

  it('accepts an active lifecycle with a real label', () => {
    const plan = basePlan({ setupLifecycle: 'extended', setupLabel: 'Bullish reversal' });
    expect(hasValidSetupLifecycleLabel(plan)).toBe(true);
  });

  it('rejects an active lifecycle with a blank label', () => {
    const plan = basePlan({ setupLifecycle: 'extended', setupLabel: '   ' });
    expect(hasValidSetupLifecycleLabel(plan)).toBe(false);
  });
});

describe('hasValidSetupLifecycleEvidence', () => {
  const withTargets = { targets: { contract: [{ role: 'first' as const, price: groundedPrice }] } };

  it('rejects triggered with no entry or invalidation data — the "Confirm and enter" with all dashes regression', () => {
    const plan = basePlan({
      action: 'wait',
      setupLifecycle: 'triggered',
      setupLabel: 'Bullish pull back',
      ...withTargets,
    });
    expect(hasValidSetupLifecycleEvidence(plan)).toBe(false);
  });

  it('rejects confirmed with no entry or invalidation data', () => {
    const plan = basePlan({ action: 'wait', setupLifecycle: 'confirmed', ...withTargets });
    expect(hasValidSetupLifecycleEvidence(plan)).toBe(false);
  });

  it('accepts triggered with real entry, invalidation, and targets', () => {
    const plan = basePlan({
      action: 'wait',
      setupLifecycle: 'triggered',
      entry: { preferredContractPrice: groundedPrice },
      invalidation: { underlying: groundedCondition },
      ...withTargets,
    });
    expect(hasValidSetupLifecycleEvidence(plan)).toBe(true);
  });

  it('rejects developing with no invalidation/targets — a trader needs to know where the thesis breaks before any trigger fires', () => {
    const plan = basePlan({ setupLifecycle: 'developing', setupLabel: 'Bullish pullback' });
    expect(hasValidSetupLifecycleEvidence(plan)).toBe(false);
  });

  it('accepts developing with invalidation and targets but no entry — entry alone still waits for a real trigger', () => {
    const plan = basePlan({
      setupLifecycle: 'developing',
      setupLabel: 'Bullish pullback',
      invalidation: { underlying: groundedCondition },
      ...withTargets,
    });
    expect(hasValidSetupLifecycleEvidence(plan)).toBe(true);
  });

  it('requires invalidation and targets for extended and completed too — the entry window closed, the setup itself did not stop being real', () => {
    for (const lifecycle of ['extended', 'completed'] as const) {
      const bare = basePlan({
        action: 'wait',
        setupLifecycle: lifecycle,
        setupLabel: 'Bullish reversal',
      });
      expect(hasValidSetupLifecycleEvidence(bare)).toBe(false);

      const evidenced = basePlan({
        action: 'wait',
        setupLifecycle: lifecycle,
        setupLabel: 'Bullish reversal',
        invalidation: { underlying: groundedCondition },
        ...withTargets,
      });
      expect(hasValidSetupLifecycleEvidence(evidenced)).toBe(true);
    }
  });

  it('does not require entry, invalidation, or targets for none or invalidated', () => {
    expect(hasValidSetupLifecycleEvidence(basePlan({ setupLifecycle: 'none' }))).toBe(true);
    expect(hasValidSetupLifecycleEvidence(basePlan({ setupLifecycle: 'invalidated' }))).toBe(true);
  });
});

describe('enforceTradeDeskInvariants', () => {
  it('leaves a result without a tradeDeskPlan unchanged', () => {
    const result = parseAnalysisResult(validResult())!;
    expect(enforceTradeDeskInvariants(result, false)).toBe(result);
  });

  it('leaves a satisfied plan unchanged', () => {
    const plan = basePlan({
      action: 'enter',
      entry: { preferredContractPrice: groundedPrice },
      invalidation: { underlying: groundedCondition },
    });
    const result = parseAnalysisResult(validResult({ tradeDeskPlan: plan }))!;
    const output = enforceTradeDeskInvariants(result, false);
    expect(output.tradeDeskPlan?.action).toBe('enter');
  });

  it('downgrades an enter with no entry data to wait, with a warning', () => {
    const plan = basePlan({ action: 'enter', invalidation: { underlying: groundedCondition } });
    const result = parseAnalysisResult(validResult({ tradeDeskPlan: plan }))!;
    const output = enforceTradeDeskInvariants(result, false);
    expect(output.tradeDeskPlan?.action).toBe('wait');
    expect(output.tradeDeskPlan?.warnings?.some((w) => w.includes('enter'))).toBe(true);
  });

  it('downgrades the legacy recommendation field alongside the plan action, so a renderer reading either field stays consistent', () => {
    const plan = basePlan({
      action: 'hold',
      management: { holdConditions: [], scaleConditions: [], exitConditions: [] },
    });
    const result = parseAnalysisResult(
      validResult({ recommendation: 'hold', tradeDeskPlan: plan }),
    )!;
    const output = enforceTradeDeskInvariants(result, false);
    expect(output.tradeDeskPlan?.action).toBe('wait');
    expect(output.recommendation).toBe('wait');
  });

  it('normalizes setupLabel to "No confirmed setup" when a downgraded plan carries no entry data', () => {
    // The reported bug: SETUP "Bullish pullback" next to ENTRY/INVALIDATION/
    // TARGETS all "—" — a named setup with nothing behind it.
    const plan = basePlan({
      action: 'enter',
      setupLabel: 'Bullish pullback',
      invalidation: { underlying: groundedCondition },
    });
    const result = parseAnalysisResult(validResult({ tradeDeskPlan: plan }))!;
    const output = enforceTradeDeskInvariants(result, false);
    expect(output.tradeDeskPlan?.action).toBe('wait');
    expect(output.tradeDeskPlan?.setupLabel).toBe('No confirmed setup');
  });

  it('normalizes an already-wait plan carrying a named setup label but no entry data', () => {
    const plan = basePlan({ action: 'wait', setupLabel: 'Bullish pullback' });
    const result = parseAnalysisResult(validResult({ tradeDeskPlan: plan }))!;
    const output = enforceTradeDeskInvariants(result, false);
    expect(output.tradeDeskPlan?.setupLabel).toBe('No confirmed setup');
  });

  it('leaves a wait plan with real entry data alone (a developing, not-yet-triggered setup)', () => {
    const plan = basePlan({
      action: 'wait',
      setupLabel: 'Bullish reclaim',
      entry: {
        underlying: {
          low: 744.5,
          high: 744.9,
          priceDomain: 'underlying',
          evidenceId: 'e1',
          snapshotId: 's1',
        },
      },
    });
    const result = parseAnalysisResult(validResult({ tradeDeskPlan: plan }))!;
    const output = enforceTradeDeskInvariants(result, false);
    expect(output.tradeDeskPlan?.setupLabel).toBe('Bullish reclaim');
  });

  it('strips contract-premium guidance when the options quote was invalid, keeping underlying guidance', () => {
    const plan = basePlan({
      action: 'enter',
      entry: {
        underlying: {
          low: 744.5,
          high: 744.9,
          priceDomain: 'underlying',
          evidenceId: 'e1',
          snapshotId: 's1',
        },
        preferredContractPrice: groundedPrice,
      },
      invalidation: { underlying: groundedCondition },
      targets: { contract: [{ role: 'first', price: groundedPrice }] },
    });
    const result = parseAnalysisResult(validResult({ tradeDeskPlan: plan }))!;
    const output = enforceTradeDeskInvariants(result, false, false);
    expect(output.tradeDeskPlan?.entry?.preferredContractPrice).toBeUndefined();
    expect(output.tradeDeskPlan?.entry?.underlying).toBeDefined();
    expect(output.tradeDeskPlan?.targets.contract).toHaveLength(0);
    expect(output.tradeDeskPlan?.warnings?.some((w) => w.includes('Contract-specific'))).toBe(true);
    // Still enter (underlying entry + invalidation still satisfy the action).
    expect(output.tradeDeskPlan?.action).toBe('enter');
  });

  it('leaves contract-premium guidance intact when the options quote was valid', () => {
    const plan = basePlan({
      action: 'enter',
      entry: { preferredContractPrice: groundedPrice },
      invalidation: { underlying: groundedCondition },
    });
    const result = parseAnalysisResult(validResult({ tradeDeskPlan: plan }))!;
    const output = enforceTradeDeskInvariants(result, false, true);
    expect(output.tradeDeskPlan?.entry?.preferredContractPrice).toEqual(groundedPrice);
  });

  it('does NOT clobber a real setupLabel on a wait plan with setupLifecycle extended and no fresh entry — the reported regression', () => {
    const plan = basePlan({
      action: 'wait',
      setupLifecycle: 'extended',
      setupLabel: 'Bullish reversal',
      // No entry — the setup already triggered and ran; there is no fresh
      // entry to offer right now. Invalidation/targets are still required
      // (hasValidSetupLifecycleEvidence) since the setup itself is real and
      // a trader still needs to know where it's headed / what kills it.
      invalidation: { underlying: groundedCondition },
      targets: { contract: [{ role: 'first', price: groundedPrice }] },
    });
    const result = parseAnalysisResult(validResult({ tradeDeskPlan: plan }))!;
    const output = enforceTradeDeskInvariants(result, false);
    expect(output.tradeDeskPlan?.action).toBe('wait');
    expect(output.tradeDeskPlan?.setupLifecycle).toBe('extended');
    expect(output.tradeDeskPlan?.setupLabel).toBe('Bullish reversal');
  });

  it('downgrades setupLifecycle to none when triggered/confirmed has no supporting entry data — a second reported regression', () => {
    // Exactly the screenshot: SETUP "Bullish pull back" / TRIGGERED with
    // ENTRY/INVALIDATION/TARGETS/CONTRACT all dashed, EXECUTION "Confirm
    // and enter" — a lifecycle claim asking the trader to act on nothing.
    const plan = basePlan({
      action: 'wait',
      setupLifecycle: 'triggered',
      setupLabel: 'Bullish pull back',
    });
    const result = parseAnalysisResult(validResult({ tradeDeskPlan: plan }))!;
    const output = enforceTradeDeskInvariants(result, false);
    expect(output.tradeDeskPlan?.setupLifecycle).toBe('none');
    expect(output.tradeDeskPlan?.setupLabel).toBe('No confirmed setup');
  });

  it('still clobbers setupLabel on a genuinely setup-less wait plan (setupLifecycle none)', () => {
    const plan = basePlan({
      action: 'wait',
      setupLifecycle: 'none',
      setupLabel: 'Bullish desk check',
    });
    const result = parseAnalysisResult(validResult({ tradeDeskPlan: plan }))!;
    const output = enforceTradeDeskInvariants(result, false);
    expect(output.tradeDeskPlan?.setupLabel).toBe('No confirmed setup');
  });

  it('rejects a plan whose setupLifecycle is active but setupLabel is empty at the structural-schema level', () => {
    // setupLabel: z.string().min(1) already prevents an empty label from
    // reaching enforceTradeDeskInvariants at all — hasValidSetupLifecycleLabel
    // is defense-in-depth should that constraint ever loosen, but the
    // primary enforcement point is parseAnalysisResult itself.
    const plan = basePlan({ action: 'wait', setupLifecycle: 'extended', setupLabel: '' });
    const result = parseAnalysisResult(validResult({ tradeDeskPlan: plan }));
    expect(result).toBeNull();
  });
});
