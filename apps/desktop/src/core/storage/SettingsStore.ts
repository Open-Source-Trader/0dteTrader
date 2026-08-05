import type { IndicatorSettings } from '../../features/chart/indicatorSettings';
import { DEFAULT_INDICATOR_SETTINGS } from '../../features/chart/indicatorSettings';
import type { OptionsAnalyticsSettings } from '../../features/chart/optionsAnalytics/optionsAnalyticsSettings';
import {
  decodeOptionsAnalyticsSettings,
  DEFAULT_OPTIONS_ANALYTICS_SETTINGS,
} from '../../features/chart/optionsAnalytics/optionsAnalyticsSettings';
import type { ChartTradingSettings } from '../../features/chart/chartTradingSettings';
import {
  decodeChartTradingSettings,
  DEFAULT_CHART_TRADING_SETTINGS,
} from '../../features/chart/chartTradingSettings';
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
    chartTrading: 'settings.chartTrading.v1',
    riskDisclaimerAccepted: 'settings.riskDisclaimerAccepted',
    serverSelectionCompleted: 'settings.serverSelectionCompleted',
    lastSymbol: 'settings.lastSymbol',
    tradingLocked: 'settings.tradingLocked',
    bypassOrderConfirmation: 'settings.bypassOrderConfirmation',
    keyboardShortcutsEnabled: 'settings.keyboardShortcutsEnabled',
    autoOtmOffset: 'settings.autoOtmOffset',
    toastsEnabled: 'settings.toastsEnabled',
    systemNotificationsEnabled: 'settings.systemNotificationsEnabled',
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

  get chartTrading(): ChartTradingSettings {
    const raw = localStorage.getItem(SettingsStore.keys.chartTrading);
    if (!raw) return DEFAULT_CHART_TRADING_SETTINGS;
    try {
      return decodeChartTradingSettings(JSON.parse(raw));
    } catch {
      return DEFAULT_CHART_TRADING_SETTINGS;
    }
  }

  set chartTrading(value: ChartTradingSettings) {
    localStorage.setItem(SettingsStore.keys.chartTrading, JSON.stringify(value));
  }

  get hasAcceptedRiskDisclaimer(): boolean {
    return localStorage.getItem(SettingsStore.keys.riskDisclaimerAccepted) === 'true';
  }

  set hasAcceptedRiskDisclaimer(value: boolean) {
    localStorage.setItem(SettingsStore.keys.riskDisclaimerAccepted, String(value));
  }

  get hasCompletedServerSelection(): boolean {
    if (localStorage.getItem(SettingsStore.keys.serverSelectionCompleted) === 'true') return true;
    if (!this.hasAcceptedRiskDisclaimer) return false;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || key === SettingsStore.keys.riskDisclaimerAccepted) continue;
      return true;
    }
    return false;
  }

  set hasCompletedServerSelection(value: boolean) {
    localStorage.setItem(SettingsStore.keys.serverSelectionCompleted, String(value));
  }

  /** Trading lock: when true, every order-placing control is disabled. Persists
   *  across launches (the lock is remembered, like the layout choice). */
  get tradingLocked(): boolean {
    return localStorage.getItem(SettingsStore.keys.tradingLocked) === 'true';
  }

  set tradingLocked(value: boolean) {
    localStorage.setItem(SettingsStore.keys.tradingLocked, String(value));
  }

  /** Skip the buy/sell confirmation sheet and submit immediately. Per-device. */
  get bypassOrderConfirmation(): boolean {
    return localStorage.getItem(SettingsStore.keys.bypassOrderConfirmation) === 'true';
  }

  set bypassOrderConfirmation(value: boolean) {
    localStorage.setItem(SettingsStore.keys.bypassOrderConfirmation, String(value));
  }

  /** Desktop-grid trading hotkeys (B/S/L — Cmd+K symbol search is always on,
   *  see useTradeShortcuts). Defaults off: arming a real order from a single
   *  keystroke should be opt-in, not a surprise the first time a trader
   *  types "b" somewhere unexpected. */
  get keyboardShortcutsEnabled(): boolean {
    const stored = localStorage.getItem(SettingsStore.keys.keyboardShortcutsEnabled);
    return stored === null ? false : stored === 'true';
  }

  set keyboardShortcutsEnabled(value: boolean) {
    localStorage.setItem(SettingsStore.keys.keyboardShortcutsEnabled, String(value));
  }

  /** In-app success/info toasts. Error toasts always show regardless. */
  get toastsEnabled(): boolean {
    const stored = localStorage.getItem(SettingsStore.keys.toastsEnabled);
    return stored === null ? true : stored === 'true';
  }

  set toastsEnabled(value: boolean) {
    localStorage.setItem(SettingsStore.keys.toastsEnabled, String(value));
  }

  /** OS notifications for terminal order statuses and chart-order fires,
   *  shown only while the window is unfocused. */
  get systemNotificationsEnabled(): boolean {
    const stored = localStorage.getItem(SettingsStore.keys.systemNotificationsEnabled);
    return stored === null ? true : stored === 'true';
  }

  set systemNotificationsEnabled(value: boolean) {
    localStorage.setItem(SettingsStore.keys.systemNotificationsEnabled, String(value));
  }

  /** AUTO selection: strikes out of the money from the ATM anchor (0 = ATM
   *  itself; the ticket's default is +1). Clamped to 0–10 on read so a stale
   *  or hand-edited value cannot arm an order the server rejects. */
  get autoOtmOffset(): number {
    const raw = localStorage.getItem(SettingsStore.keys.autoOtmOffset);
    const parsed = raw === null ? Number.NaN : Number(raw);
    if (!Number.isInteger(parsed)) return 1;
    return Math.min(10, Math.max(0, parsed));
  }

  set autoOtmOffset(value: number) {
    localStorage.setItem(SettingsStore.keys.autoOtmOffset, String(value));
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
