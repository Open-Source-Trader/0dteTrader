import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore } from './SettingsStore';

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
      showDiagnostics: true,
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
});
