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
  candlesFreshAsOf: string;
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

export type AIAvailability =
  | { state: 'unavailable'; reason: string }
  | { state: 'incompatible'; reason: string }
  | { state: 'degraded'; reason: string }
  | { state: 'ready' };

export interface AnalyzeRequest {
  snapshot: AnalysisSnapshot;
}

export type AnalysisEvent =
  | { kind: 'accepted'; requestId: string }
  | { kind: 'progress'; requestId: string }
  | { kind: 'completed'; requestId: string; result: AnalysisResult }
  | { kind: 'cancelled'; requestId: string }
  | { kind: 'failed'; requestId: string; errorCode: string; message: string };
