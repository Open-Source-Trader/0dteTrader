import { isValidScriptColor } from '../scriptOverlayTypes';
import { parseUsrTimeframeValue } from './usrTimeframe';

export type UsrAnalysisTimeframe =
  'chart' | 'auto' | '4h' | '1d' | '3d' | '1w' | '2w' | '1m' | 'custom';

export type UsrFvgFillMode = 'touch' | 'close' | 'ce' | 'percent';

export interface UsrSettings {
  enabled: boolean;
  enableProximityFilter: boolean;
  proximityPercent: number;
  maxSupportLevels: number;
  maxResistanceLevels: number;
  showLiquidityPools: boolean;
  showFvg: boolean;
  analysisTimeframe: UsrAnalysisTimeframe;
  customTimeframe: string;
  showConfluence: boolean;
  enableSrFlip: boolean;
  showBounceSignals: boolean;
  showSweepSignals: boolean;
  signalRequireQualification: boolean;
  requireConfirmationCandleDirection: boolean;
  cancelOpposingSignal: boolean;
  maxRecentSignalsTotal: number;
  volumeLookback: number;
  minimumRelativeVolume: number;
  minimumVolumeZScore: number;
  sessionAwareVolume: boolean;
  maxSequenceLength: number;
  displacementBodyPercent: number;
  displacementAtrMultiplier: number;
  structureLookback: number;
  pivotLeftBars: number;
  pivotRightBars: number;
  orderBlockUseWicks: boolean;
  gapAtrMultiplier: number;
  requirePriceVoidGaps: boolean;
  breakBufferTicks: number;
  zoneMitigationPercent: number;
  minimumTick: number;
  showFlippedOrigins: boolean;
  showAllBrokenLevels: boolean;
  hidePooledLines: boolean;
  poolClusterThreshold: number;
  poolAtrFactor: number;
  maxSupportPools: number;
  maxResistancePools: number;
  showIfvg: boolean;
  showFvgCe: boolean;
  showFvgLabels: boolean;
  fvgFillMode: UsrFvgFillMode;
  fvgFillPercent: number;
  fvgLookback: number;
  fvgBodyPercent: number;
  fvgWickPercent: number;
  maxVisibleFvgs: number;
  fvgMaxBarsActive: number;
  fvgMinGapAtr: number;
  fvgMinBodyAtr: number;
  fvgBullishColor: string;
  fvgBearishColor: string;
  fvgCeColor: string;
  ifvgBullishColor: string;
  ifvgBearishColor: string;
}

export const DEFAULT_USR_SETTINGS: UsrSettings = {
  enabled: false,
  enableProximityFilter: true,
  proximityPercent: 5,
  maxSupportLevels: 125,
  maxResistanceLevels: 125,
  showLiquidityPools: true,
  showFvg: true,
  analysisTimeframe: 'chart',
  customTimeframe: '60',
  showConfluence: false,
  enableSrFlip: true,
  showBounceSignals: false,
  showSweepSignals: false,
  signalRequireQualification: true,
  requireConfirmationCandleDirection: true,
  cancelOpposingSignal: true,
  maxRecentSignalsTotal: 20,
  volumeLookback: 30,
  minimumRelativeVolume: 1.2,
  minimumVolumeZScore: 0.5,
  sessionAwareVolume: true,
  maxSequenceLength: 12,
  displacementBodyPercent: 60,
  displacementAtrMultiplier: 0.6,
  structureLookback: 5,
  pivotLeftBars: 3,
  pivotRightBars: 1,
  orderBlockUseWicks: false,
  gapAtrMultiplier: 0.3,
  requirePriceVoidGaps: true,
  breakBufferTicks: 1,
  zoneMitigationPercent: 0.95,
  // TradingView supplies syminfo.mintick. The app's candle contract does not,
  // so the equivalent value is explicit and user-correctable.
  minimumTick: 0.01,
  showFlippedOrigins: true,
  showAllBrokenLevels: false,
  hidePooledLines: true,
  poolClusterThreshold: 3,
  poolAtrFactor: 2.5,
  maxSupportPools: 30,
  maxResistancePools: 30,
  showIfvg: true,
  showFvgCe: true,
  showFvgLabels: false,
  fvgFillMode: 'ce',
  fvgFillPercent: 50,
  fvgLookback: 10,
  fvgBodyPercent: 0.36,
  fvgWickPercent: 0.5,
  maxVisibleFvgs: 5,
  fvgMaxBarsActive: 200,
  fvgMinGapAtr: 0.05,
  fvgMinBodyAtr: 0.5,
  fvgBullishColor: 'rgba(1, 199, 31, 0.15)',
  fvgBearishColor: 'rgba(216, 0, 0, 0.15)',
  fvgCeColor: 'rgba(255, 235, 59, 0.30)',
  ifvgBullishColor: 'rgba(255, 152, 0, 0.15)',
  ifvgBearishColor: 'rgba(156, 39, 176, 0.15)',
};

export type UsrNumberBounds = { minimum: number; maximum: number; integer?: boolean };

export const USR_NUMBER_BOUNDS: Record<keyof UsrSettings, UsrNumberBounds | undefined> = {
  enabled: undefined,
  enableProximityFilter: undefined,
  proximityPercent: { minimum: 1, maximum: 50 },
  maxSupportLevels: { minimum: 1, maximum: 500, integer: true },
  maxResistanceLevels: { minimum: 1, maximum: 500, integer: true },
  showLiquidityPools: undefined,
  showFvg: undefined,
  analysisTimeframe: undefined,
  customTimeframe: undefined,
  showConfluence: undefined,
  enableSrFlip: undefined,
  showBounceSignals: undefined,
  showSweepSignals: undefined,
  signalRequireQualification: undefined,
  requireConfirmationCandleDirection: undefined,
  cancelOpposingSignal: undefined,
  maxRecentSignalsTotal: { minimum: 5, maximum: 100, integer: true },
  volumeLookback: { minimum: 10, maximum: 200, integer: true },
  minimumRelativeVolume: { minimum: 1, maximum: 5 },
  minimumVolumeZScore: { minimum: 0, maximum: 5 },
  sessionAwareVolume: undefined,
  maxSequenceLength: { minimum: 2, maximum: 50, integer: true },
  displacementBodyPercent: { minimum: 40, maximum: 95 },
  displacementAtrMultiplier: { minimum: 0.2, maximum: 3 },
  structureLookback: { minimum: 2, maximum: 20, integer: true },
  pivotLeftBars: { minimum: 1, maximum: 10, integer: true },
  pivotRightBars: { minimum: 1, maximum: 5, integer: true },
  orderBlockUseWicks: undefined,
  gapAtrMultiplier: { minimum: 0.05, maximum: 3 },
  requirePriceVoidGaps: undefined,
  breakBufferTicks: { minimum: 1, maximum: 20, integer: true },
  zoneMitigationPercent: { minimum: 0.5, maximum: 1 },
  minimumTick: { minimum: 0.000_001, maximum: 100 },
  showFlippedOrigins: undefined,
  showAllBrokenLevels: undefined,
  hidePooledLines: undefined,
  poolClusterThreshold: { minimum: 2, maximum: 10, integer: true },
  poolAtrFactor: { minimum: 1, maximum: 5 },
  maxSupportPools: { minimum: 1, maximum: 60, integer: true },
  maxResistancePools: { minimum: 1, maximum: 60, integer: true },
  showIfvg: undefined,
  showFvgCe: undefined,
  showFvgLabels: undefined,
  fvgFillMode: undefined,
  fvgFillPercent: { minimum: 10, maximum: 100 },
  fvgLookback: { minimum: 3, maximum: 50, integer: true },
  fvgBodyPercent: { minimum: 0.05, maximum: 3 },
  fvgWickPercent: { minimum: 0, maximum: 2 },
  maxVisibleFvgs: { minimum: 1, maximum: 15, integer: true },
  fvgMaxBarsActive: { minimum: 10, maximum: 500, integer: true },
  fvgMinGapAtr: { minimum: 0, maximum: 1 },
  fvgMinBodyAtr: { minimum: 0, maximum: 3 },
  fvgBullishColor: undefined,
  fvgBearishColor: undefined,
  fvgCeColor: undefined,
  ifvgBullishColor: undefined,
  ifvgBearishColor: undefined,
};

const ANALYSIS_TIMEFRAMES = new Set<UsrAnalysisTimeframe>([
  'chart',
  'auto',
  '4h',
  '1d',
  '3d',
  '1w',
  '2w',
  '1m',
  'custom',
]);
const FVG_FILL_MODES = new Set<UsrFvgFillMode>(['touch', 'close', 'ce', 'percent']);

export function validateUsrSettings(candidate: unknown): UsrSettings {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Ultimate S/R settings must be an object.');
  }
  const value = candidate as Record<string, unknown>;
  const expected = Object.keys(DEFAULT_USR_SETTINGS);
  if (Object.keys(value).some((key) => !expected.includes(key))) {
    throw new Error('Ultimate S/R settings contain an unknown field.');
  }
  const merged = { ...DEFAULT_USR_SETTINGS, ...value } as UsrSettings;
  for (const key of expected as Array<keyof UsrSettings>) {
    const defaultValue = DEFAULT_USR_SETTINGS[key];
    const field = merged[key];
    const bounds = USR_NUMBER_BOUNDS[key];
    if (bounds) {
      if (
        typeof field !== 'number' ||
        !Number.isFinite(field) ||
        field < bounds.minimum ||
        field > bounds.maximum ||
        (bounds.integer === true && !Number.isInteger(field))
      ) {
        throw new Error(`Ultimate S/R setting ${key} is invalid.`);
      }
    } else if (typeof defaultValue === 'boolean' && typeof field !== 'boolean') {
      throw new Error(`Ultimate S/R setting ${key} must be boolean.`);
    }
  }
  if (!ANALYSIS_TIMEFRAMES.has(merged.analysisTimeframe)) {
    throw new Error('Ultimate S/R analysis timeframe is invalid.');
  }
  if (
    typeof merged.customTimeframe !== 'string' ||
    !parseUsrTimeframeValue(merged.customTimeframe)
  ) {
    throw new Error('Ultimate S/R custom timeframe is invalid.');
  }
  if (!FVG_FILL_MODES.has(merged.fvgFillMode)) {
    throw new Error('Ultimate S/R FVG fill mode is invalid.');
  }
  for (const color of [
    merged.fvgBullishColor,
    merged.fvgBearishColor,
    merged.fvgCeColor,
    merged.ifvgBullishColor,
    merged.ifvgBearishColor,
  ]) {
    if (typeof color !== 'string' || !isValidScriptColor(color)) {
      throw new Error('Ultimate S/R color is invalid.');
    }
  }
  return merged;
}

export function decodeUsrSettings(candidate: unknown): UsrSettings {
  return validateUsrSettings(candidate);
}
