import { describe, expect, it } from 'vitest';
import registryJson from '../../../../../packages/shared-types/indicator-registry.json';
import type { IndicatorSettingsState } from '@0dtetrader/shared-types';
import {
  DEFAULT_INDICATOR_SETTINGS_STATE,
  INDICATOR_REGISTRY,
  applyIndicatorSetting,
  decodeIndicatorRegistry,
  enabledSubPaneIds,
  indicatorAvailability,
  validateIndicatorSettingsState,
} from './indicatorRegistry';

describe('canonical indicator registry', () => {
  it('decodes the shared JSON without maintaining a desktop indicator list', () => {
    expect(INDICATOR_REGISTRY).toEqual(registryJson);
    expect(INDICATOR_REGISTRY.indicators).toHaveLength(22);
    expect(new Set(INDICATOR_REGISTRY.indicators.map(({ id }) => id)).size).toBe(22);
  });

  it('rejects malformed registry descriptors', () => {
    const malformed = structuredClone(registryJson) as unknown as {
      indicators: Array<{ geometry: { kind: string } }>;
    };
    malformed.indicators[0].geometry.kind = 'desktop_only_branch';

    expect(() => decodeIndicatorRegistry(malformed)).toThrow('geometry');
  });

  it('rejects geometry that references an undeclared style token', () => {
    const malformed = structuredClone(registryJson) as unknown as {
      indicators: Array<{ geometry: { series: Array<{ styleToken: string }> } }>;
    };
    malformed.indicators[0].geometry.series[0].styleToken = 'indicator.undeclared.value';

    expect(() => decodeIndicatorRegistry(malformed)).toThrow('style');
  });
});

describe('indicator settings validation', () => {
  it.each([
    [
      'unknown id',
      (candidate: Record<string, unknown>) =>
        (candidate.unknown = { enabled: true, parameters: {} }),
    ],
    [
      'unknown parameter',
      (candidate: Record<string, unknown>) => {
        const sma = candidate.sma as { parameters: Record<string, number> };
        sma.parameters.desktopOnly = 4;
      },
    ],
    [
      'nonfinite parameter',
      (candidate: Record<string, unknown>) => {
        const sma = candidate.sma as { parameters: Record<string, number> };
        sma.parameters.period = Number.POSITIVE_INFINITY;
      },
    ],
    [
      'out of range parameter',
      (candidate: Record<string, unknown>) => {
        const sma = candidate.sma as { parameters: Record<string, number> };
        sma.parameters.period = 0;
      },
    ],
    [
      'noninteger integer parameter',
      (candidate: Record<string, unknown>) => {
        const sma = candidate.sma as { parameters: Record<string, number> };
        sma.parameters.period = 2.5;
      },
    ],
    [
      'fractional timestamp parameter',
      (candidate: Record<string, unknown>) => {
        const anchored = candidate.anchored_vwap as { parameters: Record<string, number> };
        anchored.parameters.anchorTimestamp = 1.5;
      },
    ],
    [
      'cross-field constraint',
      (candidate: Record<string, unknown>) => {
        const macd = candidate.macd as { parameters: Record<string, number> };
        macd.parameters.fastPeriod = macd.parameters.slowPeriod;
      },
    ],
  ])('rejects %s and preserves the last valid settings', (_name, mutate) => {
    const lastValid = structuredClone(DEFAULT_INDICATOR_SETTINGS_STATE);
    const candidate = structuredClone(lastValid) as unknown as {
      indicators: Record<string, unknown>;
    };
    mutate(candidate.indicators);

    const result = validateIndicatorSettingsState(candidate, lastValid);

    expect(result.ok).toBe(false);
    expect(result.value).toEqual(lastValid);
  });

  it('rejects a third enabled subpane with the exact registry message', () => {
    const first = applyIndicatorSetting(DEFAULT_INDICATOR_SETTINGS_STATE, 'rsi', { enabled: true });
    const second = applyIndicatorSetting(first.value, 'macd', { enabled: true });
    const third = applyIndicatorSetting(second.value, 'atr', { enabled: true });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third).toEqual({
      ok: false,
      error: INDICATOR_REGISTRY.paneLimitMessage,
      value: second.value,
    });
    expect(enabledSubPaneIds(third.value)).toEqual(['rsi', 'macd']);
  });

  it('reports candle indicators as available and L2 indicators as explicitly unavailable', () => {
    expect(indicatorAvailability('sma')).toEqual({ available: true });
    expect(indicatorAvailability('spread')).toEqual({
      available: false,
      reason: 'No L2 data',
    });
  });

  it('accepts a complete valid state without changing it', () => {
    const candidate: IndicatorSettingsState = structuredClone(DEFAULT_INDICATOR_SETTINGS_STATE);
    expect(validateIndicatorSettingsState(candidate, DEFAULT_INDICATOR_SETTINGS_STATE)).toEqual({
      ok: true,
      value: candidate,
    });
  });
});
