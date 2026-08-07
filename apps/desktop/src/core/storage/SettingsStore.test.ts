import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore } from './SettingsStore';
import {
  DEFAULT_CHART_DISPLAY,
  DEFAULT_INDICATOR_SETTINGS_STATE,
} from '../../features/chart/indicatorRegistry';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('SettingsStore indicator registry migration', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it('maps the exact legacy flat fields, separates volume, and removes residue', () => {
    localStorage.setItem(
      'settings.indicatorSettings',
      JSON.stringify({
        smaEnabled: true,
        smaPeriod: 7,
        emaEnabled: false,
        vwapEnabled: false,
        rsiPeriod: 9,
        macdFastPeriod: 4,
        macdSlowPeriod: 8,
        macdSignalPeriod: 3,
        bollingerMultiplier: 2.5,
        stochKPeriod: 10,
        stochKSmooth: 2,
        stochDPeriod: 4,
        atrEnabled: true,
        atrPeriod: 5,
        volumeEnabled: false,
        discardedDesktopField: 99,
      }),
    );

    const store = new SettingsStore();
    expect(store.indicatorSettings.indicators.sma).toEqual({
      enabled: true,
      parameters: { period: 7 },
    });
    expect(store.indicatorSettings.indicators.anchored_vwap).toEqual({
      enabled: false,
      parameters: { anchorTimestamp: 0 },
    });
    expect(store.indicatorSettings.indicators.macd.parameters).toEqual({
      fastPeriod: 4,
      slowPeriod: 8,
      signalPeriod: 3,
    });
    expect(store.indicatorSettings.indicators.atr).toEqual({
      enabled: true,
      parameters: { period: 5 },
    });
    expect(store.chartDisplay).toEqual({ volumeEnabled: false, volumeWeightedCandleWidth: false });
    expect(localStorage.getItem('settings.indicatorSettings')).toBeNull();
    expect(localStorage.getItem('settings.indicatorSettings.v1')).not.toContain(
      'discardedDesktopField',
    );
  });

  it('is idempotent and removes legacy residue after re-reading valid new records', () => {
    const store = new SettingsStore();
    store.indicatorSettings = DEFAULT_INDICATOR_SETTINGS_STATE;
    store.chartDisplay = { volumeEnabled: false, volumeWeightedCandleWidth: false };
    localStorage.setItem('settings.indicatorSettings', JSON.stringify({ emaEnabled: false }));

    expect(new SettingsStore().indicatorSettings).toEqual(DEFAULT_INDICATOR_SETTINGS_STATE);
    expect(new SettingsStore().chartDisplay).toEqual({
      volumeEnabled: false,
      volumeWeightedCandleWidth: false,
    });
    expect(localStorage.getItem('settings.indicatorSettings')).toBeNull();
  });

  it('round-trips volumeWeightedCandleWidth through get/set chartDisplay', () => {
    const store = new SettingsStore();
    store.chartDisplay = { volumeEnabled: true, volumeWeightedCandleWidth: true };
    expect(store.chartDisplay).toEqual({ volumeEnabled: true, volumeWeightedCandleWidth: true });
    expect(new SettingsStore().chartDisplay).toEqual({
      volumeEnabled: true,
      volumeWeightedCandleWidth: true,
    });
  });

  it('backfills volumeWeightedCandleWidth to the default when reading an old-shape stored record', () => {
    localStorage.setItem(
      'settings.indicatorSettings.v1',
      JSON.stringify(DEFAULT_INDICATOR_SETTINGS_STATE),
    );
    localStorage.setItem('settings.chartDisplay.v1', JSON.stringify({ volumeEnabled: false }));

    const store = new SettingsStore();
    expect(store.chartDisplay).toEqual({ volumeEnabled: false, volumeWeightedCandleWidth: false });
  });

  it.each([
    ['missing', null],
    ['corrupt', JSON.stringify({ volumeEnabled: 'yes' })],
  ])(
    'preserves valid keyed settings and repairs a %s display record after an interrupted migration',
    (_state, displayRecord) => {
      const keyed = structuredClone(DEFAULT_INDICATOR_SETTINGS_STATE);
      keyed.indicators.sma = { enabled: true, parameters: { period: 7 } };
      localStorage.setItem('settings.indicatorSettings.v1', JSON.stringify(keyed));
      if (displayRecord !== null) {
        localStorage.setItem('settings.chartDisplay.v1', displayRecord);
      }
      localStorage.setItem(
        'settings.indicatorSettings',
        JSON.stringify({ smaEnabled: false, smaPeriod: 99, volumeEnabled: false }),
      );

      const store = new SettingsStore();
      expect(store.indicatorSettings).toEqual(keyed);
      expect(store.chartDisplay).toEqual(DEFAULT_CHART_DISPLAY);
      expect(localStorage.getItem('settings.indicatorSettings')).toBeNull();
      expect(localStorage.getItem('settings.chartDisplay.v1')).toBe(
        JSON.stringify(DEFAULT_CHART_DISPLAY),
      );
    },
  );

  it('keeps the legacy key when a verified migration write cannot complete', () => {
    class FailingStorage extends MemoryStorage {
      override setItem(key: string, value: string): void {
        if (key === 'settings.chartDisplay.v1') throw new Error('disk full');
        super.setItem(key, value);
      }
    }
    const storage = new FailingStorage();
    storage.setItem('settings.indicatorSettings', JSON.stringify({ smaEnabled: true }));
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

    expect(new SettingsStore().indicatorSettings).toEqual(DEFAULT_INDICATOR_SETTINGS_STATE);
    expect(localStorage.getItem('settings.indicatorSettings')).not.toBeNull();
    expect(localStorage.getItem('settings.indicatorSettings.v1')).toBeNull();
  });

  it('rejects corrupt keyed settings and keeps the last valid default', () => {
    localStorage.setItem(
      'settings.indicatorSettings.v1',
      JSON.stringify({
        ...DEFAULT_INDICATOR_SETTINGS_STATE,
        indicators: {
          ...DEFAULT_INDICATOR_SETTINGS_STATE.indicators,
          sma: { enabled: true, parameters: { period: Number.POSITIVE_INFINITY } },
        },
      }),
    );

    expect(new SettingsStore().indicatorSettings).toEqual(DEFAULT_INDICATOR_SETTINGS_STATE);
  });
});

interface ExpectedOptionsAnalyticsSettings {
  enabled: boolean;
  showImpliedRange: boolean;
  showGammaProfile: boolean;
  showMarkedOi: boolean;
  showLiquidity: boolean;
  showDealerProxy: boolean;
  refreshSeconds: number;
  profileStrikeCount: number;
  showDiagnostics: boolean;
}

function optionsAnalyticsSettings(store: SettingsStore): ExpectedOptionsAnalyticsSettings {
  return (store as unknown as { optionsAnalytics: ExpectedOptionsAnalyticsSettings })
    .optionsAnalytics;
}

describe('SettingsStore options analytics settings', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it('uses the fact-first defaults from the versioned settings key', () => {
    expect(optionsAnalyticsSettings(new SettingsStore())).toEqual({
      enabled: true,
      showImpliedRange: true,
      showGammaProfile: true,
      showMarkedOi: false,
      showLiquidity: false,
      showDealerProxy: false,
      refreshSeconds: 45,
      profileStrikeCount: 12,
      showDiagnostics: false,
    });
  });

  it('does not read the obsolete settings key', () => {
    const obsoleteKey = `settings.${['g', 'e', 'x', 'Settings'].join('')}`;
    localStorage.setItem(obsoleteKey, JSON.stringify({ enabled: true, refreshSeconds: 15 }));

    expect(optionsAnalyticsSettings(new SettingsStore())).toMatchObject({
      enabled: true,
      refreshSeconds: 45,
    });
  });

  it('strictly decodes booleans and clamps persisted numeric settings', () => {
    localStorage.setItem(
      'settings.optionsAnalytics.v1',
      JSON.stringify({
        enabled: true,
        showImpliedRange: false,
        showGammaProfile: 'yes',
        showMarkedOi: true,
        showLiquidity: 1,
        showDealerProxy: true,
        refreshSeconds: 4,
        profileStrikeCount: 99,
        showDiagnostics: true,
      }),
    );

    expect(optionsAnalyticsSettings(new SettingsStore())).toEqual({
      enabled: true,
      showImpliedRange: false,
      showGammaProfile: true,
      showMarkedOi: true,
      showLiquidity: false,
      showDealerProxy: true,
      refreshSeconds: 15,
      profileStrikeCount: 20,
      showDiagnostics: true,
    });
  });

  it('writes only the new versioned settings key', () => {
    const store = new SettingsStore() as unknown as {
      optionsAnalytics: ExpectedOptionsAnalyticsSettings;
    };
    store.optionsAnalytics = {
      ...optionsAnalyticsSettings(new SettingsStore()),
      enabled: true,
    };

    expect(localStorage.getItem('settings.optionsAnalytics.v1')).not.toBeNull();
    const obsoleteKey = `settings.${['g', 'e', 'x', 'Settings'].join('')}`;
    expect(localStorage.getItem(obsoleteKey)).toBeNull();
  });
});

describe('SettingsStore server setup preference', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it('defaults first-run server selection to incomplete', () => {
    expect(new SettingsStore().hasCompletedServerSelection).toBe(false);
  });

  it('persists first-run server selection completion', () => {
    new SettingsStore().hasCompletedServerSelection = true;
    expect(new SettingsStore().hasCompletedServerSelection).toBe(true);
  });

  it('treats an existing install footprint as already configured', () => {
    localStorage.setItem('settings.riskDisclaimerAccepted', 'true');
    localStorage.setItem('settings.lastSymbol', 'SPY');
    expect(new SettingsStore().hasCompletedServerSelection).toBe(true);
  });
});

describe('SettingsStore boolean device preferences', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it('defaults tradingLocked and bypassOrderConfirmation to false', () => {
    const store = new SettingsStore();
    expect(store.tradingLocked).toBe(false);
    expect(store.bypassOrderConfirmation).toBe(false);
  });

  it('persists tradingLocked across instances (the lock is remembered)', () => {
    new SettingsStore().tradingLocked = true;
    expect(localStorage.getItem('settings.tradingLocked')).toBe('true');
    expect(new SettingsStore().tradingLocked).toBe(true);
  });

  it('round-trips bypassOrderConfirmation through localStorage', () => {
    new SettingsStore().bypassOrderConfirmation = true;
    expect(new SettingsStore().bypassOrderConfirmation).toBe(true);
    new SettingsStore().bypassOrderConfirmation = false;
    expect(new SettingsStore().bypassOrderConfirmation).toBe(false);
  });

  it('defaults keyboardShortcutsEnabled to false', () => {
    expect(new SettingsStore().keyboardShortcutsEnabled).toBe(false);
  });

  it('round-trips keyboardShortcutsEnabled through localStorage', () => {
    new SettingsStore().keyboardShortcutsEnabled = false;
    expect(new SettingsStore().keyboardShortcutsEnabled).toBe(false);
    new SettingsStore().keyboardShortcutsEnabled = true;
    expect(new SettingsStore().keyboardShortcutsEnabled).toBe(true);
  });

  it('defaults toasts and system notifications to on, and round-trips both', () => {
    expect(new SettingsStore().toastsEnabled).toBe(true);
    expect(new SettingsStore().systemNotificationsEnabled).toBe(true);
    new SettingsStore().toastsEnabled = false;
    expect(new SettingsStore().toastsEnabled).toBe(false);
    new SettingsStore().systemNotificationsEnabled = false;
    expect(new SettingsStore().systemNotificationsEnabled).toBe(false);
  });
});
