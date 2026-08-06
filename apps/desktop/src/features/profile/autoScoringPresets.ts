import type {
  AutoScoringPreferenceRecord,
  AutoScoringPreferenceUpdate,
  AutoScoringPreset,
} from '@0dtetrader/shared-types';

const PRESETS = {
  conservative: {
    targetAbsDelta: 0.25,
    strikeRungs: 5,
    maxSpreadBps: 500,
    maxPremiumDollars: 250,
    minOpenInterest: 100,
    gammaMode: 'avoid',
    deltaWeight: 0.3,
    spreadWeight: 0.25,
    openInterestWeight: 0.2,
    gammaWeight: 0.1,
    ivWeight: 0.15,
  },
  aggressive: {
    targetAbsDelta: 0.4,
    strikeRungs: 8,
    maxSpreadBps: 1_000,
    maxPremiumDollars: 500,
    minOpenInterest: 25,
    gammaMode: 'seek',
    deltaWeight: 0.25,
    spreadWeight: 0.15,
    openInterestWeight: 0.15,
    gammaWeight: 0.3,
    ivWeight: 0.15,
  },
} as const;

export function autoScoringPresetUpdate(
  preset: Exclude<AutoScoringPreset, 'custom'>,
  current: AutoScoringPreferenceRecord,
): AutoScoringPreferenceUpdate {
  return {
    schemaVersion: 1,
    preset,
    ...PRESETS[preset],
    expectedUpdatedAt: current.updatedAt,
  };
}

export function customAutoScoringUpdate(
  current: AutoScoringPreferenceRecord,
): AutoScoringPreferenceUpdate | null {
  const weights = [
    current.deltaWeight,
    current.spreadWeight,
    current.openInterestWeight,
    current.gammaWeight,
    current.ivWeight,
  ];
  const valid =
    Number.isFinite(current.targetAbsDelta) &&
    current.targetAbsDelta >= 0.01 &&
    current.targetAbsDelta <= 0.99 &&
    Number.isInteger(current.strikeRungs) &&
    current.strikeRungs >= 0 &&
    current.strikeRungs <= 20 &&
    Number.isFinite(current.maxSpreadBps) &&
    current.maxSpreadBps >= 0 &&
    current.maxSpreadBps <= 10_000 &&
    Number.isFinite(current.maxPremiumDollars) &&
    current.maxPremiumDollars > 0 &&
    current.maxPremiumDollars <= 1_000_000 &&
    Number.isInteger(current.minOpenInterest) &&
    current.minOpenInterest >= 0 &&
    current.minOpenInterest <= 1_000_000_000 &&
    weights.every((weight) => Number.isFinite(weight) && weight >= 0 && weight <= 1) &&
    weights.reduce((sum, weight) => sum + weight, 0) > 0;
  if (!valid) return null;
  return {
    schemaVersion: 1,
    preset: 'custom',
    targetAbsDelta: current.targetAbsDelta,
    strikeRungs: current.strikeRungs,
    maxSpreadBps: current.maxSpreadBps,
    maxPremiumDollars: current.maxPremiumDollars,
    minOpenInterest: current.minOpenInterest,
    gammaMode: current.gammaMode,
    deltaWeight: current.deltaWeight,
    spreadWeight: current.spreadWeight,
    openInterestWeight: current.openInterestWeight,
    gammaWeight: current.gammaWeight,
    ivWeight: current.ivWeight,
    expectedUpdatedAt: current.updatedAt,
  };
}
