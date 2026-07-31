import { describe, expect, it } from 'vitest';
import { parseAnalysisResult, rejectUngroundedLevels } from './validation';
import type { AnalysisResult, CandidateLevel } from './types';

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
