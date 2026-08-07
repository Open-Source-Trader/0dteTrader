/**
 * Chart palette resolved from the --chart-* tokens in tokens.css.
 * lightweight-charts and the drawing canvas need concrete color strings,
 * not var() references, so tokens are read once via getComputedStyle and
 * cached (the clone forces dark; tokens never change at runtime).
 */

function tokenColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const INDICATOR_FALLBACKS: Record<string, string> = {
  'indicator.sma.value': '#3b9eff',
  'indicator.ema.value': '#64d2ff',
  'indicator.rsi.value': '#ffc53d',
  'indicator.macd.value': '#3b9eff',
  'indicator.macd.signal': '#ff9f0a',
  'indicator.macd.histogram': '#9aa9bc',
  'indicator.bollinger.upper': '#7f96b8',
  'indicator.bollinger.middle': '#40cbe0',
  'indicator.bollinger.lower': '#b14cf0',
  'indicator.stochastic.k': '#f5c542',
  'indicator.stochastic.d': '#40cbe0',
  'indicator.atr.value': '#b14cf0',
  'indicator.anchored_vwap.value': '#b14cf0',
  'indicator.supertrend.bullish': '#22e06a',
  'indicator.supertrend.bearish': '#ff3b4e',
  'indicator.keltner.upper': '#9f8cff',
  'indicator.keltner.middle': '#40cbe0',
  'indicator.keltner.lower': '#3b9eff',
  'indicator.vpvr.row': '#8cb4eb',
  'indicator.vpvr.value_area': '#3b9eff',
  'indicator.adx_dmi.adx': '#ffc53d',
  'indicator.adx_dmi.plus_di': '#22e06a',
  'indicator.adx_dmi.minus_di': '#ff3b4e',
  'indicator.obv.value': '#64d2ff',
  'indicator.cci.value': '#ff70c8',
  'indicator.williams_r.value': '#ff9f0a',
  'indicator.ichimoku.conversion': '#64d2ff',
  'indicator.ichimoku.base': '#ff9f0a',
  'indicator.ichimoku.span_a': '#22e06a',
  'indicator.ichimoku.span_b': '#ff3b4e',
  'indicator.ichimoku.lagging': '#b14cf0',
  'indicator.spread.absolute': '#64d2ff',
  'indicator.spread.bps': '#ffc53d',
  'indicator.spread.percentile': '#ff70c8',
  'indicator.top_book_imbalance.value': '#40cbe0',
  'indicator.tick_pressure.value': '#ffc53d',
  'indicator.depth_imbalance.value': '#9f8cff',
  'indicator.cumulative_pressure.value': '#64d2ff',
  'indicator.touch_depletion.value': '#ff70c8',
};

/** Resolves a canonical registry style token through the desktop theme. */
export function indicatorStyleColor(styleToken: string): string {
  const fallback = INDICATOR_FALLBACKS[styleToken] ?? '#8cb4eb';
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return fallback;
  return tokenColor(`--${styleToken.replaceAll('.', '-').replaceAll('_', '-')}`, fallback);
}

/** Chrome/surface colors for the candle chart, sub-panes, and drawing canvas. */
export interface ChartPalette {
  candleUp: string;
  candleDown: string;
  axisLabel: string;
  grid: string;
  border: string;
  crosshair: string;
  volumeUp: string;
  volumeDown: string;
  guide: string;
  accent: string;
  alert: string;
  tagText: string;
  rectFill: string;
  handleFill: string;
  /** Chart trading: profitable side / losing side / a resting entry limit. */
  pnlPositive: string;
  pnlNegative: string;
  orderLimit: string;
}

let cached: ChartPalette | null = null;

function resolve(): ChartPalette {
  if (!cached) {
    cached = {
      candleUp: tokenColor('--chart-candle-up', '#22e06a'),
      candleDown: tokenColor('--chart-candle-down', '#ff3b4e'),
      axisLabel: tokenColor('--chart-axis-label', 'rgba(140, 180, 235, 0.7)'),
      grid: tokenColor('--chart-grid', 'rgba(46, 143, 255, 0.1)'),
      border: tokenColor('--hud-stroke-dim', 'rgba(46, 143, 255, 0.35)'),
      crosshair: tokenColor('--chart-crosshair', 'rgba(111, 180, 255, 0.4)'),
      volumeUp: tokenColor('--chart-volume-up', 'rgba(34, 224, 106, 0.45)'),
      volumeDown: tokenColor('--chart-volume-down', 'rgba(255, 59, 78, 0.45)'),
      guide: tokenColor('--chart-guide', 'rgba(90, 130, 190, 0.6)'),
      accent: tokenColor('--app-accent', '#3b9eff'),
      alert: tokenColor('--warning-orange', '#ffc53d'),
      tagText: tokenColor('--app-background', '#050a14'),
      rectFill: tokenColor('--chart-rect-fill', 'rgba(59, 158, 255, 0.12)'),
      handleFill: tokenColor('--label-primary', '#eaf2ff'),
      pnlPositive: tokenColor('--pnl-positive', '#22e06a'),
      pnlNegative: tokenColor('--pnl-negative', '#ff3b4e'),
      orderLimit: tokenColor('--app-accent', '#3b9eff'),
    };
  }
  return cached;
}

export function chartPalette(): ChartPalette {
  return resolve();
}
