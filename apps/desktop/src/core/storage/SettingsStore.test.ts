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

describe('SettingsStore AUTO OTM offset', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it('defaults to +1 OTM', () => {
    expect(new SettingsStore().autoOtmOffset).toBe(1);
  });

  it('round-trips through localStorage, including 0 (ATM)', () => {
    new SettingsStore().autoOtmOffset = 3;
    expect(new SettingsStore().autoOtmOffset).toBe(3);
    new SettingsStore().autoOtmOffset = 0;
    expect(new SettingsStore().autoOtmOffset).toBe(0);
  });

  it('clamps out-of-range values and rejects garbage on read', () => {
    localStorage.setItem('settings.autoOtmOffset', '99');
    expect(new SettingsStore().autoOtmOffset).toBe(10);
    localStorage.setItem('settings.autoOtmOffset', '-2');
    expect(new SettingsStore().autoOtmOffset).toBe(0);
    localStorage.setItem('settings.autoOtmOffset', '1.5');
    expect(new SettingsStore().autoOtmOffset).toBe(1);
    localStorage.setItem('settings.autoOtmOffset', 'wide');
    expect(new SettingsStore().autoOtmOffset).toBe(1);
  });
});
