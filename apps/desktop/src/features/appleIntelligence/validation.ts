// Runtime validation for structured model output before it is promoted to
// UI state. Canonical spec: docs/apple-intelligence/data-contracts.md
// (grounding rule) and architecture-enforcement.md (runtime validation is
// required at every trust boundary — TypeScript types alone do not qualify).
import { z } from 'zod';
import type { AnalysisResult, CandidateLevel, Recommendation, TradeDeskPlan } from './types';

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
  setupLifecycle: z.enum([
    'none',
    'developing',
    'confirmed',
    'triggered',
    'extended',
    'completed',
    'invalidated',
  ]),
  setupId: z.string().min(1).optional(),
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
      return Boolean(
        hasOpenPosition && (plan.invalidation || plan.management.exitConditions.length > 0),
      );
    case 'wait':
    case 'avoid':
      return plan.summary.trim().length > 0 || (plan.warnings?.length ?? 0) > 0;
  }
}

/** Canonical label for a `wait`/`avoid` plan carrying no entry data — used
 * both to normalize a downgraded plan and to recognize an already-`wait`
 * plan that needs the same treatment (see `normalizeWaitSetupLabel`). */
export const NO_CONFIRMED_SETUP_LABEL = 'No confirmed setup';

function hasEntryData(plan: TradeDeskPlan): boolean {
  return Boolean(
    plan.entry?.underlying || plan.entry?.contract || plan.entry?.preferredContractPrice,
  );
}

/**
 * Reverse invariant: a `wait`/`avoid` plan must not carry a named, specific
 * `setupLabel` (e.g. "Bullish pullback") while withholding all the data that
 * would define that setup AND while no real setup is being tracked at all
 * (`setupLifecycle === 'none'`). Unlike `isTradeDeskActionSatisfied` (which
 * checks "does this action require presence"), this catches the opposite
 * defect — a label implying a real setup with nothing behind it — which
 * produced the exact contradiction this function exists to prevent: SETUP
 * "Bullish pullback" next to ENTRY/INVALIDATION/TARGETS all "—".
 *
 * Gated on `setupLifecycle` (not just `hasEntryData`) because a plan can
 * legitimately be `action: wait` with no *current* entry data while still
 * describing a real, persisting setup — e.g. `setupLifecycle: extended`,
 * where a setup triggered and ran but is now too far along to chase. That
 * case must keep its real label ("Bullish reversal") and get lifecycle-
 * appropriate execution guidance ("Do not chase"), not be clobbered into the
 * generic no-setup string alongside a genuinely setup-less wait. Only
 * applies to wait/avoid; enter/hold/scale/exit already require their own
 * supporting data via `isTradeDeskActionSatisfied`.
 */
function normalizeWaitSetupLabel(plan: TradeDeskPlan): TradeDeskPlan {
  if (plan.action !== 'wait' && plan.action !== 'avoid') return plan;
  if (plan.setupLifecycle !== 'none') return plan;
  if (hasEntryData(plan)) return plan;
  if (plan.setupLabel === NO_CONFIRMED_SETUP_LABEL) return plan;
  return { ...plan, setupLabel: NO_CONFIRMED_SETUP_LABEL };
}

/**
 * Companion invariant to `normalizeWaitSetupLabel`: a plan claiming an
 * active lifecycle (anything but `none`) must carry a real setupLabel — the
 * mirror-image defect (a lifecycle claim with no description) is just as
 * broken as a label with no lifecycle behind it. Checked as part of
 * `isTradeDeskActionSatisfied`'s wait/avoid branch would conflate two
 * different concerns, so this is a separate, composable check the caller
 * ANDs in.
 */
export function hasValidSetupLifecycleLabel(plan: TradeDeskPlan): boolean {
  if (plan.setupLifecycle === 'none') return true;
  return plan.setupLabel.trim().length > 0;
}

/** Lifecycle states where an entry is still live or imminent — these claim
 * a real trigger/confirmation and must carry the data that defines it, the
 * same way `action: 'enter'` does. `extended`/`completed`/`invalidated`
 * deliberately do NOT require entry data: those describe a setup whose
 * entry window has already passed, where the whole point is that there is
 * no current entry to offer (see `normalizeWaitSetupLabel`'s doc comment). */
const LIFECYCLES_REQUIRING_ENTRY_DATA = new Set<TradeDeskPlan['setupLifecycle']>([
  'confirmed',
  'triggered',
]);

/** Lifecycle states where a setup is real enough to name but doesn't
 * necessarily have a live entry yet — these must still describe where the
 * thesis breaks and where it's headed. A trader watching a developing
 * pullback needs the invalidation level and targets NOW, before any trigger
 * fires — only the entry price/zone itself legitimately waits (see
 * `LIFECYCLES_REQUIRING_ENTRY_DATA`). `none` has no setup to describe;
 * `invalidated` describes why the setup died, not where it's headed. */
const LIFECYCLES_REQUIRING_INVALIDATION_AND_TARGETS = new Set<TradeDeskPlan['setupLifecycle']>([
  'developing',
  'confirmed',
  'triggered',
  'extended',
  'completed',
]);

function hasTargets(plan: TradeDeskPlan): boolean {
  return plan.targets.contract.length > 0 || (plan.targets.underlying?.length ?? 0) > 0;
}

/**
 * Companion invariant: `setupLifecycle: 'triggered'` (or 'confirmed') means
 * the entry condition either just fired or is concretely defined — a plan
 * claiming either state with no entry/invalidation data is the same defect
 * as `action: 'enter'` with no entry data, just discovered one lifecycle
 * value later. Without this check, a `wait` action (which itself has no
 * entry-data requirement) could carry `setupLifecycle: 'triggered'` and
 * render "SETUP: Bullish pullback / TRIGGERED" next to
 * "EXECUTION: Confirm and enter" with every price field dashed — nothing
 * to confirm.
 *
 * Separately, ANY named setup (`developing` and up) must carry invalidation
 * and targets — the reported regression was a `developing` "Bullish
 * pullback" with INVALIDATION/TARGETS both "—" despite the chart showing an
 * obvious pullback low (invalidation) and call wall (target) the model had
 * already cited as evidence for the setup itself.
 */
export function hasValidSetupLifecycleEvidence(plan: TradeDeskPlan): boolean {
  if (LIFECYCLES_REQUIRING_ENTRY_DATA.has(plan.setupLifecycle)) {
    if (!hasEntryData(plan) || !plan.invalidation) return false;
  }
  if (LIFECYCLES_REQUIRING_INVALIDATION_AND_TARGETS.has(plan.setupLifecycle)) {
    if (!plan.invalidation || !hasTargets(plan)) return false;
  }
  return true;
}

/**
 * Contract-premium guidance (entry.contract, entry.preferredContractPrice,
 * invalidation.contract, targets.contract) is only trustworthy when the
 * snapshot's own selected-contract quote passed the pre-model eligibility
 * gate (snapshotValidation.ts) for this request — a model has no way to
 * know its own reference quote was corrupt, so a bad options quote must
 * strip contract-domain guidance here rather than let it render as if
 * grounded. Underlying-domain fields (entry.underlying, invalidation.
 * underlying, targets.underlying) are unaffected.
 */
function stripContractGuidanceIfUnsupported(
  plan: TradeDeskPlan,
  hasValidOptionsQuote: boolean,
): TradeDeskPlan {
  if (hasValidOptionsQuote) return plan;
  const hadContractGuidance =
    plan.entry?.contract ||
    plan.entry?.preferredContractPrice ||
    plan.invalidation?.contract ||
    plan.targets.contract.length > 0;
  if (!hadContractGuidance) return plan;
  return {
    ...plan,
    entry: plan.entry
      ? {
          underlying: plan.entry.underlying,
          contract: undefined,
          preferredContractPrice: undefined,
        }
      : plan.entry,
    invalidation: plan.invalidation
      ? { underlying: plan.invalidation.underlying, contract: undefined }
      : plan.invalidation,
    targets: { ...plan.targets, contract: [] },
    warnings: [
      ...(plan.warnings ?? []),
      'Contract-specific guidance omitted: selected contract quote was invalid.',
    ],
  };
}

/**
 * Enforces the decision contract on a grounded result: a `tradeDeskPlan`
 * whose action invariant isn't satisfied is downgraded to `wait` with an
 * appended warning, mirroring the Swift sidecar's existing
 * downgradedToObservationOnly pattern (AnalysisRunner.swift) — the plan is
 * never dropped outright, since summary/warnings/setupLabel are still
 * useful context even when the numeric plan can't be trusted as its
 * original action. Also strips contract-premium guidance not supported by a
 * valid options quote, and normalizes a wait/avoid plan's setupLabel when it
 * names a setup with no data behind it.
 */
export function enforceTradeDeskInvariants(
  result: AnalysisResult,
  hasOpenPosition: boolean,
  hasValidOptionsQuote = true,
): AnalysisResult {
  const originalPlan = result.tradeDeskPlan;
  if (!originalPlan) return result;

  const strippedPlan = stripContractGuidanceIfUnsupported(originalPlan, hasValidOptionsQuote);

  const lifecycleLabelValid = hasValidSetupLifecycleLabel(strippedPlan);
  const lifecycleEvidenceValid = hasValidSetupLifecycleEvidence(strippedPlan);
  const lifecycleClaimValid = lifecycleLabelValid && lifecycleEvidenceValid;
  if (!isTradeDeskActionSatisfied(strippedPlan, hasOpenPosition) || !lifecycleClaimValid) {
    const downgraded: TradeDeskPlan = {
      ...strippedPlan,
      action: 'wait',
      // An unlabeled lifecycle claim, or a triggered/confirmed claim with
      // no entry data behind it, isn't real evidence to preserve — reset it
      // to 'none' rather than let normalizeWaitSetupLabel's setupLifecycle
      // gate (which now protects a validly-labeled active setup from being
      // clobbered) accidentally protect this unsupported one too.
      setupLifecycle: lifecycleClaimValid ? strippedPlan.setupLifecycle : 'none',
      warnings: [
        ...(strippedPlan.warnings ?? []),
        `Downgraded from "${strippedPlan.action}": required data for that action was missing.`,
      ],
    };
    return {
      ...result,
      // The legacy top-level `recommendation` field must track the plan's
      // downgraded action — every renderer that still reads `recommendation`
      // instead of `tradeDeskPlan.action` (e.g. AIAnalysisButton) would
      // otherwise show the original, un-downgraded action next to a plan
      // whose own warnings say it was downgraded away from that action.
      recommendation: 'wait' satisfies Recommendation,
      tradeDeskPlan: normalizeWaitSetupLabel(downgraded),
    };
  }

  const normalizedPlan = normalizeWaitSetupLabel(strippedPlan);
  if (normalizedPlan === originalPlan) return result;
  return { ...result, tradeDeskPlan: normalizedPlan };
}
