/**
 * TWC Heatmap V5 — Unified Confluence Engine (phase 2). Blends every
 * subsystem into one 0–100 score per bar:
 *   MSI · CTF SuperTrend · HTF stack · SD-Fib direction · 6×MTF zigzag votes
 *   · SMC swing bias · SMC internal bias
 * and derives the CL/CS entry markers (heatmap signal + score confirmation).
 *
 * The six MTF votes run the direction-only zigzag over candles RESAMPLED from
 * the loaded chart history (the API serves no extra timeframes), so on small
 * intervals the largest timeframes may not have two pivots yet — their vote
 * is simply 0, weakening mtfNet rather than blocking the score.
 * Keep in sync with TwcConfluence.swift.
 */

import { TWC_COLORS } from './twcColors';
import type { TwcHeatmapSettings } from './twcSettings';
import type { TwcMarker } from './twcTypes';
import { resampleTo, timeframeSeconds, type TwcCandle } from './twcMath';
import { fibDirectionSeries } from './twcFib';

// component weights (sum = 1.0, straight from the Pine script)
const W_MSI = 0.15;
const W_CTF = 0.2;
const W_STACK = 0.15;
const W_FIB = 0.15;
const W_MTF = 0.2;
const W_SWING = 0.1;
const W_INT = 0.05;

export interface TwcConfluenceInput {
  msi: (number | null)[];
  ctfDir: number[];
  stackDir: number[];
  crossUp: boolean[];
  crossDn: boolean[];
  fibDir: number[];
  swingBias: number[];
  internalBias: number[];
}

export interface TwcConfluenceResult {
  /** 0–100 score per bar; null while MSI is warming up. */
  score: (number | null)[];
  markers: TwcMarker[];
}

/** Per-bar direction vote of one resampled timeframe, mapped to chart bars. */
function mtfVote(
  candles: TwcCandle[],
  tf: string,
  settings: TwcHeatmapSettings,
  chartIntervalSeconds: number,
): number[] {
  const { htfCandles, chartToHtf } = resampleTo(
    candles,
    timeframeSeconds(tf),
    chartIntervalSeconds,
  );
  const dir = fibDirectionSeries(htfCandles, settings);
  // lookahead_off with no [1] offset: chart bars read the developing bucket
  return chartToHtf.map((k) => dir[k]);
}

export function computeConfluence(
  candles: TwcCandle[],
  settings: TwcHeatmapSettings,
  input: TwcConfluenceInput,
  chartIntervalSeconds: number,
): TwcConfluenceResult {
  const n = candles.length;
  const tfs = [
    settings.mtfTf1,
    settings.mtfTf2,
    settings.mtfTf3,
    settings.mtfTf4,
    settings.mtfTf5,
    settings.mtfTf6,
  ];
  const votes = tfs.map((tf) => mtfVote(candles, tf, settings, chartIntervalSeconds));

  const score: (number | null)[] = new Array(n).fill(null);
  const markers: TwcMarker[] = [];

  for (let i = 0; i < n; i++) {
    const m = input.msi[i];
    if (m === null) continue; // Pine: score is na until MSI warms up

    let bullVotes = 0;
    let bearVotes = 0;
    for (const vote of votes) {
      if (vote[i] === 1) bullVotes++;
      else if (vote[i] === -1) bearVotes++;
    }
    const mtfNet = (bullVotes - bearVotes) / 6;

    const s =
      50 +
      50 *
        (W_MSI * ((m - 50) / 50) +
          W_CTF * input.ctfDir[i] +
          W_STACK * input.stackDir[i] +
          W_FIB * input.fibDir[i] +
          W_MTF * mtfNet +
          W_SWING * input.swingBias[i] +
          W_INT * input.internalBias[i]);
    score[i] = s;

    if (!settings.showConfMarkers) continue;
    const confluenceLong =
      input.crossUp[i] && (!settings.useConfluenceGate || s >= settings.confBullThr);
    const confluenceShort =
      input.crossDn[i] && (!settings.useConfluenceGate || s <= settings.confBearThr);
    if (confluenceLong) {
      markers.push({
        barIndex: i,
        placement: 'belowBar',
        shape: 'labelUp',
        color: TWC_COLORS.bull,
        size: 'small',
        text: 'CL',
      });
    }
    if (confluenceShort) {
      markers.push({
        barIndex: i,
        placement: 'aboveBar',
        shape: 'labelDown',
        color: TWC_COLORS.bear,
        size: 'small',
        text: 'CS',
      });
    }
  }

  return { score, markers };
}
