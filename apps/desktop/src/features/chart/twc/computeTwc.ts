/**
 * TWC Heatmap V5 — compute entry point. Pure: (candles, settings, interval)
 * -> renderer-agnostic TwcRenderModel. Keep in sync with TwcEngine.swift.
 */

import type { TwcHeatmapSettings } from './twcSettings';
import type { TwcRenderModel } from './twcTypes';
import { computeHeatmap } from './twcHeatmap';
import { computeFib, fibDirectionSeries } from './twcFib';
import { computeSmc } from './twcSmc';
import { computeConfluence } from './twcConfluence';
import type { TwcCandle } from './twcMath';

export type { TwcCandle } from './twcMath';
export * from './twcTypes';

export function computeTwc(
  candles: TwcCandle[],
  settings: TwcHeatmapSettings,
  intervalSeconds: number,
): TwcRenderModel | null {
  if (!settings.enabled || candles.length === 0) return null;

  const heatmap = computeHeatmap(candles, settings, intervalSeconds);
  const fib = computeFib(candles, settings, heatmap.atr14);
  const smc = computeSmc(candles, settings);
  // Pine publishes the RAW zigzag direction (no instant-flip overlay) when
  // fib drawing is disabled; with drawing on, flips apply.
  const fibDir = fibDirectionSeries(
    candles,
    settings.showFibonacci ? settings : { ...settings, flipEnable: false },
  );
  const confluence = computeConfluence(
    candles,
    settings,
    {
      msi: heatmap.msi,
      ctfDir: heatmap.ctfDir,
      stackDir: heatmap.stackDir,
      crossUp: heatmap.crossUp,
      crossDn: heatmap.crossDn,
      fibDir,
      swingBias: smc.swingBias,
      internalBias: smc.internalBias,
    },
    intervalSeconds,
  );

  return {
    candleColors: heatmap.candleColors,
    markers: [...heatmap.markers, ...confluence.markers],
    lines: heatmap.lines,
    fills: heatmap.fills,
    segments: fib.segments,
    // SMC bands (order blocks, zones) render beneath the PT bands
    bands: [...smc.bands, ...fib.bands],
    labels: [...smc.labels, ...fib.labels],
    banner: heatmap.banner,
  };
}
