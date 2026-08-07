import type {
  ChartDisplayPreferences,
  IndicatorId,
  IndicatorSetting,
  IndicatorSettingsState,
} from '@0dtetrader/shared-types';
import {
  DEFAULT_CHART_DISPLAY,
  DEFAULT_INDICATOR_SETTINGS_STATE,
  validateIndicatorSettingsState,
} from '../../features/chart/indicatorRegistry';
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
import type { UsrSettings } from '../../features/chart/ultimateSupportResistance/usrSettings';
import {
  decodeUsrSettings,
  DEFAULT_USR_SETTINGS,
} from '../../features/chart/ultimateSupportResistance/usrSettings';

export type TradeLayout = 'fullscreen' | 'split';

/** 'termStructure': strike x expiration, latest snapshot per expiration.
 *  'timeSeries': strike x timestamp, one expiration over its capture history. */
export type GexHeatmapViewMode = 'termStructure' | 'timeSeries';

/** localStorage-backed app settings (SettingsStore.swift analog). */
export class SettingsStore {
  private static keys = {
    layoutMode: 'settings.layoutMode',
    legacyIndicatorSettings: 'settings.indicatorSettings',
    indicatorSettings: 'settings.indicatorSettings.v1',
    chartDisplay: 'settings.chartDisplay.v1',
    twcSettings: 'settings.twcSettings',
    usrSettings: 'settings.ultimateSupportResistance.v1',
    optionsAnalytics: 'settings.optionsAnalytics.v1',
    chartTrading: 'settings.chartTrading.v1',
    riskDisclaimerAccepted: 'settings.riskDisclaimerAccepted',
    serverSelectionCompleted: 'settings.serverSelectionCompleted',
    lastSymbol: 'settings.lastSymbol',
    tradingLocked: 'settings.tradingLocked',
    bypassOrderConfirmation: 'settings.bypassOrderConfirmation',
    keyboardShortcutsEnabled: 'settings.keyboardShortcutsEnabled',
    toastsEnabled: 'settings.toastsEnabled',
    systemNotificationsEnabled: 'settings.systemNotificationsEnabled',
    gexHeatmapView: 'settings.gexHeatmapView',
  };

  get layoutMode(): TradeLayout {
    const stored = localStorage.getItem(SettingsStore.keys.layoutMode);
    return stored === 'fullscreen' || stored === 'split' ? stored : 'split';
  }

  set layoutMode(value: TradeLayout) {
    localStorage.setItem(SettingsStore.keys.layoutMode, value);
  }

  /** Term structure is the default: it matches the reference implementation
   *  this feature was modeled on. */
  get gexHeatmapView(): GexHeatmapViewMode {
    const stored = localStorage.getItem(SettingsStore.keys.gexHeatmapView);
    return stored === 'timeSeries' ? 'timeSeries' : 'termStructure';
  }

  set gexHeatmapView(value: GexHeatmapViewMode) {
    localStorage.setItem(SettingsStore.keys.gexHeatmapView, value);
  }

  get indicatorSettings(): IndicatorSettingsState {
    this.ensureIndicatorMigration();
    const raw = localStorage.getItem(SettingsStore.keys.indicatorSettings);
    if (!raw) return structuredClone(DEFAULT_INDICATOR_SETTINGS_STATE);
    try {
      return validateIndicatorSettingsState(JSON.parse(raw), DEFAULT_INDICATOR_SETTINGS_STATE)
        .value;
    } catch {
      return structuredClone(DEFAULT_INDICATOR_SETTINGS_STATE);
    }
  }

  set indicatorSettings(value: IndicatorSettingsState) {
    const result = validateIndicatorSettingsState(value, DEFAULT_INDICATOR_SETTINGS_STATE);
    if (!result.ok) throw new Error(result.error);
    localStorage.setItem(SettingsStore.keys.indicatorSettings, JSON.stringify(result.value));
  }

  get chartDisplay(): ChartDisplayPreferences {
    this.ensureIndicatorMigration();
    return this.readChartDisplay();
  }

  set chartDisplay(value: ChartDisplayPreferences) {
    if (typeof value.volumeEnabled !== 'boolean') throw new Error('Volume display is invalid.');
    if (typeof value.volumeWeightedCandleWidth !== 'boolean') {
      throw new Error('Volume-weighted candle width display is invalid.');
    }
    localStorage.setItem(SettingsStore.keys.chartDisplay, JSON.stringify(value));
  }

  private readChartDisplay(): ChartDisplayPreferences {
    const raw = localStorage.getItem(SettingsStore.keys.chartDisplay);
    if (!raw) return { ...DEFAULT_CHART_DISPLAY };
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (typeof value.volumeEnabled !== 'boolean') return { ...DEFAULT_CHART_DISPLAY };
      return {
        volumeEnabled: value.volumeEnabled,
        volumeWeightedCandleWidth:
          typeof value.volumeWeightedCandleWidth === 'boolean'
            ? value.volumeWeightedCandleWidth
            : DEFAULT_CHART_DISPLAY.volumeWeightedCandleWidth,
      };
    } catch {
      return { ...DEFAULT_CHART_DISPLAY };
    }
  }

  private ensureIndicatorMigration(): void {
    const current = localStorage.getItem(SettingsStore.keys.indicatorSettings);
    const legacyRaw = localStorage.getItem(SettingsStore.keys.legacyIndicatorSettings);
    if (current) {
      try {
        const validCurrent = validateIndicatorSettingsState(
          JSON.parse(current),
          DEFAULT_INDICATOR_SETTINGS_STATE,
        ).ok;
        if (validCurrent) {
          let displayValid = false;
          try {
            const displayRaw = localStorage.getItem(SettingsStore.keys.chartDisplay);
            if (displayRaw) {
              const display = JSON.parse(displayRaw) as Record<string, unknown>;
              displayValid = typeof display.volumeEnabled === 'boolean';
            }
          } catch {
            displayValid = false;
          }
          if (!displayValid) {
            try {
              localStorage.setItem(
                SettingsStore.keys.chartDisplay,
                JSON.stringify(DEFAULT_CHART_DISPLAY),
              );
              const repaired = JSON.parse(
                localStorage.getItem(SettingsStore.keys.chartDisplay) ?? 'null',
              ) as Record<string, unknown> | null;
              if (repaired?.volumeEnabled !== DEFAULT_CHART_DISPLAY.volumeEnabled) return;
            } catch {
              // Preserve both the valid keyed record and legacy residue for a later retry.
              return;
            }
          }
          if (legacyRaw) localStorage.removeItem(SettingsStore.keys.legacyIndicatorSettings);
          return;
        }
      } catch {
        // A corrupt current record may still be recoverable from the legacy record.
      }
    }
    if (!legacyRaw) return;
    let legacy: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(legacyRaw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      legacy = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const recognized = new Set([
      'smaEnabled',
      'smaPeriod',
      'emaEnabled',
      'emaPeriod',
      'vwapEnabled',
      'rsiEnabled',
      'rsiPeriod',
      'macdEnabled',
      'macdFastPeriod',
      'macdSlowPeriod',
      'macdSignalPeriod',
      'bollingerEnabled',
      'bollingerPeriod',
      'bollingerMultiplier',
      'stochEnabled',
      'stochKPeriod',
      'stochKSmooth',
      'stochDPeriod',
      'atrEnabled',
      'atrPeriod',
      'volumeEnabled',
    ]);
    if (!Object.keys(legacy).some((key) => recognized.has(key))) return;

    const candidate = structuredClone(DEFAULT_INDICATOR_SETTINGS_STATE);
    const bool = (key: string, fallback: boolean): boolean | unknown => legacy[key] ?? fallback;
    const num = (key: string, fallback: number): number | unknown => legacy[key] ?? fallback;
    const set = (
      id: IndicatorId,
      enabledKey: string | null,
      parameterMap: Record<string, string>,
    ) => {
      const defaults = candidate.indicators[id];
      candidate.indicators[id] = {
        enabled: (enabledKey ? bool(enabledKey, defaults.enabled) : defaults.enabled) as boolean,
        parameters: Object.fromEntries(
          Object.entries(defaults.parameters).map(([parameterId, fallback]) => [
            parameterId,
            parameterMap[parameterId] ? num(parameterMap[parameterId], fallback) : fallback,
          ]),
        ) as Record<string, number>,
      } as IndicatorSetting;
    };
    set('sma', 'smaEnabled', { period: 'smaPeriod' });
    set('ema', 'emaEnabled', { period: 'emaPeriod' });
    set('anchored_vwap', 'vwapEnabled', {});
    set('rsi', 'rsiEnabled', { period: 'rsiPeriod' });
    set('macd', 'macdEnabled', {
      fastPeriod: 'macdFastPeriod',
      slowPeriod: 'macdSlowPeriod',
      signalPeriod: 'macdSignalPeriod',
    });
    set('bollinger', 'bollingerEnabled', {
      period: 'bollingerPeriod',
      multiplier: 'bollingerMultiplier',
    });
    set('stochastic', 'stochEnabled', {
      kPeriod: 'stochKPeriod',
      kSmooth: 'stochKSmooth',
      dPeriod: 'stochDPeriod',
    });
    set('atr', 'atrEnabled', { period: 'atrPeriod' });
    const validated = validateIndicatorSettingsState(candidate, DEFAULT_INDICATOR_SETTINGS_STATE);
    const volumeEnabled = bool('volumeEnabled', DEFAULT_CHART_DISPLAY.volumeEnabled);
    if (!validated.ok || typeof volumeEnabled !== 'boolean') return;
    const chartDisplay = { volumeEnabled };

    const previousSettings = localStorage.getItem(SettingsStore.keys.indicatorSettings);
    const previousDisplay = localStorage.getItem(SettingsStore.keys.chartDisplay);
    try {
      localStorage.setItem(SettingsStore.keys.indicatorSettings, JSON.stringify(validated.value));
      localStorage.setItem(SettingsStore.keys.chartDisplay, JSON.stringify(chartDisplay));
      const rereadSettings = localStorage.getItem(SettingsStore.keys.indicatorSettings);
      const rereadDisplay = localStorage.getItem(SettingsStore.keys.chartDisplay);
      if (
        !rereadSettings ||
        !validateIndicatorSettingsState(
          JSON.parse(rereadSettings),
          DEFAULT_INDICATOR_SETTINGS_STATE,
        ).ok ||
        !rereadDisplay ||
        (JSON.parse(rereadDisplay) as { volumeEnabled?: unknown }).volumeEnabled !== volumeEnabled
      ) {
        throw new Error('Indicator settings migration verification failed.');
      }
      localStorage.removeItem(SettingsStore.keys.legacyIndicatorSettings);
    } catch {
      if (previousSettings === null) localStorage.removeItem(SettingsStore.keys.indicatorSettings);
      else localStorage.setItem(SettingsStore.keys.indicatorSettings, previousSettings);
      if (previousDisplay === null) localStorage.removeItem(SettingsStore.keys.chartDisplay);
      else localStorage.setItem(SettingsStore.keys.chartDisplay, previousDisplay);
    }
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

  get usrSettings(): UsrSettings {
    const raw = localStorage.getItem(SettingsStore.keys.usrSettings);
    if (!raw) return { ...DEFAULT_USR_SETTINGS };
    try {
      return decodeUsrSettings(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_USR_SETTINGS };
    }
  }

  set usrSettings(value: UsrSettings) {
    localStorage.setItem(SettingsStore.keys.usrSettings, JSON.stringify(decodeUsrSettings(value)));
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
