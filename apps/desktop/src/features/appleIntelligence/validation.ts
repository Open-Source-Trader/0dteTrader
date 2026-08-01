// Runtime validation for structured model output before it is promoted to
// UI state. Canonical spec: docs/apple-intelligence/data-contracts.md
// (grounding rule) and architecture-enforcement.md (runtime validation is
// required at every trust boundary — TypeScript types alone do not qualify).
import { z } from 'zod';
import type { AnalysisResult, CandidateLevel, TradeDeskPlan } from './types';

const groundedLevelRefSchema = z.object({
  levelId: z.string().min(1),
  price: z.number().finite(),
});

const evidenceReferenceSchema = z.object({
  code: z.string().min(1),
  detail: z.string(),
});

const groundedPriceSchema = z.object({
  value: z.number().finite(),
  priceDomain: z.enum(['underlying', 'contract-premium']),
  evidenceId: z.string().min(1),
  snapshotId: z.string().min(1),
  deterministicRuleId: z.string().min(1).optional(),
  levelId: z.string().min(1).optional(),
});

const groundedPriceZoneSchema = z.object({
  low: z.number().finite(),
  high: z.number().finite(),
  priceDomain: z.enum(['underlying', 'contract-premium']),
  evidenceId: z.string().min(1),
  snapshotId: z.string().min(1),
  deterministicRuleId: z.string().min(1).optional(),
  levelId: z.string().min(1).optional(),
});

const groundedPriceConditionSchema = z.object({
  operator: z.enum(['above', 'below', 'at-or-above', 'at-or-below']),
  price: groundedPriceSchema,
});

const tradeDeskPlanSchema = z.object({
  action: z.enum(['wait', 'enter', 'hold', 'scale', 'exit', 'avoid']),
  scaleAdvice: z
    .object({
      direction: z.enum(['in', 'out']),
      quantity: z.number().int().positive().optional(),
      condition: z.string().min(1),
    })
    .optional(),
  setupLabel: z.string().min(1),
  summary: z.string().min(1),
  entry: z
    .object({
      underlying: groundedPriceZoneSchema.optional(),
      contract: groundedPriceZoneSchema.optional(),
      preferredContractPrice: groundedPriceSchema.optional(),
    })
    .optional(),
  invalidation: z
    .object({
      underlying: groundedPriceConditionSchema.optional(),
      contract: groundedPriceConditionSchema.optional(),
    })
    .optional(),
  targets: z.object({
    contract: z.array(
      z.object({
        role: z.enum(['first', 'runner', 'final']),
        price: groundedPriceSchema,
        condition: z.string().optional(),
      }),
    ),
    underlying: z
      .array(
        z.object({
          role: z.enum(['first', 'runner', 'final']),
          price: groundedPriceSchema,
          condition: z.string().optional(),
        }),
      )
      .optional(),
  }),
  management: z.object({
    holdConditions: z.array(z.string()),
    scaleConditions: z.array(z.string()),
    exitConditions: z.array(z.string()),
  }),
  warnings: z.array(z.string()).optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
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
    snapshotId: z.string().min(1).optional(),
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
  tradeDeskPlan: tradeDeskPlanSchema.optional(),
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

export function isTradeDeskPlanGrounded(
  result: AnalysisResult,
  supplied: CandidateLevel[],
): boolean {
  if (!result.tradeDeskPlan) return true;
  const knownIds = new Set(supplied.map((level) => level.id));
  const prices = [
    result.tradeDeskPlan.entry?.underlying,
    result.tradeDeskPlan.entry?.contract,
    result.tradeDeskPlan.entry?.preferredContractPrice,
    result.tradeDeskPlan.invalidation?.underlying?.price,
    result.tradeDeskPlan.invalidation?.contract?.price,
    ...result.tradeDeskPlan.targets.contract.map((target) => target.price),
    ...(result.tradeDeskPlan.targets.underlying ?? []).map((target) => target.price),
  ];
  return prices.every((price) => !price?.levelId || knownIds.has(price.levelId));
}

/**
 * Decision contract (data-contracts.md "Decision invariants"): a plan's
 * `action` is only valid when its required fields are present. This is a
 * different concern from `isTradeDeskPlanGrounded` above — that function
 * checks "if present, is it valid"; this one checks "does this action
 * require presence at all." A plan failing this check must be downgraded,
 * never presented as its original action with missing data.
 */
export function isTradeDeskActionSatisfied(plan: TradeDeskPlan, hasOpenPosition: boolean): boolean {
  switch (plan.action) {
    case 'enter':
      return Boolean(
        (plan.entry?.underlying || plan.entry?.contract || plan.entry?.preferredContractPrice) &&
        plan.invalidation,
      );
    case 'hold':
      return (
        hasOpenPosition &&
        plan.management.holdConditions.length > 0 &&
        plan.management.exitConditions.length > 0
      );
    case 'scale':
      return Boolean(
        hasOpenPosition &&
        plan.scaleAdvice &&
        (plan.scaleAdvice.direction === 'in' || plan.scaleAdvice.direction === 'out') &&
        plan.scaleAdvice.condition.trim().length > 0,
      );
    case 'exit':
      return Boolean(plan.invalidation || plan.management.exitConditions.length > 0);
    case 'wait':
    case 'avoid':
      return plan.summary.trim().length > 0 || (plan.warnings?.length ?? 0) > 0;
  }
}

/**
 * Enforces the decision contract on a grounded result: a `tradeDeskPlan`
 * whose action invariant isn't satisfied is downgraded to `wait` with an
 * appended warning, mirroring the Swift sidecar's existing
 * downgradedToObservationOnly pattern (AnalysisRunner.swift) — the plan is
 * never dropped outright, since summary/warnings/setupLabel are still
 * useful context even when the numeric plan can't be trusted as its
 * original action.
 */
export function enforceTradeDeskInvariants(
  result: AnalysisResult,
  hasOpenPosition: boolean,
): AnalysisResult {
  const plan = result.tradeDeskPlan;
  if (!plan || isTradeDeskActionSatisfied(plan, hasOpenPosition)) return result;

  return {
    ...result,
    tradeDeskPlan: {
      ...plan,
      action: 'wait',
      warnings: [
        ...(plan.warnings ?? []),
        `Downgraded from "${plan.action}": required data for that action was missing.`,
      ],
    },
  };
}
