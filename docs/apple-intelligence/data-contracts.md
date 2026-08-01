# Analysis Data Contracts

This file owns normalized snapshot and structured-result semantics. Wire framing belongs in [`protocol.md`](protocol.md).

## Snapshot principles

The snapshot is an immutable evidence package. It separates:

- authoritative facts;
- deterministic candidate levels;
- strategy constraints;
- data quality and freshness;
- explicit omissions;
- analysis trigger identity.

The model interprets supplied evidence. It does not reverse-engineer the chart or invent management policy.

## Representative snapshot

```typescript
interface AnalysisSnapshot {
  snapshotSchemaVersion: 1;
  identity: {
    snapshotId: string;
    capturedAt: string;
    symbol: string;
    timeframe: string;
    candleCloseTime?: string;
    snapshotSequence: number;
    positionVersion: number;
    strategyPolicyVersion?: number;
  };
  trigger: {
    kind: 'manual' | 'candle-close' | 'position-change' | 'material-change';
    priority: 'position-critical' | 'manual' | 'candle-close' | 'background';
    reason: string;
  };
  market: MarketFacts;
  candles: CandleSeries;
  indicators: IndicatorFacts;
  levels: CandidateLevel[];
  options?: OptionsFacts;
  position?: PositionFacts;
  strategyPolicy?: StrategyPolicy;
  quality: DataQuality;
  omissions: Omission[];
}
```

The exact field model should follow existing repository conventions and current PR-derived structures. Preserve the semantics below.

## Required semantics

| Concern        | Required handling                                                                            |
| -------------- | -------------------------------------------------------------------------------------------- |
| Provenance     | Important facts identify their source or calculation version when ambiguity exists           |
| Freshness      | Include capture and source timestamps; state when chain/options lag candle data              |
| Units          | Encode units or semantic field names for every ambiguous number                              |
| Price domains  | Distinguish underlying price, option premium, strike, contract multiplier, and P&L           |
| Levels         | Include kind, role, price, evidence, test count, recency, strength, and source               |
| Candles        | Preserve timestamps, session gaps, and non-contiguous ranges explicitly                      |
| Compression    | Prefer base anchoring or directly usable normalized values over cumulative arithmetic chains |
| Omissions      | Record omitted category, reason, retained count, and original count                          |
| Policy         | Supply management rules as constraints rather than allowing the model to invent them         |
| Sensitive data | Exclude credentials, account IDs, names, and unrelated portfolio state                       |

## Representative result

```typescript
interface AnalysisResult {
  resultSchemaVersion: 1;
  analysisId: string;
  context: AnalysisContextIdentity;
  generatedAt: string;
  recommendation: 'wait' | 'enter' | 'hold' | 'trim' | 'exit' | 'avoid';
  setupState: 'none' | 'forming' | 'confirmed' | 'extended' | 'invalidated';
  bias: 'bullish' | 'bearish' | 'neutral' | 'mixed';
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
```

`tradeDeskPlan` is the structured decision plan the Trade Desk panel renders (entry, invalidation, targets, management). It is optional on the wire: generation may omit it, and it is always omitted when the task was downgraded to observation-only. When present, every price-bearing field has already passed grounding (see below) before being placed on the wire — the model itself never emits `evidenceId`/`snapshotId`, only a `levelId` (underlying prices) or a plausible number (contract-premium prices); the runner attaches grounding metadata after validating.

```typescript
interface TradeDeskPlan {
  action: 'wait' | 'enter' | 'hold' | 'scale' | 'exit' | 'avoid';
  scaleAdvice?: { direction: 'in' | 'out'; quantity?: number; condition: string };
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
  targets: { contract: TradeDeskTarget[]; underlying?: TradeDeskTarget[] };
  management: {
    holdConditions: string[];
    scaleConditions: string[];
    exitConditions: string[];
  };
  warnings?: string[];
  confidence?: 'low' | 'medium' | 'high';
}
```

### Decision invariants

A `tradeDeskPlan.action` is only valid when its required fields are present. A plan violating its action's invariant is downgraded to `wait` with an appended warning rather than dropped outright — see [`lifecycle-and-concurrency.md`](lifecycle-and-concurrency.md).

| Action  | Required                                                                                   |
| ------- | ------------------------------------------------------------------------------------------ |
| `enter` | At least one grounded `entry` price/zone, and `invalidation` present                       |
| `hold`  | An open position, at least one `holdConditions` entry, at least one `exitConditions` entry |
| `scale` | `scaleAdvice` with a `direction` (`in`/`out`) and a `condition`                            |
| `exit`  | `invalidation` present, or at least one `exitConditions` entry                             |
| `wait`  | A non-empty `summary` explaining what's missing                                            |
| `avoid` | A non-empty `summary`/`warnings` stating the concrete reason                               |

## Grounding rule

Every recommended numeric level must reference:

- a supplied candidate-level identifier; or
- a deterministic strategy-rule identifier with supplied operands.

A generated number without grounding is invalid. Reject the structured result or downgrade it to observation-only output. Never silently accept an ungrounded level.

`tradeDeskPlan` prices ground the same way, with one addition: contract-premium prices have no candidate-level identifier to match, so they are grounded against the supplied selected contract's own bid/ask/last reference price instead (rejected if no contract was supplied, or if the price falls far outside a plausible multiple of that reference).

## Confidence rule

Model confidence is not a calibrated probability. The UI must present it as model-reported interpretive confidence and display material omissions, stale inputs, and assumptions nearby.

## Identity and staleness

`AnalysisContextIdentity` must contain enough immutable state to prevent stale promotion, including:

- symbol;
- timeframe;
- snapshot sequence;
- candle close time when applicable;
- position version;
- strategy-policy version when applicable.
