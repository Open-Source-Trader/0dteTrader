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
}

/** Overlay line colors on the main chart (ChartView.overlayColors analog). */
export interface OverlayPalette {
  sma: string;
  ema: string;
  vwap: string;
  bollingerUpper: string;
  bollingerMiddle: string;
  bollingerLower: string;
}

/** Sub-pane series colors (RSI / MACD / Stochastic / ATR). */
export interface PanePalette {
  rsi: string;
  macd: string;
  macdSignal: string;
  macdPositive: string;
  macdNegative: string;
  stochK: string;
  stochD: string;
  atr: string;
}

let cached: { chart: ChartPalette; overlay: OverlayPalette; pane: PanePalette } | null = null;

function resolve(): { chart: ChartPalette; overlay: OverlayPalette; pane: PanePalette } {
  if (!cached) {
    cached = {
      chart: {
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
      },
      overlay: {
        sma: tokenColor('--chart-sma', '#3b9eff'),
        ema: tokenColor('--chart-ema', '#64d2ff'),
        vwap: tokenColor('--chart-vwap', '#b14cf0'),
        bollingerUpper: tokenColor('--chart-bb-outer', '#4a6fa5'),
        bollingerMiddle: tokenColor('--chart-bb-middle', '#40cbe0'),
        bollingerLower: tokenColor('--chart-bb-outer', '#4a6fa5'),
      },
      pane: {
        rsi: tokenColor('--chart-rsi', '#ffc53d'),
        macd: tokenColor('--chart-macd', '#3b9eff'),
        macdSignal: tokenColor('--chart-macd-signal', '#ff9f0a'),
        macdPositive: tokenColor('--pnl-positive', '#22e06a'),
        macdNegative: tokenColor('--pnl-negative', '#ff3b4e'),
        stochK: tokenColor('--chart-macd', '#3b9eff'),
        stochD: tokenColor('--chart-macd-signal', '#ff9f0a'),
        atr: tokenColor('--chart-bb-middle', '#40cbe0'),
      },
    };
  }
  return cached;
}

export function chartPalette(): ChartPalette {
  return resolve().chart;
}

export function overlayPalette(): OverlayPalette {
  return resolve().overlay;
}

export function panePalette(): PanePalette {
  return resolve().pane;
}
