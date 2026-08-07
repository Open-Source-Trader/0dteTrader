// Canonical spec: docs/apple-intelligence/lifecycle-and-concurrency.md
// ("Action hysteresis"). Foundation Models generation is inherently
// non-deterministic — the same market snapshot can legitimately produce
// different prose/confidence on two consecutive calls. That's expected and
// must not be papered over with a result cache (tried and reverted — see
// git history). What must NOT vary from sampling noise alone is the
// decision itself: enter/hold/exit/wait/avoid/scale. This module decides
// whether a fresh sample's action is trustworthy enough to replace the
// currently-held one, without touching prose, confidence, or the model's
// sampling in any way — the model still decides; this only gates promotion.
import type { AnalysisResult, AnalysisSnapshot, TradeDeskAction } from './types';

const CONFIRMATIONS_REQUIRED = 2;

/**
 * The action a result represents for hysteresis purposes: `tradeDeskPlan.action`
 * when a plan is present (the richer, already-grounded field), falling back
 * to the legacy `recommendation` otherwise — same source-of-truth fallback
 * `tradeDeskPresenter.ts`'s `presentResult` already uses, so this module's
 * notion of "the action" matches what the UI ultimately renders.
 */
export function resultAction(result: AnalysisResult): TradeDeskAction {
  if (result.tradeDeskPlan) return result.tradeDeskPlan.action;
  return result.recommendation === 'trim' ? 'scale' : result.recommendation;
}

/** Identifies the instrument a hysteresis tracker applies to — switching
 * symbol/timeframe/contract is a genuinely different decision context, not
 * a new sample of the same one, so tracking must reset rather than hold a
 * new instrument's action behind an unrelated prior instrument's state. */
export function hysteresisKey(snapshot: AnalysisSnapshot): string {
  return `${snapshot.identity.symbol}:${snapshot.identity.timeframe}:${snapshot.identity.selectedContractSymbol ?? ''}`;
}

export interface ActionHysteresisState {
  key: string;
  /** The currently-confirmed, promoted action and the full result it came
   * from (needed to synthesize a held result's action-specific fields when
   * a fresh sample's candidate is not yet confirmed). */
  confirmedAction: TradeDeskAction;
  confirmedResult: AnalysisResult;
  /** A differing action seen once, awaiting a second consecutive match
   * before it's trusted. Cleared whenever a differing candidate arrives
   * that doesn't match the pending one — no partial credit accumulates
   * across different candidates. */
  pending?: { action: TradeDeskAction; count: number };
}

export type ActionHysteresisDecision =
  | { kind: 'promote-fresh' }
  | { kind: 'hold'; heldAction: TradeDeskAction; pendingAction: TradeDeskAction }
  | { kind: 'promote-confirmed' };

function liveUnderlyingPrice(snapshot: AnalysisSnapshot): number | null {
  const market = snapshot.market as { last?: unknown } | undefined;
  const last = market?.last;
  return typeof last === 'number' && Number.isFinite(last) ? last : null;
}

/** True when the live price has actually crossed a threshold the *held*
 * result itself already grounded (its own invalidation condition) — a real
 * market move, not resampling noise, so the new action is trusted
 * immediately regardless of confirmation count. Only enter/hold/exit ever
 * have a grounded invalidation to check; scale/wait/avoid transitions never
 * get this fast path and always go through confirmation. */
function crossedHeldThreshold(held: AnalysisResult, liveSnapshot: AnalysisSnapshot): boolean {
  const condition = held.tradeDeskPlan?.invalidation?.underlying;
  if (!condition) return false;
  const livePrice = liveUnderlyingPrice(liveSnapshot);
  if (livePrice === null) return false;

  const threshold = condition.price.value;
  switch (condition.operator) {
    case 'above':
      return livePrice > threshold;
    case 'at-or-above':
      return livePrice >= threshold;
    case 'below':
      return livePrice < threshold;
    case 'at-or-below':
      return livePrice <= threshold;
  }
}

/**
 * Decides whether `fresh` should be promoted as-is, held back in favor of
 * the currently-confirmed action pending further confirmation, or promoted
 * because it just reached the confirmation threshold. Pure function of the
 * current tracker state and the fresh result/snapshot — no I/O, no
 * mutation; the caller applies the decision and updates its own tracker.
 */
export function decideActionHysteresis(
  state: ActionHysteresisState | null,
  fresh: AnalysisResult,
  freshSnapshot: AnalysisSnapshot,
): ActionHysteresisDecision {
  if (!state) return { kind: 'promote-fresh' };

  const freshAction = resultAction(fresh);
  if (freshAction === state.confirmedAction) return { kind: 'promote-fresh' };

  if (crossedHeldThreshold(state.confirmedResult, freshSnapshot)) {
    return { kind: 'promote-fresh' };
  }

  const pendingMatches = state.pending?.action === freshAction;
  const nextCount = pendingMatches ? state.pending!.count + 1 : 1;
  if (nextCount >= CONFIRMATIONS_REQUIRED) {
    return { kind: 'promote-confirmed' };
  }
  return { kind: 'hold', heldAction: state.confirmedAction, pendingAction: freshAction };
}

/** Advances the tracker after applying a decision — the caller's single
 * source of truth for what gets remembered between calls. */
export function advanceActionHysteresis(
  state: ActionHysteresisState | null,
  fresh: AnalysisResult,
  freshSnapshot: AnalysisSnapshot,
  decision: ActionHysteresisDecision,
): ActionHysteresisState {
  const key = hysteresisKey(freshSnapshot);
  if (decision.kind === 'promote-fresh' || decision.kind === 'promote-confirmed') {
    return { key, confirmedAction: resultAction(fresh), confirmedResult: fresh };
  }
  // hold: keep the confirmed action/result, advance (or reset) the pending count.
  const freshAction = resultAction(fresh);
  const pendingMatches = state?.pending?.action === freshAction;
  const nextCount = pendingMatches ? state!.pending!.count + 1 : 1;
  return {
    key,
    confirmedAction: state!.confirmedAction,
    confirmedResult: state!.confirmedResult,
    pending: { action: freshAction, count: nextCount },
  };
}

/**
 * Synthesizes the result to promote when a fresh sample's action is held
 * back: prose/confidence/timestamp come from the fresh sample (so the panel
 * still visibly updates as the market runs, per the product requirement
 * that advice stay up to date even while the action itself is stable) but
 * the action and its action-specific structured fields (entry, invalidation,
 * targets, management) come from the held result, since those are
 * meaningless if mismatched with a different action's prose.
 */
export function synthesizeHeldResult(held: AnalysisResult, fresh: AnalysisResult): AnalysisResult {
  return {
    ...fresh,
    recommendation: held.recommendation,
    tradeDeskPlan: held.tradeDeskPlan
      ? {
          ...held.tradeDeskPlan,
          // Prose fields inside the plan still refresh from the fresh
          // sample — only the decision-bearing fields are held. Warnings
          // are filtered, not taken wholesale: a "Downgraded from X" warning
          // describes the fresh sample's own (differing, not-yet-confirmed)
          // action, and would misrepresent the held plan's action if
          // attached to it verbatim.
          summary: fresh.tradeDeskPlan?.summary ?? held.tradeDeskPlan.summary,
          warnings:
            fresh.tradeDeskPlan?.warnings?.filter(
              (warning) => !warning.startsWith('Downgraded from "'),
            ) ?? held.tradeDeskPlan.warnings,
        }
      : fresh.tradeDeskPlan,
  };
}
