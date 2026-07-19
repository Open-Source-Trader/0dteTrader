import type { IndicatorSettings } from '../../features/chart/indicatorSettings';
import { DEFAULT_INDICATOR_SETTINGS } from '../../features/chart/indicatorSettings';
import type { GexSettings } from '../../features/chart/gex/gexSettings';
import { DEFAULT_GEX_SETTINGS } from '../../features/chart/gex/gexSettings';
import type { TwcHeatmapSettings } from '../../features/chart/twc/twcSettings';
import { DEFAULT_TWC_SETTINGS } from '../../features/chart/twc/twcSettings';

export type TradeLayout = 'fullscreen' | 'split';

/** Clamps a persisted number into [min, max]; non-finite values fall back to
 *  the default (hand-edited or version-drifted localStorage stays safe). */
function clampPersisted(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** localStorage-backed app settings (SettingsStore.swift analog). */
export class SettingsStore {
  private static keys = {
    layoutMode: 'settings.layoutMode',
    indicatorSettings: 'settings.indicatorSettings',
    twcSettings: 'settings.twcSettings',
    gexSettings: 'settings.gexSettings',
    riskDisclaimerAccepted: 'settings.riskDisclaimerAccepted',
    lastSymbol: 'settings.lastSymbol',
  };

  get layoutMode(): TradeLayout {
    const stored = localStorage.getItem(SettingsStore.keys.layoutMode);
    return stored === 'fullscreen' || stored === 'split' ? stored : 'split';
  }

  set layoutMode(value: TradeLayout) {
    localStorage.setItem(SettingsStore.keys.layoutMode, value);
  }

  get indicatorSettings(): IndicatorSettings {
    const raw = localStorage.getItem(SettingsStore.keys.indicatorSettings);
    if (!raw) return DEFAULT_INDICATOR_SETTINGS;
    try {
      return { ...DEFAULT_INDICATOR_SETTINGS, ...(JSON.parse(raw) as Partial<IndicatorSettings>) };
    } catch {
      return DEFAULT_INDICATOR_SETTINGS;
    }
  }

  set indicatorSettings(value: IndicatorSettings) {
    localStorage.setItem(SettingsStore.keys.indicatorSettings, JSON.stringify(value));
  }

  get twcSettings(): TwcHeatmapSettings {
    const raw = localStorage.getItem(SettingsStore.keys.twcSettings);
    if (!raw) return DEFAULT_TWC_SETTINGS;
    try {
      return { ...DEFAULT_TWC_SETTINGS, ...(JSON.parse(raw) as Partial<TwcHeatmapSettings>) };
    } catch {
      return DEFAULT_TWC_SETTINGS;
    }
  }

  set twcSettings(value: TwcHeatmapSettings) {
    localStorage.setItem(SettingsStore.keys.twcSettings, JSON.stringify(value));
  }

  get gexSettings(): GexSettings {
    const raw = localStorage.getItem(SettingsStore.keys.gexSettings);
    if (!raw) return DEFAULT_GEX_SETTINGS;
    try {
      const parsed = { ...DEFAULT_GEX_SETTINGS, ...(JSON.parse(raw) as Partial<GexSettings>) };
      // Persisted values are user-editable: validate ranges so a corrupt
      // entry can't create a tight poll loop or break the overlay.
      return {
        ...parsed,
        refreshSeconds: clampPersisted(parsed.refreshSeconds, 15, 120, DEFAULT_GEX_SETTINGS.refreshSeconds),
        maxPremiumStrikes: clampPersisted(parsed.maxPremiumStrikes, 3, 10, DEFAULT_GEX_SETTINGS.maxPremiumStrikes),
        opacityCap: Number.isFinite(parsed.opacityCap)
          ? Math.min(0.8, Math.max(0.2, parsed.opacityCap))
          : DEFAULT_GEX_SETTINGS.opacityCap,
      };
    } catch {
      return DEFAULT_GEX_SETTINGS;
    }
  }

  set gexSettings(value: GexSettings) {
    localStorage.setItem(SettingsStore.keys.gexSettings, JSON.stringify(value));
  }

  get hasAcceptedRiskDisclaimer(): boolean {
    return localStorage.getItem(SettingsStore.keys.riskDisclaimerAccepted) === 'true';
  }

  set hasAcceptedRiskDisclaimer(value: boolean) {
    localStorage.setItem(SettingsStore.keys.riskDisclaimerAccepted, String(value));
  }

  get lastSymbol(): string | null {
    return localStorage.getItem(SettingsStore.keys.lastSymbol);
  }

  set lastSymbol(value: string | null) {
    if (value === null) {
      localStorage.removeItem(SettingsStore.keys.lastSymbol);
    } else {
      localStorage.setItem(SettingsStore.keys.lastSymbol, value);
    }
  }
}
