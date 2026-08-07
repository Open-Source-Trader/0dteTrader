import type { OptionContract, Position } from '@0dtetrader/shared-types';
import { optionTypeShortName } from '../../core/models/domain';
import { PRICE_MAX, PRICE_MIN, PRICE_STEP, roundToTick } from '../../core/models/priceInput';
import { Format } from '../../design/format';
import { isResultCurrent } from './stalenessGate';
import type {
  AIAvailability,
  AnalysisContextIdentity,
  AnalysisDiscard,
  AnalysisIneligibilityReason,
  AnalysisResult,
  MarketAnalysisState,
  SetupLifecycle,
  TradeDeskAction,
  TradeDeskPlan,
} from './types';

export type TradeDeskPresentationAction =
  'wait' | 'enter' | 'hold' | 'scale_in' | 'scale_out' | 'exit' | 'avoid';

export interface ApplicablePriceSuggestion {
  price: number;
  priceDomain: 'contract-premium';
  evidenceId: string;
  snapshotId: string;
  positionVersion: number;
  contractIdentity: string;
}

export interface PresentedPrice {
  label: string;
  value: string;
  evidenceId: string;
}

export interface PresentedPriceZone {
  label: string;
  value: string;
  evidenceId: string;
}

export interface PresentedCondition {
  label: string;
  value: string;
  evidenceId?: string;
}

export interface PresentedTarget {
  role: 'first' | 'runner' | 'final';
  label: string;
  value: string;
  condition?: string;
  evidenceId: string;
}

export interface TradeDeskPresentation {
  resultId: string;
  snapshotId: string;
  positionVersion: number;
  contractIdentity: string;
  action: TradeDeskPresentationAction;
  actionLabel: string;
  setupLifecycle: SetupLifecycle;
  setupLabel: string;
  summary: string;
  entry?: {
    underlying?: PresentedPriceZone;
    contract?: PresentedPriceZone;
    preferredContractPrice?: PresentedPrice;
  };
  invalidation?: {
    underlying?: PresentedCondition;
    contract?: PresentedCondition;
  };
  contractTargets: PresentedTarget[];
  underlyingTargets: PresentedTarget[];
  management: {
    holdConditions: string[];
    scaleConditions: string[];
    exitConditions: string[];
  };
  warnings: string[];
  confidence?: 'low' | 'medium' | 'high';
  applicablePriceSuggestion?: ApplicablePriceSuggestion;
}

/** Whether the trader is flat or holding the selected contract — derived
 * from actual broker/account position data (never from the AI's chosen
 * action), so a stale or racing recommendation can never flip the grid
 * layout on its own. See buildTradeDeskViewState's `hasOpenPosition` input. */
export type TradeDeskPositionState = 'flat' | 'in-trade';

/** Distinguishes why the Trade Desk has nothing to show — surfaced only
 * when `status === 'unavailable'`. Populated from AnalysisStore's
 * `lastIneligibility` (pre-model rejection, snapshotValidation.ts) or
 * `lastDiscard` (a request was submitted but didn't produce current
 * guidance — decode/schema/grounding/staleness/transport failure, see
 * `mapDiscardReason`); otherwise left absent for the remaining
 * generic-unavailable cases (availability not ready, no result yet at all). */
export type TradeDeskUnavailableReason =
  | 'invalid-underlying-quote'
  | 'invalid-options-analytics'
  | 'insufficient-data'
  | 'model-unavailable'
  | 'analysis-incomplete';

export interface TradeDeskViewState {
  status: 'current' | 'generating' | 'stale' | 'unavailable' | 'failed' | 'disabled';
  presentation?: TradeDeskPresentation;
  generatedAt?: string;
  staleReason?: string;
  canApplySuggestedPrice: boolean;
  /** Session/freshness state independent of result staleness — a `current`
   * result can still be `market-closed` if captured outside trading hours.
   * Defaults to `live` when the caller doesn't supply one, so existing
   * callers/tests are unaffected. */
  marketSessionState: MarketAnalysisState;
  /** A differing action seen in the latest sample but not yet confirmed
   * (AnalysisStore's action hysteresis) — the primary action badge still
   * shows the held/confirmed action; this surfaces the candidate so the
   * panel can show "confirming" feedback without flipping the badge on a
   * single contrary sample. */
  pendingActionChange?: { action: TradeDeskAction; label: string };
  /** Authoritative flat/in-trade state for choosing which 8-cell grid to
   * render. Always present so callers don't need a separate lookup. */
  positionState: TradeDeskPositionState;
  /** Only meaningful when `status === 'unavailable'` — see
   * TradeDeskUnavailableReason. */
  unavailableReason?: TradeDeskUnavailableReason;
}

export interface TradeDeskPresentationLimits {
  maxSetupLabelCharacters: number;
  maxSummaryCharacters: number;
  maxManagementConditionsPerGroup: number;
  maxContractTargets: number;
  maxUnderlyingTargets: number;
  maxWarnings: number;
}

export const DEFAULT_TRADE_DESK_LIMITS: TradeDeskPresentationLimits = {
  maxSetupLabelCharacters: 48,
  maxSummaryCharacters: 140,
  maxManagementConditionsPerGroup: 2,
  maxContractTargets: 3,
  maxUnderlyingTargets: 2,
  maxWarnings: 2,
};

export interface BuildTradeDeskViewStateInput {
  availability: AIAvailability;
  isAnalyzing: boolean;
  latestResult: AnalysisResult | null;
  /** Most recent request that didn't produce current guidance — see
   * AnalysisStore's `lastDiscard`. Replaces the old bare `errorMessage`
   * string: unlike that field (which the store cleared the instant the next
   * request started, discarding the reason before a trader ever saw it),
   * this stays populated across a retry until a matching successful result
   * supersedes it or the instrument/context materially changes. */
  lastDiscard: AnalysisDiscard | null;
  currentContext: AnalysisContextIdentity | null;
  selectedContract: OptionContract | null;
  currentPositionVersion: number;
  disabled?: boolean;
  limits?: Partial<TradeDeskPresentationLimits>;
  marketSessionState?: MarketAnalysisState;
  pendingActionChange?: { action: TradeDeskAction } | null;
  /** Authoritative flat/in-trade signal — an actual open long in the
   * selected contract, not inferred from the AI's recommended action.
   * Defaults to false (flat) for callers that don't supply it. */
  hasOpenPosition?: boolean;
  /** Set when the most recently submitted snapshot was rejected by the
   * pre-model eligibility gate (AnalysisStore.lastIneligibility) — the
   * model was never invoked. Takes priority over the generic-unavailable
   * fallback below so the panel can show a specific reason, but never over
   * a still-valid prior presentation (a stale-but-real result outranks "the
   * latest refresh attempt was rejected"). */
  ineligibility?: { reason: AnalysisIneligibilityReason; userMessage: string } | null;
}

function mapIneligibilityReason(reason: AnalysisIneligibilityReason): TradeDeskUnavailableReason {
  switch (reason) {
    case 'invalid-underlying-quote':
    case 'missing-underlying-quote':
      return 'invalid-underlying-quote';
    case 'invalid-options-analytics':
    case 'invalid-selected-contract-quote':
      return 'invalid-options-analytics';
    case 'missing-candles':
    case 'stale-candles':
    case 'invalid-candle-data':
    case 'snapshot-mismatch':
    case 'insufficient-data':
      return 'insufficient-data';
  }
}

/** Maps a post-submission discard (AnalysisStore.lastDiscard) to the same
 * curated, bounded reason vocabulary `mapIneligibilityReason` uses for
 * pre-model rejections — never the raw discard message, which may carry
 * detail (e.g. a native error string) not meant for direct trader display. */
function mapDiscardReason(discard: AnalysisDiscard): TradeDeskUnavailableReason {
  switch (discard.code) {
    case 'bridge-unavailable':
    case 'request-failed':
    case 'runtime-failed':
      return 'model-unavailable';
    case 'invalid-result':
    case 'ungrounded-plan':
      return 'analysis-incomplete';
    case 'stale-context':
    case 'superseded':
      return 'insufficient-data';
  }
}

export function buildTradeDeskViewState(input: BuildTradeDeskViewStateInput): TradeDeskViewState {
  const marketSessionState = input.marketSessionState ?? 'live';
  const positionState: TradeDeskPositionState = input.hasOpenPosition ? 'in-trade' : 'flat';
  if (input.disabled) {
    return { status: 'disabled', canApplySuggestedPrice: false, marketSessionState, positionState };
  }

  const limits = { ...DEFAULT_TRADE_DESK_LIMITS, ...input.limits };
  const presentation = input.latestResult
    ? presentResult({
        result: input.latestResult,
        selectedContract: input.selectedContract,
        currentPositionVersion: input.currentPositionVersion,
        limits,
      })
    : undefined;
  if (input.isAnalyzing) {
    return {
      status: 'generating',
      presentation,
      generatedAt: presentation?.resultId ? input.latestResult?.generatedAt : undefined,
      canApplySuggestedPrice: false,
      marketSessionState,
      positionState,
    };
  }

  // An ineligible last request means the model was never invoked for it —
  // more specific than the generic lastDiscard/unavailable fallbacks below,
  // so it takes priority over them, but never over a still-valid
  // presentation: a stale-but-real result is more useful than "the latest
  // refresh attempt was rejected."
  if (input.ineligibility && !presentation) {
    return {
      status: 'unavailable',
      unavailableReason: mapIneligibilityReason(input.ineligibility.reason),
      staleReason: input.ineligibility.userMessage,
      canApplySuggestedPrice: false,
      marketSessionState,
      positionState,
    };
  }

  // No prior valid result exists for this instrument and the most recent
  // request didn't produce one either — render the specific discard reason
  // (never the bare, reason-less "unavailable" grid) so a trader always
  // sees why, not just that nothing is there. See AnalysisDiscardCode.
  if (input.lastDiscard && !presentation) {
    return {
      status: 'unavailable',
      unavailableReason: mapDiscardReason(input.lastDiscard),
      staleReason: input.lastDiscard.message,
      canApplySuggestedPrice: false,
      marketSessionState,
      positionState,
    };
  }

  if (input.availability.state !== 'ready' && input.availability.state !== 'degraded') {
    return {
      status: input.availability.state === 'unavailable' ? 'unavailable' : 'disabled',
      staleReason: 'reason' in input.availability ? input.availability.reason : undefined,
      canApplySuggestedPrice: false,
      marketSessionState,
      positionState,
    };
  }

  if (!presentation || !input.latestResult) {
    return {
      status: 'unavailable',
      canApplySuggestedPrice: false,
      marketSessionState,
      positionState,
    };
  }

  const isCurrent = input.currentContext
    ? isResultCurrent(input.latestResult.context, input.currentContext)
    : false;

  if (!isCurrent) {
    return {
      status: 'stale',
      presentation,
      generatedAt: input.latestResult.generatedAt,
      staleReason: staleReason(input.latestResult.context, input.currentContext),
      canApplySuggestedPrice: false,
      marketSessionState,
      positionState,
    };
  }

  // A discard for a DIFFERENT instrument/context than this current, valid
  // result must never downgrade it to 'failed' — e.g. a symbol switch that
  // failed shouldn't hide the still-good analysis for the symbol actually
  // on screen (state priority #3: "a matching failed result preserves the
  // prior valid result and exposes a compact warning" implies an
  // UNMATCHING one shouldn't touch it at all). In practice a discard that
  // matches this same context is normally already cleared by promoteResult
  // the moment a current result is promoted; this only fires for the rare
  // window where a matching discard was recorded after this presentation's
  // own promotion (e.g. a fingerprint-replay race).
  if (
    input.lastDiscard &&
    input.currentContext &&
    input.lastDiscard.symbol === input.currentContext.symbol &&
    input.lastDiscard.timeframe === input.currentContext.timeframe &&
    input.lastDiscard.selectedContractSymbol === input.currentContext.selectedContractSymbol &&
    input.lastDiscard.positionVersion === input.currentContext.positionVersion
  ) {
    return {
      status: 'failed',
      presentation,
      generatedAt: input.latestResult.generatedAt,
      staleReason: input.lastDiscard.message,
      canApplySuggestedPrice: false,
      marketSessionState,
      positionState,
    };
  }

  // Market-closed data can still be "current" against the staleness gate
  // (identity matches) but must never present as an actionable live entry —
  // downgrade the applicable-price suggestion rather than the result itself.
  const canApplySuggestedPrice =
    marketSessionState === 'live' && Boolean(presentation.applicablePriceSuggestion);
  const pendingActionChange = input.pendingActionChange
    ? {
        action: input.pendingActionChange.action,
        label: pendingActionLabel(input.pendingActionChange.action),
      }
    : undefined;
  return {
    status: 'current',
    presentation,
    generatedAt: input.latestResult.generatedAt,
    canApplySuggestedPrice,
    marketSessionState,
    pendingActionChange,
    positionState,
  };
}

/**
 * Whether to source the presentation from `tradeDeskPlan` or from the
 * legacy top-level fields is decided once, here, rather than per field —
 * a plan half-used (action from the plan, price suggestion from legacy, or
 * vice versa) is exactly the bug that made the header say ENTER while the
 * button said NO ENTRY PRICE. `tradeDeskPlan` is only ever absent for
 * results predating this feature (schema-migration safety); once present,
 * every field it doesn't itself populate is simply absent in the
 * presentation, never silently backfilled from the legacy fields.
 */
function presentResult({
  result,
  selectedContract,
  currentPositionVersion,
  limits,
}: {
  result: AnalysisResult;
  selectedContract: OptionContract | null;
  currentPositionVersion: number;
  limits: TradeDeskPresentationLimits;
}): TradeDeskPresentation {
  const plan = result.tradeDeskPlan;
  const action = plan
    ? normalizeAction(plan.action, plan.scaleAdvice)
    : normalizeAction(legacyAction(result.recommendation));
  const snapshotId = result.context.snapshotId ?? '';
  const contractIdentity = selectedContract?.symbol ?? result.context.selectedContractSymbol ?? '';
  const setupLabel = clampText(
    plan?.setupLabel ?? legacySetupLabel(result),
    limits.maxSetupLabelCharacters,
  );
  const entry = plan
    ? presentEntry(plan.entry, selectedContract, result.context.symbol)
    : legacyEntry(result);
  const invalidation = plan
    ? presentInvalidation(plan.invalidation, result.context.symbol)
    : legacyInvalidation(result);
  const contractTargets = (plan?.targets.contract ?? [])
    .filter((target) => target.price.priceDomain === 'contract-premium')
    .slice(0, limits.maxContractTargets)
    .map((target) => ({
      role: target.role,
      label: roleLabel(target.role),
      value: money(target.price.value),
      condition: target.condition ? clampText(target.condition, 80) : undefined,
      evidenceId: target.price.evidenceId,
    }));
  const underlyingTargets = (plan?.targets.underlying ?? [])
    .filter((target) => target.price.priceDomain === 'underlying')
    .slice(0, limits.maxUnderlyingTargets)
    .map((target) => ({
      role: target.role,
      label: roleLabel(target.role),
      value: underlying(result.context.symbol, target.price.value),
      condition: target.condition ? clampText(target.condition, 80) : undefined,
      evidenceId: target.price.evidenceId,
    }));
  const management = plan
    ? {
        holdConditions: clampList(plan.management.holdConditions, limits),
        scaleConditions: clampList(plan.management.scaleConditions, limits),
        exitConditions: clampList(plan.management.exitConditions, limits),
      }
    : {
        holdConditions: clampList(legacyHoldConditions(result), limits),
        scaleConditions: [],
        exitConditions: clampList(legacyExitConditions(result), limits),
      };
  const applicablePriceSuggestion = plan
    ? buildApplicableSuggestion({
        plan,
        result,
        selectedContract,
        currentPositionVersion,
        contractIdentity,
        snapshotId,
      })
    : undefined;

  return {
    resultId: result.analysisId,
    snapshotId,
    positionVersion: result.context.positionVersion,
    contractIdentity,
    action,
    actionLabel: actionLabel(action),
    // The legacy fallback path (no tradeDeskPlan) predates setupLifecycle
    // entirely and has no way to express it — 'none' is the only honest
    // default, matching its setupState-based label ("no setup" framing).
    setupLifecycle: plan?.setupLifecycle ?? 'none',
    setupLabel,
    summary: clampText(plan?.summary ?? result.summary, limits.maxSummaryCharacters),
    entry,
    invalidation,
    contractTargets,
    underlyingTargets,
    management,
    warnings: (plan?.warnings ?? result.warnings)
      .filter(Boolean)
      .slice(0, limits.maxWarnings)
      .map((warning) => clampText(warning, 100)),
    confidence: plan?.confidence ?? confidenceClass(result.confidence),
    applicablePriceSuggestion,
  };
}

function presentEntry(
  entry: TradeDeskPlan['entry'] | undefined,
  selectedContract: OptionContract | null,
  symbol: string,
): TradeDeskPresentation['entry'] | undefined {
  if (!entry) return undefined;
  const output: NonNullable<TradeDeskPresentation['entry']> = {};
  if (entry.underlying?.priceDomain === 'underlying') {
    output.underlying = {
      label: 'Underlying',
      value: `${symbol} ${Format.price(entry.underlying.low)}–${Format.price(entry.underlying.high)}`,
      evidenceId: entry.underlying.evidenceId,
    };
  }
  if (entry.contract?.priceDomain === 'contract-premium') {
    output.contract = {
      label: 'Contract',
      value: `${money(entry.contract.low)}–${money(entry.contract.high)}`,
      evidenceId: entry.contract.evidenceId,
    };
  }
  if (entry.preferredContractPrice?.priceDomain === 'contract-premium') {
    output.preferredContractPrice = {
      label: selectedContract ? 'Preferred option price' : 'Preferred contract price',
      value: money(entry.preferredContractPrice.value),
      evidenceId: entry.preferredContractPrice.evidenceId,
    };
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function legacyEntry(result: AnalysisResult): TradeDeskPresentation['entry'] | undefined {
  if (!result.levels.support) return undefined;
  return {
    underlying: {
      label: 'Underlying',
      value: `${result.context.symbol} ${Format.price(result.levels.support.price)}`,
      evidenceId: result.levels.support.levelId,
    },
  };
}

function presentInvalidation(
  invalidation: TradeDeskPlan['invalidation'] | undefined,
  symbol: string,
): TradeDeskPresentation['invalidation'] | undefined {
  if (!invalidation) return undefined;
  const output: NonNullable<TradeDeskPresentation['invalidation']> = {};
  if (invalidation.underlying) {
    output.underlying = {
      label: 'Invalidation',
      value: `${symbol} ${invalidation.underlying.operator} ${Format.price(invalidation.underlying.price.value)}`,
      evidenceId: invalidation.underlying.price.evidenceId,
    };
  }
  if (invalidation.contract) {
    output.contract = {
      label: 'Contract invalidation',
      value: `Contract ${invalidation.contract.operator} ${money(invalidation.contract.price.value)}`,
      evidenceId: invalidation.contract.price.evidenceId,
    };
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function legacyInvalidation(
  result: AnalysisResult,
): TradeDeskPresentation['invalidation'] | undefined {
  if (!result.levels.cutBelow) return undefined;
  return {
    underlying: {
      label: 'Invalidation',
      value: `${result.context.symbol} below ${Format.price(result.levels.cutBelow.price)}`,
      evidenceId: result.levels.cutBelow.levelId,
    },
  };
}

function buildApplicableSuggestion({
  plan,
  result,
  selectedContract,
  currentPositionVersion,
  contractIdentity,
  snapshotId,
}: {
  plan: TradeDeskPlan;
  result: AnalysisResult;
  selectedContract: OptionContract | null;
  currentPositionVersion: number;
  contractIdentity: string;
  snapshotId: string;
}): ApplicablePriceSuggestion | undefined {
  const preferred = plan.entry?.preferredContractPrice;
  if (!preferred || preferred.priceDomain !== 'contract-premium') return undefined;
  if (!selectedContract || !contractIdentity || !snapshotId) return undefined;
  if (result.context.selectedContractSymbol !== selectedContract.symbol) return undefined;
  if (result.context.positionVersion !== currentPositionVersion) return undefined;
  if (!isValidContractPremium(preferred.value, selectedContract)) return undefined;
  return {
    price: roundToTick(preferred.value),
    priceDomain: 'contract-premium',
    evidenceId: preferred.evidenceId,
    snapshotId,
    positionVersion: result.context.positionVersion,
    contractIdentity,
  };
}

export function isValidContractPremium(price: number, contract: OptionContract | null): boolean {
  if (!contract) return false;
  if (!Number.isFinite(price) || price < PRICE_MIN || price > PRICE_MAX) return false;
  const rounded = roundToTick(price);
  if (Math.abs(rounded - price) > Number.EPSILON * 100) return false;
  const maxReference = Math.max(contract.bid, contract.ask, contract.last, PRICE_STEP);
  return price <= Math.max(PRICE_STEP, maxReference * 20);
}

function normalizeAction(
  action: 'wait' | 'enter' | 'hold' | 'scale' | 'exit' | 'avoid',
  scaleAdvice?: { direction: 'in' | 'out' },
): TradeDeskPresentationAction {
  if (action !== 'scale') return action;
  // enforceTradeDeskInvariants downgrades an unsatisfied scale to `wait`
  // before the presenter normally sees it, but normalizeAction has no such
  // guarantee itself — if validation is ever bypassed, or a result reaches
  // the presenter through a different path, a scale with no scaleAdvice (or
  // a direction other than 'in') must never silently become "SCALE OUT",
  // the opposite of the only other directional meaning ('in'). `wait` is
  // the safe default; only an explicit 'in' or 'out' picks a scale action.
  if (scaleAdvice?.direction === 'in') return 'scale_in';
  if (scaleAdvice?.direction === 'out') return 'scale_out';
  return 'wait';
}

function legacyAction(
  recommendation: AnalysisResult['recommendation'],
): 'wait' | 'enter' | 'hold' | 'scale' | 'exit' | 'avoid' {
  return recommendation === 'trim' ? 'scale' : recommendation;
}

function legacySetupLabel(result: AnalysisResult): string {
  const bias = result.bias === 'mixed' ? 'Mixed' : capitalize(result.bias);
  return result.setupState === 'none' ? `${bias} desk check` : `${bias} ${result.setupState}`;
}

function legacyHoldConditions(result: AnalysisResult): string[] {
  return result.levels.holdAbove
    ? [`Hold above ${Format.price(result.levels.holdAbove.price)}`]
    : [];
}

function legacyExitConditions(result: AnalysisResult): string[] {
  return result.levels.cutBelow ? [`Cut below ${Format.price(result.levels.cutBelow.price)}`] : [];
}

function confidenceClass(confidence: number): 'low' | 'medium' | 'high' {
  if (confidence >= 0.67) return 'high';
  if (confidence >= 0.34) return 'medium';
  return 'low';
}

function clampList(values: string[], limits: TradeDeskPresentationLimits): string[] {
  return values
    .filter(Boolean)
    .slice(0, limits.maxManagementConditionsPerGroup)
    .map((value) => clampText(value, 80));
}

export function clampText(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  const boundary = compact.lastIndexOf(' ', max - 1);
  const cut = boundary >= Math.floor(max * 0.6) ? boundary : max - 1;
  return `${compact.slice(0, cut).trimEnd()}…`;
}

function staleReason(
  result: AnalysisContextIdentity,
  current: AnalysisContextIdentity | null,
): string {
  if (!current) return 'Current market snapshot is unavailable.';
  if (result.selectedContractSymbol !== current.selectedContractSymbol)
    return 'Selected contract changed.';
  if (result.positionVersion !== current.positionVersion) return 'Position changed.';
  if (result.snapshotSequence !== current.snapshotSequence)
    return 'Newer market snapshot is available.';
  return 'Assessment is no longer current.';
}

function actionLabel(action: TradeDeskPresentationAction): string {
  switch (action) {
    case 'scale_in':
      return 'SCALE IN';
    case 'scale_out':
      return 'SCALE OUT';
    default:
      return action.toUpperCase();
  }
}

/** A pending candidate has no `scaleAdvice` direction to normalize against
 * (it hasn't been confirmed/promoted yet), so it labels plainly rather than
 * splitting into SCALE IN/OUT the way `actionLabel` does for a promoted
 * action. */
function pendingActionLabel(action: TradeDeskAction): string {
  return action.toUpperCase();
}

function roleLabel(role: PresentedTarget['role']): string {
  return role[0].toUpperCase() + role.slice(1);
}

function money(value: number): string {
  return `$${Format.price(value)}`;
}

function underlying(symbol: string, value: number): string {
  return `${symbol} ${Format.price(value)}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ---------------------------------------------------------------------------
// Fixed 8-cell grid models for the AI Trade Desk band. Both are pure
// re-projections of TradeDeskPresentation's existing fields — no new
// domain concepts, just picking the right subset for the flat vs. in-trade
// board and giving each a short (label, value) shape a grid cell can render
// without measuring content.
// ---------------------------------------------------------------------------

export interface TradeDeskGridCell {
  label: string;
  value: string;
  secondary?: string;
}

export interface FlatTradeDeskAnalysis {
  setup: TradeDeskGridCell;
  entry: TradeDeskGridCell;
  invalidation: TradeDeskGridCell;
  targets: TradeDeskGridCell;
  contract: TradeDeskGridCell;
  premiumLimit: TradeDeskGridCell;
  execution: TradeDeskGridCell;
  runner: TradeDeskGridCell;
}

export interface PositionTradeDeskAnalysis {
  position: TradeDeskGridCell;
  currentAction: TradeDeskGridCell;
  invalidation: TradeDeskGridCell;
  targets: TradeDeskGridCell;
  scale: TradeDeskGridCell;
  optionStop: TradeDeskGridCell;
  underlying: TradeDeskGridCell;
  runner: TradeDeskGridCell;
}

const DASH = '—';

function contractDisplayName(contract: OptionContract | null): string {
  if (!contract) return DASH;
  return `${contract.underlying} ${Format.strike(contract.strike)}${optionTypeShortName(contract.optionType)}`;
}

function firstTarget(presentation: TradeDeskPresentation): PresentedTarget | undefined {
  return presentation.contractTargets[0] ?? presentation.underlyingTargets[0];
}

function runnerTarget(presentation: TradeDeskPresentation): PresentedTarget | undefined {
  const all = [...presentation.contractTargets, ...presentation.underlyingTargets];
  return all.find((target) => target.role === 'runner') ?? all[all.length - 1];
}

/** `action: wait` alone doesn't say enough — a lifecycle-less wait (nothing
 * ever formed) and an extended-setup wait (triggered, ran, too far to chase)
 * both show action `wait` but need distinct execution guidance. Branches on
 * `setupLifecycle` first for exactly this reason; falls back to the
 * generic per-action copy for actions where lifecycle doesn't apply. */
function executionLine(presentation: TradeDeskPresentation): string {
  if (presentation.action === 'wait' || presentation.action === 'avoid') {
    switch (presentation.setupLifecycle) {
      case 'none':
        return 'Wait';
      case 'developing':
        return 'Wait for setup';
      case 'confirmed':
      case 'triggered':
        // By the time this renders, hasValidSetupLifecycleEvidence
        // (validation.ts) has already guaranteed entry+invalidation data
        // exists for these two states — but stay defensive rather than
        // assume: never claim "confirm and enter" without a price to show.
        return presentation.entry?.preferredContractPrice || presentation.entry?.underlying
          ? 'Confirm and enter'
          : 'Wait for setup';
      case 'extended':
        return 'Do not chase';
      case 'completed':
        return 'Setup complete';
      case 'invalidated':
        return 'Setup invalidated';
    }
  }
  switch (presentation.action) {
    case 'enter':
      return presentation.entry?.preferredContractPrice
        ? 'Confirm and enter'
        : 'Wait for confirmation';
    default:
      return DASH;
  }
}

/** Short uppercase label for the SETUP cell's secondary line — 'none'
 * renders nothing (a bare label with no lifecycle badge reads as "no setup"
 * on its own, matching NO_CONFIRMED_SETUP_LABEL's own framing). */
function lifecycleLabel(lifecycle: SetupLifecycle): string | undefined {
  switch (lifecycle) {
    case 'none':
      return undefined;
    case 'developing':
      return 'DEVELOPING';
    case 'confirmed':
      return 'CONFIRMED';
    case 'triggered':
      return 'TRIGGERED';
    case 'extended':
      return 'EXTENDED';
    case 'completed':
      return 'COMPLETED';
    case 'invalidated':
      return 'INVALIDATED';
  }
}

/** Whether the validated plan actually carries contract-premium guidance —
 * the only condition under which the CONTRACT/PREMIUM LIMIT cells may show
 * a contract, distinct from whether a contract merely happens to be
 * selected in the chain. A contract highlighted in the UI is not AI
 * guidance about that contract; see enforceTradeDeskInvariants, which
 * strips these same fields whenever the options quote wasn't valid. */
function hasContractGuidance(presentation: TradeDeskPresentation): boolean {
  return Boolean(presentation.entry?.contract || presentation.entry?.preferredContractPrice);
}

/** Builds the flat-state 8-cell board. `contract` is the currently selected
 * chain contract, used ONLY to render a trader-friendly label for guidance
 * the validated plan already contains — never as a fallback source of
 * guidance itself. When the plan carries no contract-premium data, the
 * CONTRACT/PREMIUM LIMIT cells render `—` regardless of what's selected. */
export function buildFlatTradeDeskAnalysis(
  presentation: TradeDeskPresentation,
  contract: OptionContract | null,
): FlatTradeDeskAnalysis {
  const target = firstTarget(presentation);
  const runner = runnerTarget(presentation);
  const guided = hasContractGuidance(presentation);
  return {
    setup: {
      label: 'SETUP',
      value: presentation.setupLabel || DASH,
      secondary: lifecycleLabel(presentation.setupLifecycle),
    },
    entry: {
      label: 'ENTRY',
      value: presentation.entry?.underlying?.value ?? presentation.entry?.contract?.value ?? DASH,
      secondary: presentation.entry?.preferredContractPrice
        ? `Contract ${presentation.entry.preferredContractPrice.value}`
        : undefined,
    },
    invalidation: {
      label: 'INVALIDATION',
      value: presentation.invalidation?.underlying?.value ?? DASH,
    },
    targets: {
      label: 'TARGETS',
      value: target ? `T1 ${target.value}` : DASH,
      secondary: presentation.underlyingTargets[1]
        ? `T2 ${presentation.underlyingTargets[1].value}`
        : undefined,
    },
    contract: { label: 'CONTRACT', value: guided ? contractDisplayName(contract) : DASH },
    premiumLimit: {
      label: 'PREMIUM LIMIT',
      value: presentation.entry?.preferredContractPrice
        ? `≤ ${presentation.entry.preferredContractPrice.value}`
        : (presentation.entry?.contract?.value ?? DASH),
    },
    execution: { label: 'EXECUTION', value: executionLine(presentation) },
    runner: { label: 'RUNNER', value: runner?.value ?? DASH },
  };
}

/** Builds the in-trade 8-cell board. `position` is the actual open position
 * in the selected contract (never inferred from the AI action). */
export function buildPositionTradeDeskAnalysis(
  presentation: TradeDeskPresentation,
  contract: OptionContract | null,
  position: Position | null,
  underlyingLast: number | null,
): PositionTradeDeskAnalysis {
  const runner = runnerTarget(presentation);
  const target = presentation.contractTargets[0] ?? presentation.underlyingTargets[0];
  return {
    position: {
      label: 'POSITION',
      value: position
        ? `${position.quantity}x ${contractDisplayName(contract)}`
        : contractDisplayName(contract),
      secondary: position
        ? `Avg $${Format.price(position.avgPrice)} · Mark $${Format.price(position.markPrice)}`
        : undefined,
    },
    currentAction: {
      label: 'CURRENT ACTION',
      value: presentation.management.holdConditions[0] ?? presentation.summary ?? DASH,
    },
    invalidation: {
      label: 'INVALIDATION',
      value:
        presentation.invalidation?.contract?.value ??
        presentation.invalidation?.underlying?.value ??
        DASH,
    },
    targets: {
      label: 'TARGETS',
      value: target ? `T1 ${target.value}` : DASH,
      secondary: presentation.contractTargets[1]
        ? `T2 ${presentation.contractTargets[1].value}`
        : undefined,
    },
    scale: {
      label: 'SCALE',
      value: presentation.management.scaleConditions[0] ?? DASH,
    },
    optionStop: {
      label: 'OPTION STOP',
      value: presentation.invalidation?.contract?.value ?? DASH,
    },
    underlying: {
      label: 'UNDERLYING',
      value:
        underlyingLast !== null && contract
          ? `${contract.underlying} ${Format.price(underlyingLast)}`
          : DASH,
    },
    runner: { label: 'RUNNER', value: runner?.value ?? DASH },
  };
}

function unavailableExecutionLine(reason: TradeDeskUnavailableReason | undefined): string {
  switch (reason) {
    case 'invalid-underlying-quote':
      return 'Invalid underlying quote';
    case 'invalid-options-analytics':
      return 'Invalid option data';
    case 'insufficient-data':
      return 'Insufficient data';
    case 'model-unavailable':
      return 'Model unavailable';
    case 'analysis-incomplete':
      return 'Analysis incomplete';
    default:
      return 'Data unavailable';
  }
}

/** Builds the eight-cell board for `status === 'unavailable'` — same fixed
 * shape as the flat/position grids (never a bespoke empty state), every
 * field bounded and dashed except EXECUTION, which carries a short, curated
 * reason. Never renders raw diagnostic text (see AnalysisIneligibilityReason
 * → TradeDeskUnavailableReason mapping in buildTradeDeskViewState). */
export function buildUnavailableTradeDeskAnalysis(
  reason: TradeDeskUnavailableReason | undefined,
): FlatTradeDeskAnalysis {
  return {
    setup: { label: 'SETUP', value: 'Insufficient data' },
    entry: { label: 'ENTRY', value: DASH },
    invalidation: { label: 'INVALIDATION', value: DASH },
    targets: { label: 'TARGETS', value: DASH },
    contract: { label: 'CONTRACT', value: DASH },
    premiumLimit: { label: 'PREMIUM LIMIT', value: DASH },
    execution: { label: 'EXECUTION', value: unavailableExecutionLine(reason) },
    runner: { label: 'RUNNER', value: DASH },
  };
}
