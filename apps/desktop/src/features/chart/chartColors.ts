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

// Alpha variants (volume bars, guide lines, crosshair, rect fill) have no
// token yet; the iOS-matching constants live here as the single source.
let cached: { chart: ChartPalette; overlay: OverlayPalette; pane: PanePalette } | null = null;

function resolve(): { chart: ChartPalette; overlay: OverlayPalette; pane: PanePalette } {
  if (!cached) {
    cached = {
      chart: {
        candleUp: tokenColor('--chart-candle-up', '#30d158'),
        candleDown: tokenColor('--chart-candle-down', '#ff453a'),
        axisLabel: tokenColor('--chart-axis-label', 'rgba(235, 235, 245, 0.6)'),
        grid: tokenColor('--chart-grid', 'rgba(84, 84, 88, 0.25)'),
        border: 'rgba(84, 84, 88, 0.4)',
        crosshair: 'rgba(235, 235, 245, 0.4)',
        volumeUp: 'rgba(48, 209, 88, 0.45)',
        volumeDown: 'rgba(255, 69, 58, 0.45)',
        guide: 'rgba(142, 142, 147, 0.6)',
        accent: tokenColor('--app-accent', '#568ff7'),
        alert: tokenColor('--warning-orange', '#ff9f0a'),
        tagText: tokenColor('--app-background', '#0b0c10'),
        rectFill: 'rgba(86, 143, 247, 0.12)',
        handleFill: tokenColor('--label-primary', '#ffffff'),
      },
      overlay: {
        sma: tokenColor('--chart-sma', '#ff9f0a'),
        ema: tokenColor('--chart-ema', '#64d2ff'),
        vwap: tokenColor('--chart-vwap', '#bf5af2'),
        bollingerUpper: tokenColor('--chart-bb-outer', '#8e8e93'),
        bollingerMiddle: tokenColor('--chart-bb-middle', '#40cbe0'),
        bollingerLower: tokenColor('--chart-bb-outer', '#8e8e93'),
      },
      pane: {
        rsi: tokenColor('--chart-rsi', '#ffd60a'),
        macd: tokenColor('--chart-macd', '#0a84ff'),
        macdSignal: tokenColor('--chart-macd-signal', '#ff9f0a'),
        macdPositive: tokenColor('--pnl-positive', '#30d158'),
        macdNegative: tokenColor('--pnl-negative', '#ff453a'),
        stochK: tokenColor('--chart-macd', '#0a84ff'),
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
