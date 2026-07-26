/**
 * Chart trading (order lines drawn directly on the candles). Mirrored by the
 * iOS ChartTradingSettings.
 */
export interface ChartTradingSettings {
  /** Master switch for the order-line overlay. */
  enabled: boolean;
  /**
   * Futures-style bracketing: drag off a position's entry line to place its
   * target and stop. Off means the entry line is read-only and lines are only
   * placed from the price axis.
   */
  bracketDrag: boolean;
  /** Contracts a new line is created with. */
  defaultQuantity: number;
}

/**
 * Bounds for the per-line default size, shared by the settings stepper and the
 * decoder below. They must be one constant: when the decoder accepted more than
 * the stepper could show, a stored value out of range armed a size the UI could
 * neither display nor correct.
 */
export const CHART_TRADING_QUANTITY_MIN = 1;
export const CHART_TRADING_QUANTITY_MAX = 50;

export const DEFAULT_CHART_TRADING_SETTINGS: ChartTradingSettings = {
  enabled: true,
  bracketDrag: true,
  defaultQuantity: 1,
};

/**
 * Validates a stored payload field by field. A coerced value here would arm a
 * real order, so anything unexpected falls back to the default rather than
 * being trusted.
 */
export function decodeChartTradingSettings(value: unknown): ChartTradingSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_CHART_TRADING_SETTINGS;
  const raw = value as Partial<Record<keyof ChartTradingSettings, unknown>>;
  const quantity = raw.defaultQuantity;
  return {
    enabled:
      typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CHART_TRADING_SETTINGS.enabled,
    bracketDrag:
      typeof raw.bracketDrag === 'boolean'
        ? raw.bracketDrag
        : DEFAULT_CHART_TRADING_SETTINGS.bracketDrag,
    defaultQuantity:
      typeof quantity === 'number' &&
      Number.isInteger(quantity) &&
      quantity >= CHART_TRADING_QUANTITY_MIN &&
      quantity <= CHART_TRADING_QUANTITY_MAX
        ? quantity
        : DEFAULT_CHART_TRADING_SETTINGS.defaultQuantity,
  };
}
