# Context and Prompt Budgeting

This file owns deterministic input prioritization, compaction, omission reporting, and model-session context policy.

## Ownership

The Apple Intelligence feature snapshot builder assigns semantic priority and supplies normalized facts. The Swift model adapter assembles the final model input and enforces the actual Foundation Models context budget.

Prompt assembly does not belong in React components or Electron IPC handlers.

## Priority order

| Priority | Data class                                                 | Policy                                                                               |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1        | Current position, risk constraints, strategy invalidation  | Never silently omit for trade-management analysis; fail closed or downgrade the task |
| 2        | Latest completed candles and current market structure      | Retain enough sequence to evaluate the setup; preserve timestamps and gaps           |
| 3        | Primary support/resistance, VWAP, walls, selected overlays | Retain strongest explicit candidates and provenance                                  |
| 4        | Options/chain facts relevant to selected contract          | Compact while preserving freshness, units, and semantic labels                       |
| 5        | Extended indicators and secondary overlays                 | Trim before core evidence unless required by the selected strategy                   |
| 6        | Dealer scenarios and descriptive context                   | Trim before core evidence unless the task explicitly requests scenario analysis      |

## Required behavior

- Budgeting must be deterministic and testable without invoking the model.
- Every budget-driven omission must be declared in the final model input.
- Return omission metadata with the result.
- A task requiring omitted position or risk data must fail closed or downgrade to observation-only analysis.
- Prefer names a small on-device model can interpret over marginal character savings.
- Do not use opaque compact keys unless a stable legend is included and tests prove the savings are material.
- Avoid cumulative candle deltas which require a long arithmetic reconstruction chain.
- Preserve candle timestamps and gaps.
- Prewarm stable instructions where supported, but do not treat prewarm as a latency guarantee.
- Compare prior and current compact state explicitly for “what changed” analysis.

## Omission model

```typescript
interface Omission {
  code: string;
  category: string;
  reason: 'budget' | 'unavailable' | 'stale' | 'unsupported' | 'not-applicable';
  originalCount?: number;
  retainedCount?: number;
  material: boolean;
}
```

The model instruction must state material omissions plainly. The UI must expose omissions which could affect advice.

## Session policy

Use fresh short-lived sessions for v1. Do not rely on implicit conversational memory across candles.

When prior context matters, provide:

- the current compact snapshot;
- the prior compact result or prior compact snapshot summary;
- explicit identifiers and timestamps;
- a direct request to describe changed evidence.

## Testing cases derived from PR #54 lessons

Include fixtures for:

- context overflow;
- ambiguous compact keys;
- cumulative delta reconstruction error;
- omitted overlays with original counts;
- stale chain data;
- candle session gaps;
- missing position data during a management task;
- degradation ordering which preserves core trading evidence.
