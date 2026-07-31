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
}
```

## Grounding rule

Every recommended numeric level must reference:

- a supplied candidate-level identifier; or
- a deterministic strategy-rule identifier with supplied operands.

A generated number without grounding is invalid. Reject the structured result or downgrade it to observation-only output. Never silently accept an ungrounded level.

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
