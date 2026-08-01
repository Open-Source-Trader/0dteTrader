// Canonical spec: docs/apple-intelligence/lifecycle-and-concurrency.md
// (repeated-analysis cache). Hashes only the semantic fields of an
// AnalysisSnapshot that should change the model's answer — excludes
// capture-time/sequence bookkeeping (capturedAt, snapshotSequence,
// snapshotId, quality.capturedAt/candlesFreshAsOf) that changes on every
// call even when the underlying market state is identical, which would
// otherwise defeat caching entirely.
import type { AnalysisSnapshot } from './types';

/** Same DJB-style rolling hash as hashPositionVersion
 * (AnalysisSnapshotBuilder.ts) — reused rather than introducing a second
 * hashing scheme or a crypto dependency for a cache key that only needs to
 * be stable and cheap, not cryptographically strong. */
function djb2Hash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

/**
 * Content hash of an AnalysisSnapshot's semantic fields, stable across two
 * captures of identical market/position/contract state regardless of when
 * or how many times they were captured. Explicit, ordered field selection
 * (not a spread of the whole snapshot) so key order stays deterministic and
 * volatile bookkeeping fields can't leak in by accident.
 */
export function computeSnapshotContentHash(snapshot: AnalysisSnapshot): string {
  const key = JSON.stringify({
    symbol: snapshot.identity.symbol,
    timeframe: snapshot.identity.timeframe,
    positionVersion: snapshot.identity.positionVersion,
    strategyPolicyVersion: snapshot.identity.strategyPolicyVersion ?? null,
    selectedContractSymbol: snapshot.identity.selectedContractSymbol ?? null,
    trigger: { kind: snapshot.trigger.kind, reason: snapshot.trigger.reason },
    market: snapshot.market,
    candles: snapshot.candles,
    indicators: snapshot.indicators,
    levels: snapshot.levels,
    options: snapshot.options ?? null,
    position: snapshot.position ?? null,
    strategyPolicy: snapshot.strategyPolicy ?? null,
    omissions: snapshot.omissions,
  });
  return djb2Hash(key);
}
