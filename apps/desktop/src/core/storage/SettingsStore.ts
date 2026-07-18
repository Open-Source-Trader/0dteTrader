import type { IndicatorSettings } from '../../features/chart/indicatorSettings';
import { DEFAULT_INDICATOR_SETTINGS } from '../../features/chart/indicatorSettings';

export type TradeLayout = 'fullscreen' | 'split';

/** localStorage-backed app settings (SettingsStore.swift analog). */
export class SettingsStore {
  private static keys = {
    layoutMode: 'settings.layoutMode',
    splitFraction: 'settings.splitFraction',
    indicatorSettings: 'settings.indicatorSettings',
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

  /** Trade panel height as a fraction of screen height, clamped so the panel always fits the trade ticket (floor 0.34, ceiling 1/2). */
  get splitFraction(): number {
    const stored = Number(localStorage.getItem(SettingsStore.keys.splitFraction));
    if (!Number.isFinite(stored) || stored <= 0) return 0.38;
    return Math.min(0.5, Math.max(0.34, stored));
  }

  set splitFraction(value: number) {
    localStorage.setItem(SettingsStore.keys.splitFraction, String(value));
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
