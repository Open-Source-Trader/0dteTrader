export interface OptionsAnalyticsSettings {
  enabled: boolean;
  showImpliedRange: boolean;
  showGammaProfile: boolean;
  showMarkedOi: boolean;
  showLiquidity: boolean;
  showDealerProxy: boolean;
  refreshSeconds: number;
  profileStrikeCount: number;
  /** Show the diagnostics/quality box (provenance + warnings). The structure
   *  drawing is independent and always renders when enabled. */
  showDiagnostics: boolean;
}

export const DEFAULT_OPTIONS_ANALYTICS_SETTINGS: OptionsAnalyticsSettings = {
  enabled: true,
  showImpliedRange: true,
  showGammaProfile: true,
  showMarkedOi: false,
  showLiquidity: false,
  showDealerProxy: false,
  refreshSeconds: 45,
  profileStrikeCount: 12,
  showDiagnostics: true,
};

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Decodes hand-editable persisted settings without accepting coerced values. */
export function decodeOptionsAnalyticsSettings(value: unknown): OptionsAnalyticsSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return DEFAULT_OPTIONS_ANALYTICS_SETTINGS;
  }
  const record = value as Record<string, unknown>;
  const defaults = DEFAULT_OPTIONS_ANALYTICS_SETTINGS;
  return {
    enabled: booleanValue(record.enabled, defaults.enabled),
    showImpliedRange: booleanValue(record.showImpliedRange, defaults.showImpliedRange),
    showGammaProfile: booleanValue(record.showGammaProfile, defaults.showGammaProfile),
    showMarkedOi: booleanValue(record.showMarkedOi, defaults.showMarkedOi),
    showLiquidity: booleanValue(record.showLiquidity, defaults.showLiquidity),
    showDealerProxy: booleanValue(record.showDealerProxy, defaults.showDealerProxy),
    refreshSeconds: boundedInteger(record.refreshSeconds, 15, 120, defaults.refreshSeconds),
    profileStrikeCount: boundedInteger(
      record.profileStrikeCount,
      3,
      20,
      defaults.profileStrikeCount,
    ),
    showDiagnostics: booleanValue(record.showDiagnostics, defaults.showDiagnostics),
  };
}
