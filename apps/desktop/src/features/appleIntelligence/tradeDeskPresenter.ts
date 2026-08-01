import type { OptionContract } from '@0dtetrader/shared-types';
import { PRICE_MAX, PRICE_MIN, PRICE_STEP, roundToTick } from '../../core/models/priceInput';
import { Format } from '../../design/format';
import { isResultCurrent } from './stalenessGate';
import type {
  AIAvailability,
  AnalysisContextIdentity,
  AnalysisResult,
  MarketAnalysisState,
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
  errorMessage: string | null;
  currentContext: AnalysisContextIdentity | null;
  selectedContract: OptionContract | null;
  currentPositionVersion: number;
  dismissedResultId?: string | null;
  disabled?: boolean;
  limits?: Partial<TradeDeskPresentationLimits>;
  marketSessionState?: MarketAnalysisState;
}

export function buildTradeDeskViewState(input: BuildTradeDeskViewStateInput): TradeDeskViewState {
  const marketSessionState = input.marketSessionState ?? 'live';
  if (input.disabled) {
    return { status: 'disabled', canApplySuggestedPrice: false, marketSessionState };
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
  const visiblePresentation =
    presentation && presentation.resultId !== input.dismissedResultId ? presentation : undefined;

  if (input.isAnalyzing) {
    return {
      status: 'generating',
      presentation: visiblePresentation,
      generatedAt: visiblePresentation?.resultId ? input.latestResult?.generatedAt : undefined,
      canApplySuggestedPrice: false,
      marketSessionState,
    };
  }

  if (input.errorMessage && !visiblePresentation) {
    return {
      status: 'failed',
      staleReason: input.errorMessage,
      canApplySuggestedPrice: false,
      marketSessionState,
    };
  }

  if (input.availability.state !== 'ready' && input.availability.state !== 'degraded') {
    return {
      status: input.availability.state === 'unavailable' ? 'unavailable' : 'disabled',
      staleReason: 'reason' in input.availability ? input.availability.reason : undefined,
      canApplySuggestedPrice: false,
      marketSessionState,
    };
  }

  if (!visiblePresentation || !input.latestResult) {
    return { status: 'unavailable', canApplySuggestedPrice: false, marketSessionState };
  }

  const isCurrent = input.currentContext
    ? isResultCurrent(input.latestResult.context, input.currentContext)
    : false;

  if (!isCurrent) {
    return {
      status: 'stale',
      presentation: visiblePresentation,
      generatedAt: input.latestResult.generatedAt,
      staleReason: staleReason(input.latestResult.context, input.currentContext),
      canApplySuggestedPrice: false,
      marketSessionState,
    };
  }

  if (input.errorMessage) {
    return {
      status: 'failed',
      presentation: visiblePresentation,
      generatedAt: input.latestResult.generatedAt,
      staleReason: input.errorMessage,
      canApplySuggestedPrice: false,
      marketSessionState,
    };
  }

  // Market-closed data can still be "current" against the staleness gate
  // (identity matches) but must never present as an actionable live entry —
  // downgrade the applicable-price suggestion rather than the result itself.
  const canApplySuggestedPrice =
    marketSessionState === 'live' && Boolean(visiblePresentation.applicablePriceSuggestion);
  return {
    status: 'current',
    presentation: visiblePresentation,
    generatedAt: input.latestResult.generatedAt,
    canApplySuggestedPrice,
    marketSessionState,
  };
}

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
  const action = normalizeAction(
    plan?.action ?? legacyAction(result.recommendation),
    plan?.scaleAdvice,
  );
  const snapshotId = result.context.snapshotId ?? '';
  const contractIdentity = selectedContract?.symbol ?? result.context.selectedContractSymbol ?? '';
  const setupLabel = clampText(
    plan?.setupLabel ?? legacySetupLabel(result),
    limits.maxSetupLabelCharacters,
  );
  const entry = presentEntry(plan?.entry, result, selectedContract);
  const invalidation = presentInvalidation(plan?.invalidation, result);
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
  const management = {
    holdConditions: clampList(
      plan?.management.holdConditions ?? legacyHoldConditions(result),
      limits,
    ),
    scaleConditions: clampList(plan?.management.scaleConditions ?? [], limits),
    exitConditions: clampList(
      plan?.management.exitConditions ?? legacyExitConditions(result),
      limits,
    ),
  };
  const applicablePriceSuggestion = buildApplicableSuggestion({
    result,
    selectedContract,
    currentPositionVersion,
    contractIdentity,
    snapshotId,
  });

  return {
    resultId: result.analysisId,
    snapshotId,
    positionVersion: result.context.positionVersion,
    contractIdentity,
    action,
    actionLabel: actionLabel(action),
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
  result: AnalysisResult,
  selectedContract: OptionContract | null,
): TradeDeskPresentation['entry'] | undefined {
  if (!entry && !result.levels.support && !result.levels.resistance) return undefined;
  const output: NonNullable<TradeDeskPresentation['entry']> = {};
  if (entry?.underlying?.priceDomain === 'underlying') {
    output.underlying = {
      label: 'Underlying',
      value: `${result.context.symbol} ${Format.price(entry.underlying.low)}–${Format.price(entry.underlying.high)}`,
      evidenceId: entry.underlying.evidenceId,
    };
  } else if (result.levels.support) {
    output.underlying = {
      label: 'Underlying',
      value: `${result.context.symbol} ${Format.price(result.levels.support.price)}`,
      evidenceId: result.levels.support.levelId,
    };
  }
  if (entry?.contract?.priceDomain === 'contract-premium') {
    output.contract = {
      label: 'Contract',
      value: `${money(entry.contract.low)}–${money(entry.contract.high)}`,
      evidenceId: entry.contract.evidenceId,
    };
  }
  if (entry?.preferredContractPrice?.priceDomain === 'contract-premium') {
    output.preferredContractPrice = {
      label: selectedContract ? 'Preferred option price' : 'Preferred contract price',
      value: money(entry.preferredContractPrice.value),
      evidenceId: entry.preferredContractPrice.evidenceId,
    };
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function presentInvalidation(
  invalidation: TradeDeskPlan['invalidation'] | undefined,
  result: AnalysisResult,
): TradeDeskPresentation['invalidation'] | undefined {
  if (!invalidation && !result.levels.cutBelow) return undefined;
  const output: NonNullable<TradeDeskPresentation['invalidation']> = {};
  if (invalidation?.underlying) {
    output.underlying = {
      label: 'Invalidation',
      value: `${result.context.symbol} ${invalidation.underlying.operator} ${Format.price(invalidation.underlying.price.value)}`,
      evidenceId: invalidation.underlying.price.evidenceId,
    };
  } else if (result.levels.cutBelow) {
    output.underlying = {
      label: 'Invalidation',
      value: `${result.context.symbol} below ${Format.price(result.levels.cutBelow.price)}`,
      evidenceId: result.levels.cutBelow.levelId,
    };
  }
  if (invalidation?.contract) {
    output.contract = {
      label: 'Contract invalidation',
      value: `Contract ${invalidation.contract.operator} ${money(invalidation.contract.price.value)}`,
      evidenceId: invalidation.contract.price.evidenceId,
    };
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function buildApplicableSuggestion({
  result,
  selectedContract,
  currentPositionVersion,
  contractIdentity,
  snapshotId,
}: {
  result: AnalysisResult;
  selectedContract: OptionContract | null;
  currentPositionVersion: number;
  contractIdentity: string;
  snapshotId: string;
}): ApplicablePriceSuggestion | undefined {
  const preferred = result.tradeDeskPlan?.entry?.preferredContractPrice;
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
  return scaleAdvice?.direction === 'in' ? 'scale_in' : 'scale_out';
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

function clampText(value: string, max: number): string {
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
