// Analysis snapshot/result semantics. Canonical spec:
// docs/apple-intelligence/data-contracts.md — this file is a TypeScript
// implementation of that spec, not a second source of truth.

export interface Omission {
  code: string;
  category: string;
  reason: 'budget' | 'unavailable' | 'stale' | 'unsupported' | 'not-applicable';
  originalCount?: number;
  retainedCount?: number;
  material: boolean;
}

export type TriggerKind = 'manual' | 'candle-close' | 'position-change' | 'material-change';
export type TriggerPriority = 'position-critical' | 'manual' | 'candle-close' | 'background';

export interface CandidateLevel {
  id: string;
  kind: string;
  role: 'support' | 'resistance';
  price: number;
  evidence: string;
  testCount: number;
  recency: string;
  strength: number;
  source: string;
}

export interface DataQuality {
  capturedAt: string;
  /** `null` when there are zero candles — no candle data exists to be
   * "fresh as of" anything. */
  candlesFreshAsOf: string | null;
  optionsFreshAsOf?: string;
  isChainStale: boolean;
}

export interface AnalysisSnapshotIdentity {
  snapshotId: string;
  capturedAt: string;
  symbol: string;
  timeframe: string;
  candleCloseTime?: string;
  snapshotSequence: number;
  positionVersion: number;
  strategyPolicyVersion?: number;
  selectedContractSymbol?: string;
}

/** Prior-analysis setup context, attached by AnalysisStore (not the
 * snapshot builder, which has no access to persisted cross-call state)
 * immediately before submission — tells the model it is continuing an
 * analysis rather than starting from a blank slate. Absent when no live,
 * non-terminal setup is currently tracked for this instrument. */
export interface PriorSetupContext {
  setupId: string;
  direction: 'bullish' | 'bearish';
  label: string;
  lifecycle: SetupLifecycle;
  detectedAt: string;
  triggeredAt?: string;
  invalidationLevel?: number;
}

export interface AnalysisSnapshot {
  snapshotSchemaVersion: 1;
  identity: AnalysisSnapshotIdentity;
  trigger: {
    kind: TriggerKind;
    priority: TriggerPriority;
    reason: string;
  };
  market: Record<string, unknown>;
  candles: Record<string, unknown>;
  indicators: Record<string, unknown>;
  levels: CandidateLevel[];
  options?: Record<string, unknown>;
  position?: Record<string, unknown>;
  strategyPolicy?: Record<string, unknown>;
  priorSetup?: PriorSetupContext;
  quality: DataQuality;
  omissions: Omission[];
}

export type PriceDomain = 'underlying' | 'contract-premium';

export interface GroundedLevelReference {
  levelId: string;
  price: number;
}

export interface EvidenceReference {
  code: string;
  detail: string;
}

export interface GroundedPrice {
  value: number;
  priceDomain: PriceDomain;
  evidenceId: string;
  snapshotId: string;
  deterministicRuleId?: string;
  levelId?: string;
}

export interface GroundedPriceZone {
  low: number;
  high: number;
  priceDomain: PriceDomain;
  evidenceId: string;
  snapshotId: string;
  deterministicRuleId?: string;
  levelId?: string;
}

export interface GroundedPriceCondition {
  operator: 'above' | 'below' | 'at-or-above' | 'at-or-below';
  price: GroundedPrice;
}

export interface AnalysisContextIdentity {
  snapshotId?: string;
  symbol: string;
  timeframe: string;
  snapshotSequence: number;
  candleCloseTime?: string;
  positionVersion: number;
  strategyPolicyVersion?: number;
  selectedContractSymbol?: string;
}

export type Recommendation = 'wait' | 'enter' | 'hold' | 'trim' | 'exit' | 'avoid';
export type TradeDeskAction = 'wait' | 'enter' | 'hold' | 'scale' | 'exit' | 'avoid';
export type SetupState = 'none' | 'forming' | 'confirmed' | 'extended' | 'invalidated';
export type Bias = 'bullish' | 'bearish' | 'neutral' | 'mixed';

/**
 * Independent of `TradeDeskAction` — `action: 'wait'` does not imply
 * `setupLifecycle: 'none'`. A setup can trigger and then become too extended
 * to enter (`action: 'wait'`, `setupLifecycle: 'extended'`) without ever
 * having been invalidated; the label and evidence describing it must persist
 * across analyses rather than reset just because there is no fresh entry
 * right now. See setupLifecycleHysteresis.ts for the persistence layer that
 * tracks a setup's identity across calls and gates state transitions with
 * hysteresis, the same way actionHysteresis.ts already does for `action`.
 */
export type SetupLifecycle =
  'none' | 'developing' | 'confirmed' | 'triggered' | 'extended' | 'completed' | 'invalidated';

export interface ScaleAdvice {
  direction: 'in' | 'out';
  quantity?: number;
  condition: string;
}

export interface TradeDeskTarget {
  role: 'first' | 'runner' | 'final';
  price: GroundedPrice;
  condition?: string;
}

export interface TradeDeskPlan {
  action: TradeDeskAction;
  /** Where this setup stands, independent of `action` — see SetupLifecycle. */
  setupLifecycle: SetupLifecycle;
  /** Optional model-supplied identity for this setup, used defensively by
   * setupLifecycleHysteresis.ts to help recognize "still the same setup" —
   * the persistence layer does not require it and matches on direction +
   * forward-progressing lifecycle when absent or when the model doesn't
   * echo the id it was given in `AnalysisSnapshot.priorSetup`. */
  setupId?: string;
  scaleAdvice?: ScaleAdvice;
  setupLabel: string;
  summary: string;
  entry?: {
    underlying?: GroundedPriceZone;
    contract?: GroundedPriceZone;
    preferredContractPrice?: GroundedPrice;
  };
  invalidation?: {
    underlying?: GroundedPriceCondition;
    contract?: GroundedPriceCondition;
  };
  targets: {
    contract: TradeDeskTarget[];
    underlying?: TradeDeskTarget[];
  };
  management: {
    holdConditions: string[];
    scaleConditions: string[];
    exitConditions: string[];
  };
  warnings?: string[];
  confidence?: 'low' | 'medium' | 'high';
}

export interface AnalysisResult {
  resultSchemaVersion: 1;
  analysisId: string;
  context: AnalysisContextIdentity;
  generatedAt: string;
  recommendation: Recommendation;
  setupState: SetupState;
  bias: Bias;
  levels: {
    support?: GroundedLevelReference;
    resistance?: GroundedLevelReference;
    holdAbove?: GroundedLevelReference;
    cutBelow?: GroundedLevelReference;
    trimNear?: GroundedLevelReference;
  };
  confidence: number;
  reasons: EvidenceReference[];
  warnings: string[];
  assumptions: string[];
  observedOmissions: Omission[];
  summary: string;
  tradeDeskPlan?: TradeDeskPlan;
}

/** Presentation-layer session/freshness state (data-contracts.md
 * "MarketAnalysisState") — derived from connection/freshness state and the
 * current time, not asked of the model. `unavailable` takes priority over
 * `stale`, which takes priority over `market-closed`; see
 * marketSessionState.ts. */
export type MarketAnalysisState = 'live' | 'delayed' | 'market-closed' | 'stale' | 'unavailable';

export type AIAvailability =
  | { state: 'unavailable'; reason: string }
  | { state: 'incompatible'; reason: string }
  | { state: 'degraded'; reason: string }
  | { state: 'ready' };

export interface AnalyzeRequest {
  snapshot: AnalysisSnapshot;
}

/**
 * Deterministic pre-model gate (snapshotValidation.ts). A snapshot must pass
 * this check before it is ever sent to the model — no amount of downstream
 * result validation can recover from bad input, since the model has no way
 * to know a supplied quote or candle set is implausible rather than a real
 * (if unusual) market condition.
 */
export type AnalysisIneligibilityReason =
  | 'missing-underlying-quote'
  | 'invalid-underlying-quote'
  | 'missing-candles'
  | 'stale-candles'
  | 'invalid-candle-data'
  | 'invalid-options-analytics'
  | 'invalid-selected-contract-quote'
  | 'snapshot-mismatch'
  | 'insufficient-data';

/**
 * Every point past the pre-model eligibility gate where a completed or
 * in-flight request can fail to produce current guidance. Distinct from
 * `AnalysisIneligibilityReason` (rejected before the model was ever
 * invoked) — a discard means a request was submitted, and something after
 * that point (decode, schema, grounding, staleness, transport) rejected it.
 */
export type AnalysisDiscardCode =
  | 'bridge-unavailable'
  | 'request-failed'
  | 'runtime-failed'
  | 'invalid-result'
  | 'ungrounded-plan'
  | 'stale-context'
  | 'superseded';

/**
 * A structured record of the most recent request that did not produce
 * current guidance, kept alongside (not instead of) `latestResult` so a
 * trader-facing reason survives until it's genuinely no longer relevant —
 * see AnalysisStore's `lastDiscard` field and `isDiscardStillRelevant`.
 */
export interface AnalysisDiscard {
  code: AnalysisDiscardCode;
  message: string;
  requestId: string;
  fingerprint: string | null;
  symbol: string;
  timeframe: string;
  selectedContractSymbol?: string;
  positionVersion: number;
  occurredAt: string;
}

export type AnalysisEligibility =
  | { eligible: true; mode: MarketAnalysisState; snapshot: AnalysisSnapshot }
  | {
      eligible: false;
      reason: AnalysisIneligibilityReason;
      userMessage: string;
      diagnostics?: Record<string, unknown>;
    };

export type AnalysisEvent =
  | { kind: 'accepted'; requestId: string }
  | { kind: 'progress'; requestId: string }
  | { kind: 'completed'; requestId: string; result: AnalysisResult }
  | { kind: 'cancelled'; requestId: string }
  | { kind: 'failed'; requestId: string; errorCode: string; message: string };
