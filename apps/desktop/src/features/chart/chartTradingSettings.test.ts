import { describe, expect, it } from 'vitest';
import {
  CHART_TRADING_QUANTITY_MAX,
  CHART_TRADING_QUANTITY_MIN,
  DEFAULT_CHART_TRADING_SETTINGS,
  decodeChartTradingSettings,
} from './chartTradingSettings';

describe('decodeChartTradingSettings', () => {
  it('accepts a well-formed payload', () => {
    expect(
      decodeChartTradingSettings({ enabled: false, bracketDrag: false, defaultQuantity: 5 }),
    ).toEqual({ enabled: false, bracketDrag: false, defaultQuantity: 5 });
  });

  /**
   * The decode bound and the settings stepper must agree. When decoding was
   * wider, a stored value out of range armed a default size the stepper could
   * neither show nor correct.
   */
  it('rejects a stored quantity the settings stepper could not represent', () => {
    for (const quantity of [CHART_TRADING_QUANTITY_MAX + 1, 1000, 0, -3, 2.5]) {
      expect(decodeChartTradingSettings({ defaultQuantity: quantity }).defaultQuantity).toBe(
        DEFAULT_CHART_TRADING_SETTINGS.defaultQuantity,
      );
    }
  });

  it('keeps both ends of the stepper range', () => {
    for (const quantity of [CHART_TRADING_QUANTITY_MIN, CHART_TRADING_QUANTITY_MAX]) {
      expect(decodeChartTradingSettings({ defaultQuantity: quantity }).defaultQuantity).toBe(
        quantity,
      );
    }
  });

  it('falls back to defaults on junk', () => {
    for (const value of [null, undefined, 'nope', 42]) {
      expect(decodeChartTradingSettings(value)).toEqual(DEFAULT_CHART_TRADING_SETTINGS);
    }
  });

  it('ignores wrong-typed fields individually', () => {
    expect(decodeChartTradingSettings({ enabled: 'yes', bracketDrag: 1 })).toEqual(
      DEFAULT_CHART_TRADING_SETTINGS,
    );
  });
});
