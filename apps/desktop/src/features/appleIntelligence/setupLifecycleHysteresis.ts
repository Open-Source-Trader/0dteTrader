// Canonical spec: docs/apple-intelligence/lifecycle-and-concurrency.md
// ("Action hysteresis") extended to setup continuity — see this session's
// setup-lifecycle-persistence design note. A setup, once detected, must
// persist across analyses under a stable identity until it completes or
// invalidates; a single noisy sample must not erase a triggered/extended
// setup's label just because that sample's snapshot alone doesn't offer a
// fresh entry. This module is a structural mirror of actionHysteresis.ts —
// same confirm-after-2 pattern, same instant-promote-on-real-price-move
// fast path, same instrument-keyed reset — but tracks a different concern
// (setup identity/progression) with a genuinely different value shape
// (SetupLifecycleState vs. a bare TradeDeskAction), so it's a parallel
// module rather than a generic refactor of the existing one.
import type { AnalysisResult, AnalysisSnapshot, SetupLifecycle } from './types';
import { hysteresisKey } from './actionHysteresis';

const CONFIRMATIONS_REQUIRED = 2;

/** Ordinal rank for "forward progress" comparisons — a fresh sample whose
 * lifecycle rank is >= the held setup's rank is advancing the same setup,
 * not regressing/replacing it. `invalidated` is reachable from any
 * non-terminal state and isn't part of this forward ordering (checked
 * separately). */
const LIFECYCLE_RANK: Record<Exclude<SetupLifecycle, 'invalidated'>, number> = {
  none: 0,
  developing: 1,
  confirmed: 2,
  triggered: 3,
  extended: 4,
  completed: 5,
};

export interface SetupLifecycleState {
  key: string;
  setupId: string;
  direction: 'bullish' | 'bearish';
  label: string;
  lifecycle: SetupLifecycle;
  detectedAt: string;
  triggeredAt?: string;
  invalidationLevel?: number;
  /** A candidate that disagrees with the held state, awaiting a second
   * consecutive match before it's trusted — mirrors ActionHysteresisState's
   * `pending`. Cleared whenever a differing candidate doesn't match it. */
  pending?: { lifecycle: SetupLifecycle; direction: 'bullish' | 'bearish'; count: number };
}

export type SetupContinuityDecision =
  | { kind: 'start-new' }
  | { kind: 'advance' }
  | { kind: 'hold'; pendingLifecycle: SetupLifecycle }
  | { kind: 'invalidate' }
  | { kind: 'none' };

/** One sample of raw model output is not enough to authorize an actionable
 * state — a single call can be sampling noise, a malformed/garbled
 * generation, or a genuine detection; there's no way to tell from one
 * sample alone. `developing` is the only lifecycle a fresh, unconfirmed
 * detection may land on; anything the model claims beyond that (confirmed,
 * triggered, extended, completed) is capped down to `developing` until a
 * second, semantically-compatible sample confirms it — see
 * `decideSetupContinuity`'s `hold`/`advance` path once a setup exists.
 * `none` and `invalidated` need no cap — they carry no actionable claim. */
function capFirstSampleLifecycle(lifecycle: SetupLifecycle): SetupLifecycle {
  if (lifecycle === 'none' || lifecycle === 'invalidated') return lifecycle;
  return LIFECYCLE_RANK[lifecycle] > LIFECYCLE_RANK.developing ? 'developing' : lifecycle;
}

function extractSetupFields(result: AnalysisResult): {
  lifecycle: SetupLifecycle;
  label: string;
  setupId?: string;
  direction: 'bullish' | 'bearish' | null;
  invalidationLevel?: number;
} {
  const plan = result.tradeDeskPlan;
  const lifecycle = plan?.setupLifecycle ?? 'none';
  const label = plan?.setupLabel ?? '';
  const direction = biasDirection(result.bias);
  const invalidationLevel = plan?.invalidation?.underlying?.price.value;
  return { lifecycle, label, setupId: plan?.setupId, direction, invalidationLevel };
}

function biasDirection(bias: AnalysisResult['bias']): 'bullish' | 'bearish' | null {
  if (bias === 'bullish') return 'bullish';
  if (bias === 'bearish') return 'bearish';
  return null;
}

function liveUnderlyingPrice(snapshot: AnalysisSnapshot): number | null {
  const market = snapshot.market as { last?: unknown } | undefined;
  const last = market?.last;
  return typeof last === 'number' && Number.isFinite(last) ? last : null;
}

/** True when price has actually crossed the held setup's own invalidation
 * level — a real market move, not resampling noise, so invalidation is
 * trusted immediately rather than waiting for two confirming samples.
 * Mirrors actionHysteresis.ts's `crossedHeldThreshold`, but against the
 * setup's own level rather than the action's grounded invalidation
 * condition (the two can differ: a setup can be invalidated on structure
 * while the current action's own invalidation, if any, hasn't been hit). */
function crossedInvalidationLevel(
  held: SetupLifecycleState,
  freshSnapshot: AnalysisSnapshot,
): boolean {
  if (held.invalidationLevel === undefined) return false;
  const livePrice = liveUnderlyingPrice(freshSnapshot);
  if (livePrice === null) return false;
  return held.direction === 'bullish'
    ? livePrice < held.invalidationLevel
    : livePrice > held.invalidationLevel;
}

function isForwardProgress(from: SetupLifecycle, to: SetupLifecycle): boolean {
  if (to === 'invalidated' || from === 'invalidated') return false;
  return LIFECYCLE_RANK[to] >= LIFECYCLE_RANK[from];
}

/**
 * Decides how a fresh result relates to the currently-tracked setup for
 * this instrument. Pure function of current tracker state and the fresh
 * result/snapshot — no I/O, no mutation; the caller applies the decision
 * and updates its own tracker via `advanceSetupLifecycle`.
 */
export function decideSetupContinuity(
  state: SetupLifecycleState | null,
  fresh: AnalysisResult,
  freshSnapshot: AnalysisSnapshot,
): SetupContinuityDecision {
  const { lifecycle: freshLifecycle, direction: freshDirection } = extractSetupFields(fresh);

  if (!state) {
    return freshLifecycle === 'none' ? { kind: 'none' } : { kind: 'start-new' };
  }

  if (crossedInvalidationLevel(state, freshSnapshot)) {
    return { kind: 'invalidate' };
  }

  const sameDirection = freshDirection === null || freshDirection === state.direction;
  if (sameDirection && freshLifecycle === 'invalidated') {
    return { kind: 'invalidate' };
  }
  if (sameDirection && isForwardProgress(state.lifecycle, freshLifecycle)) {
    return { kind: 'advance' };
  }

  // A direction flip, or a regression to a lower lifecycle rank while the
  // held setup was triggered+, is only trusted after two consecutive
  // agreeing samples — a lone contrary sample cannot erase a held setup.
  const candidateDirection = freshDirection ?? state.direction;
  const pendingMatches =
    state.pending?.lifecycle === freshLifecycle && state.pending?.direction === candidateDirection;
  const nextCount = pendingMatches ? state.pending!.count + 1 : 1;
  if (nextCount >= CONFIRMATIONS_REQUIRED) {
    return freshLifecycle === 'none' || freshLifecycle === 'invalidated'
      ? { kind: 'invalidate' }
      : { kind: 'start-new' };
  }
  return { kind: 'hold', pendingLifecycle: freshLifecycle };
}

/** Advances the tracker after applying a decision — the caller's single
 * source of truth for what gets remembered between calls. Returns `null`
 * once a setup completes or invalidates and the fresh sample doesn't start
 * a new one. */
export function advanceSetupLifecycle(
  state: SetupLifecycleState | null,
  fresh: AnalysisResult,
  freshSnapshot: AnalysisSnapshot,
  decision: SetupContinuityDecision,
): SetupLifecycleState | null {
  const key = hysteresisKey(freshSnapshot);
  const fields = extractSetupFields(fresh);
  const now = freshSnapshot.identity.capturedAt;

  switch (decision.kind) {
    case 'none':
      return null;
    case 'start-new': {
      if (fields.direction === null || fields.lifecycle === 'none') return null;
      // One sample cannot authorize an actionable state — see
      // capFirstSampleLifecycle's doc comment. The model's claim beyond
      // `developing` is not discarded, only deferred: it becomes the
      // pending candidate a second consecutive sample can confirm through
      // the normal decideSetupContinuity `advance` path next call.
      const cappedLifecycle = capFirstSampleLifecycle(fields.lifecycle);
      const wasCapped = cappedLifecycle !== fields.lifecycle;
      return {
        key,
        setupId: fields.setupId ?? `${key}-${now}`,
        direction: fields.direction,
        label: fields.label,
        lifecycle: cappedLifecycle,
        detectedAt: now,
        triggeredAt: cappedLifecycle === 'triggered' ? now : undefined,
        invalidationLevel: fields.invalidationLevel,
        pending: wasCapped
          ? { lifecycle: fields.lifecycle, direction: fields.direction, count: 1 }
          : undefined,
      };
    }
    case 'advance': {
      const triggeredJustNow = fields.lifecycle === 'triggered' && state!.lifecycle !== 'triggered';
      return {
        ...state!,
        key,
        label: fields.label || state!.label,
        lifecycle: fields.lifecycle,
        triggeredAt: triggeredJustNow ? now : state!.triggeredAt,
        invalidationLevel: fields.invalidationLevel ?? state!.invalidationLevel,
      };
    }
    case 'hold':
      return {
        ...state!,
        key,
        pending:
          state!.pending?.lifecycle === decision.pendingLifecycle
            ? { ...state!.pending, count: state!.pending.count + 1 }
            : {
                lifecycle: decision.pendingLifecycle,
                direction: fields.direction ?? state!.direction,
                count: 1,
              },
      };
    case 'invalidate':
      return null;
  }
}
