import type { IndicatorSettings } from '../../features/chart/indicatorSettings';
import { DEFAULT_INDICATOR_SETTINGS } from '../../features/chart/indicatorSettings';
import type { OptionsAnalyticsSettings } from '../../features/chart/optionsAnalytics/optionsAnalyticsSettings';
import {
  decodeOptionsAnalyticsSettings,
  DEFAULT_OPTIONS_ANALYTICS_SETTINGS,
} from '../../features/chart/optionsAnalytics/optionsAnalyticsSettings';
import type { TwcHeatmapSettings } from '../../features/chart/twc/twcSettings';
import { DEFAULT_TWC_SETTINGS } from '../../features/chart/twc/twcSettings';

export type TradeLayout = 'fullscreen' | 'split';

/** localStorage-backed app settings (SettingsStore.swift analog). */
export class SettingsStore {
  private static keys = {
    layoutMode: 'settings.layoutMode',
    indicatorSettings: 'settings.indicatorSettings',
    twcSettings: 'settings.twcSettings',
    optionsAnalytics: 'settings.optionsAnalytics.v1',
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

  get optionsAnalytics(): OptionsAnalyticsSettings {
    const raw = localStorage.getItem(SettingsStore.keys.optionsAnalytics);
    if (!raw) return DEFAULT_OPTIONS_ANALYTICS_SETTINGS;
    try {
      return decodeOptionsAnalyticsSettings(JSON.parse(raw));
    } catch {
      return DEFAULT_OPTIONS_ANALYTICS_SETTINGS;
    }
  }

  set optionsAnalytics(value: OptionsAnalyticsSettings) {
    localStorage.setItem(SettingsStore.keys.optionsAnalytics, JSON.stringify(value));
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
