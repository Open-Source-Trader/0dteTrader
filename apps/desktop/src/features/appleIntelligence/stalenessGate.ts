// Canonical spec: docs/apple-intelligence/lifecycle-and-concurrency.md
// (staleness gate) and data-contracts.md (AnalysisContextIdentity). A result
// may update current guidance only when its immutable context still matches
// current authoritative state — a stale result may be kept for history, but
// must never overwrite current guidance.
import type { AnalysisContextIdentity } from './types';

export function isResultCurrent(
  resultContext: AnalysisContextIdentity,
  current: AnalysisContextIdentity,
): boolean {
  return (
    resultContext.symbol === current.symbol &&
    resultContext.timeframe === current.timeframe &&
    resultContext.snapshotSequence === current.snapshotSequence &&
    resultContext.positionVersion === current.positionVersion &&
    resultContext.strategyPolicyVersion === current.strategyPolicyVersion &&
    resultContext.selectedContractSymbol === current.selectedContractSymbol
  );
}
