// Runtime validation for structured model output before it is promoted to
// UI state. Canonical spec: docs/apple-intelligence/data-contracts.md
// (grounding rule) and architecture-enforcement.md (runtime validation is
// required at every trust boundary — TypeScript types alone do not qualify).
import { z } from 'zod';
import type { AnalysisResult, CandidateLevel } from './types';

const groundedLevelRefSchema = z.object({
  levelId: z.string().min(1),
  price: z.number().finite(),
});

const evidenceReferenceSchema = z.object({
  code: z.string().min(1),
  detail: z.string(),
});

const omissionSchema = z.object({
  code: z.string().min(1),
  category: z.string().min(1),
  reason: z.enum(['budget', 'unavailable', 'stale', 'unsupported', 'not-applicable']),
  originalCount: z.number().int().nonnegative().optional(),
  retainedCount: z.number().int().nonnegative().optional(),
  material: z.boolean(),
});

export const analysisResultSchema = z.object({
  resultSchemaVersion: z.literal(1),
  analysisId: z.string().min(1),
  context: z.object({
    symbol: z.string().min(1),
    timeframe: z.string().min(1),
    snapshotSequence: z.number().int().nonnegative(),
    candleCloseTime: z.string().optional(),
    positionVersion: z.number().int().nonnegative(),
    strategyPolicyVersion: z.number().int().nonnegative().optional(),
    selectedContractSymbol: z.string().optional(),
  }),
  generatedAt: z.string().datetime({ offset: true }),
  recommendation: z.enum(['wait', 'enter', 'hold', 'trim', 'exit', 'avoid']),
  setupState: z.enum(['none', 'forming', 'confirmed', 'extended', 'invalidated']),
  bias: z.enum(['bullish', 'bearish', 'neutral', 'mixed']),
  levels: z.object({
    support: groundedLevelRefSchema.optional(),
    resistance: groundedLevelRefSchema.optional(),
    holdAbove: groundedLevelRefSchema.optional(),
    cutBelow: groundedLevelRefSchema.optional(),
    trimNear: groundedLevelRefSchema.optional(),
  }),
  confidence: z.number().min(0).max(1),
  reasons: z.array(evidenceReferenceSchema),
  warnings: z.array(z.string()),
  assumptions: z.array(z.string()),
  observedOmissions: z.array(omissionSchema),
  summary: z.string(),
});

/**
 * Parses and structurally validates a candidate AnalysisResult. Does not
 * check grounding — see `rejectUngroundedLevels`, which needs the snapshot's
 * candidate-level set and is therefore a separate step.
 */
export function parseAnalysisResult(raw: unknown): AnalysisResult | null {
  const result = analysisResultSchema.safeParse(raw);
  return result.success ? (result.data as AnalysisResult) : null;
}

/**
 * Grounding rule (data-contracts.md): every recommended numeric level must
 * reference a supplied candidate-level identifier. A level whose `levelId`
 * does not match a candidate level in the snapshot is ungrounded and must be
 * dropped rather than silently trusted.
 */
export function rejectUngroundedLevels(
  result: AnalysisResult,
  supplied: CandidateLevel[],
): AnalysisResult {
  const knownIds = new Set(supplied.map((level) => level.id));
  const filteredEntries = Object.entries(result.levels).filter(
    ([, ref]) => ref === undefined || knownIds.has(ref.levelId),
  );
  return { ...result, levels: Object.fromEntries(filteredEntries) };
}
