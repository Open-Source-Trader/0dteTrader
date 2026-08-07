import { describe, expect, it } from 'vitest';
import { DEFAULT_INDICATOR_SETTINGS_STATE } from './indicatorRegistry';
import { validateEnabledIndicatorGeometries } from './indicatorRuntimeValidation';

describe('validateEnabledIndicatorGeometries', () => {
  it('accepts finite geometry for every enabled candle indicator', () => {
    const result = validateEnabledIndicatorGeometries(DEFAULT_INDICATOR_SETTINGS_STATE, [
      { timestamp: 1_000, open: 10, high: 11, low: 9, close: 10, volume: 100 },
    ]);

    expect(result).toEqual({ ok: true });
  });

  it('rejects invalid geometry input without returning partial success', () => {
    const result = validateEnabledIndicatorGeometries(DEFAULT_INDICATOR_SETTINGS_STATE, [
      { timestamp: 1_000, open: 10, high: 11, low: 9, close: Number.NaN, volume: 100 },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('nonfinite');
  });
});
