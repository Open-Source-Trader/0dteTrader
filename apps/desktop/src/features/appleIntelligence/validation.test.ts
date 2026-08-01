import { describe, expect, it } from 'vitest';
import {
  enforceTradeDeskInvariants,
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
});
