/**
 * TWC Heatmap V5 — SD Fibonacci / Gann engine. A single left-to-right fold
 * reproduces the Pine script's per-bar `var` state exactly (zigzag pivots,
 * instant flips, hit latches, ratio growth); the drawing geometry is then
 * assembled from the state after the final bar. Pine deletes and redraws all
 * objects per swing, so only the current swing's geometry is ever visible —
 * a full recompute is equivalent. Keep in sync with TwcFib.swift.
 */

import { TWC_COLORS } from './twcColors';
import type { TwcHeatmapSettings } from './twcSettings';
import type { TwcBand, TwcLabel, TwcSegment } from './twcTypes';
import { highestBarsOffset, lowestBarsOffset, pineAtr, pivotHigh, pivotLow, type TwcCandle } from './twcMath';

const FIB_NEG_0618 = -0.618033988749895;
const FIB_0618 = 0.618033988749895;
const FIB_0786 = 0.786151377757423;
const FIB_1618 = 1.618033988749895;
const FIB_EPSILON = 0.0001;
const FIB_LINE_LOOKBACK = 1200;
const FIB_PROJ_X_RIGHT = 40;

interface RatioEntry {
  ratio: number;
  color: string;
}

export interface TwcFibResult {
  segments: TwcSegment[];
  bands: TwcBand[];
  labels: TwcLabel[];
}

const round4 = (v: number): number => Math.round(v * 10000) / 10000;
const approxEqual = (a: number, b: number): boolean => Math.abs(a - b) < FIB_EPSILON;

function seedRatios(useStandard: boolean): RatioEntry[] {
  return [
    { ratio: round4(useStandard ? FIB_NEG_0618 : -0.1618), color: TWC_COLORS.red50 },
    { ratio: 0, color: TWC_COLORS.white50 },
    { ratio: round4(FIB_0618), color: TWC_COLORS.amberBand },
    { ratio: round4(FIB_0786), color: TWC_COLORS.amberBand },
    { ratio: 1, color: TWC_COLORS.white50 },
  ];
}

/** Pine fib_ensureExtRatios: dedup-append; returns whether anything was added. */
function ensureExtRatios(store: RatioEntry[], ratios: number[], colors: string[]): boolean {
  let changed = false;
  for (let i = 0; i < ratios.length; i++) {
    const rounded = round4(ratios[i]);
    if (!store.some((e) => approxEqual(e.ratio, rounded))) {
      store.push({ ratio: rounded, color: colors[i] });
      changed = true;
    }
  }
  return changed;
}

/**
 * Direction-only zigzag fold (Pine f_calcFibDirection, which the script keeps
 * as its own drawing-free implementation for request.security): the same
 * swing detection + instant flip, returning +1/-1 per bar once two pivots
 * exist, 0 before. Runs on the chart candles (the score's fib component) and
 * on resampled candles (the six MTF votes) regardless of showFibonacci.
 */
export function fibDirectionSeries(candles: TwcCandle[], settings: TwcHeatmapSettings): number[] {
  const n = candles.length;
  const direction: number[] = new Array(n).fill(0);
  if (n === 0) return direction;
  const prd = settings.fibPeriod;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const opens = candles.map((c) => c.open);
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const atr14 = pineAtr(candles, 14);
  const useWick = settings.fibPivotSource === 'Wick';
  const negExtLevel = settings.useStandardRatios ? FIB_NEG_0618 : -0.1618;
  const simple = settings.fibMethod === 'Simple Pivots';
  const ph = simple ? pivotHigh(highs, prd, prd) : [];
  const pl = simple ? pivotLow(lows, prd, prd) : [];

  const pivotPriceAt = (idx: number, isHigh: boolean): number =>
    useWick
      ? isHigh
        ? highs[idx]
        : lows[idx]
      : isHigh
        ? Math.max(opens[idx], closes[idx])
        : Math.min(opens[idx], closes[idx]);

  const zz: number[] = [];
  let dir = 0;
  let pendingVal: number | null = null;
  let pendingIdx = 0;
  let pendingDir = 0;
  let pendingBar: number | null = null;

  const zzAdd = (value: number, idx: number): void => {
    zz.unshift(value, idx);
    while (zz.length > 30) {
      zz.pop();
      zz.pop();
    }
  };

  for (let i = 0; i < n; i++) {
    if (!simple) {
      const phOff = highestBarsOffset(highs, i, prd);
      const plOff = lowestBarsOffset(lows, i, prd);
      const vOff = highestBarsOffset(volumes, i, prd);
      const isNewHigh = phOff === 0 && Math.abs(vOff - phOff) <= 2;
      const isNewLow = plOff === 0 && Math.abs(vOff - plOff) <= 2;
      if (isNewHigh !== isNewLow) {
        pendingIdx = i;
        pendingVal = pivotPriceAt(i, isNewHigh);
        pendingDir = isNewHigh ? 1 : -1;
        pendingBar = i;
      } else if (isNewHigh && isNewLow) {
        const mid = (highs[i] + lows[i]) / 2;
        const asHigh = highs[i] - mid >= mid - lows[i];
        pendingIdx = i;
        pendingVal = pivotPriceAt(i, asHigh);
        pendingDir = asHigh ? 1 : -1;
        pendingBar = i;
      }
      if (pendingBar !== null && i - pendingBar >= prd && pendingVal !== null) {
        let stillValid = true;
        for (let j = 0; j <= Math.min(prd - 1, i); j++) {
          if (pendingDir === 1 ? highs[i - j] > highs[pendingIdx] : lows[i - j] < lows[pendingIdx]) {
            stillValid = false;
            break;
          }
        }
        if (stillValid) {
          const a = atr14[i];
          const skip = zz.length >= 2 && a !== null && Math.abs(pendingVal - zz[0]) < a * 0.25;
          if (!skip) {
            if (pendingDir !== dir || zz.length === 0) {
              zzAdd(pendingVal, pendingIdx);
            } else if ((pendingDir === 1 && pendingVal > zz[0]) || (pendingDir === -1 && pendingVal < zz[0])) {
              zz[0] = pendingVal;
              zz[1] = pendingIdx;
            }
            dir = pendingDir;
          }
        }
        pendingVal = null;
        pendingDir = 0;
        pendingBar = null;
      }
    } else {
      const hasHigh = ph[i] !== null;
      const hasLow = pl[i] !== null;
      const pivotIdx = i - prd;
      if (pivotIdx >= 0 && (hasHigh || hasLow)) {
        const finalPh = hasHigh ? pivotPriceAt(pivotIdx, true) : 0;
        const finalPl = hasLow ? pivotPriceAt(pivotIdx, false) : 0;
        if (hasHigh && hasLow) {
          const toLow = dir === 1;
          dir = toLow ? -1 : 1;
          zzAdd(toLow ? finalPl : finalPh, pivotIdx);
        } else if (hasHigh) {
          if (dir === 1) {
            if (zz.length >= 2 && finalPh > zz[0]) {
              zz[0] = finalPh;
              zz[1] = pivotIdx;
            }
          } else {
            dir = 1;
            zzAdd(finalPh, pivotIdx);
          }
        } else if (hasLow) {
          if (dir === -1) {
            if (zz.length >= 2 && finalPl < zz[0]) {
              zz[0] = finalPl;
              zz[1] = pivotIdx;
            }
          } else {
            dir = -1;
            zzAdd(finalPl, pivotIdx);
          }
        }
      }
    }

    if (zz.length < 4) continue;
    let base = zz[2];
    let last = zz[0];
    let diff = last - base;
    let isUp = diff >= 0;

    if (settings.flipEnable) {
      const rFlip =
        settings.flipLevel === '0.000'
          ? 0
          : settings.flipLevel === '±0.618'
            ? isUp
              ? negExtLevel
              : -negExtLevel
            : isUp
              ? -1.618
              : 1.618;
      const flipPx = base + diff * rFlip;
      const doFlip =
        settings.flipTrigger === 'Wick'
          ? isUp
            ? lows[i] < flipPx
            : highs[i] > flipPx
          : isUp
            ? closes[i] < flipPx
            : closes[i] > flipPx;
      if (doFlip) {
        const newVal = settings.flipTrigger === 'Wick' ? (isUp ? lows[i] : highs[i]) : closes[i];
        zzAdd(newVal, i);
        dir = isUp ? -1 : 1;
        base = zz[2];
        last = zz[0];
        diff = last - base;
        isUp = diff >= 0;
      }
    }
    direction[i] = isUp ? 1 : -1;
  }
  return direction;
}

export function computeFib(
  candles: TwcCandle[],
  settings: TwcHeatmapSettings,
  atr14: (number | null)[],
): TwcFibResult {
  const empty: TwcFibResult = { segments: [], bands: [], labels: [] };
  if (!settings.showFibonacci || candles.length === 0) return empty;

  const n = candles.length;
  const prd = settings.fibPeriod;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const opens = candles.map((c) => c.open);
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const useWick = settings.fibPivotSource === 'Wick';
  const negExtLevel = settings.useStandardRatios ? FIB_NEG_0618 : -0.1618;

  const pivotPriceAt = (idx: number, isHigh: boolean): number =>
    useWick
      ? isHigh
        ? highs[idx]
        : lows[idx]
      : isHigh
        ? Math.max(opens[idx], closes[idx])
        : Math.min(opens[idx], closes[idx]);

  // Simple Pivots confirmations, precomputed (value at confirmation bar)
  const ph = settings.fibMethod === 'Simple Pivots' ? pivotHigh(highs, prd, prd) : [];
  const pl = settings.fibMethod === 'Simple Pivots' ? pivotLow(lows, prd, prd) : [];

  // ── Fold state (Pine `var`s) ──
  const zz: number[] = []; // [val, idx, val, idx, ...] newest first, cap 30
  let dir = 0;
  let pendingVal: number | null = null;
  let pendingIdx = 0;
  let pendingDir = 0;
  let pendingBar: number | null = null;
  let hit0618Ret = false;
  let ratios: RatioEntry[] = seedRatios(settings.useStandardRatios);
  let prevBase: number | null = null;
  let prevLast: number | null = null;
  let prevBaseIdx: number | null = null;
  let prevLastIdx: number | null = null;
  let prevAllowMaxPT = -2;
  let prevBand0 = false;
  let prevMaxHit = -1;
  let gannFixedScale: number | null = null;
  let dirAtPrevBarEnd = 0;

  const zzAdd = (value: number, idx: number): void => {
    zz.unshift(value, idx);
    while (zz.length > 30) {
      zz.pop();
      zz.pop();
    }
  };
  const zzUpdate = (value: number, idx: number): void => {
    if (zz.length === 0) {
      zzAdd(value, idx);
    } else if ((dir === 1 && value > zz[0]) || (dir === -1 && value < zz[0])) {
      zz[0] = value;
      zz[1] = idx;
    }
  };

  // Values needed by the geometry assembly after the fold
  let finalBase = 0;
  let finalLast = 0;
  let finalBaseIdx = 0;
  let finalLastIdx = 0;
  let finalUp = true;
  let finalHasSwing = false;
  const finalHits: boolean[] = new Array(10).fill(false); // finalHits[k] = hitK (1..9)
  let finalAllowMaxPT = -1;
  let finalMaxHitRange = 0;

  for (let i = 0; i < n; i++) {
    // ── 1. Swing detection ──
    if (settings.fibMethod === 'Volume Filtered') {
      const confirmDelay = prd;
      const phOff = highestBarsOffset(highs, i, prd);
      const plOff = lowestBarsOffset(lows, i, prd);
      const vOff = highestBarsOffset(volumes, i, prd);
      const snap = 2;
      const nearH = Math.abs(vOff - phOff) <= snap;
      const nearL = Math.abs(vOff - plOff) <= snap;
      const isNewHigh = phOff === 0 && nearH;
      const isNewLow = plOff === 0 && nearL;

      if (isNewHigh && !isNewLow) {
        pendingIdx = i;
        pendingVal = pivotPriceAt(i, true);
        pendingDir = 1;
        pendingBar = i;
      } else if (isNewLow && !isNewHigh) {
        pendingIdx = i;
        pendingVal = pivotPriceAt(i, false);
        pendingDir = -1;
        pendingBar = i;
      } else if (isNewHigh && isNewLow) {
        const mid = (highs[i] + lows[i]) / 2;
        const asHigh = highs[i] - mid >= mid - lows[i];
        pendingIdx = i;
        pendingVal = pivotPriceAt(i, asHigh);
        pendingDir = asHigh ? 1 : -1;
        pendingBar = i;
      }

      if (pendingBar !== null && i - pendingBar >= confirmDelay && pendingVal !== null) {
        let stillValid = true;
        for (let j = 0; j <= Math.min(confirmDelay - 1, i); j++) {
          if (pendingDir === 1) {
            if (highs[i - j] > highs[pendingIdx]) {
              stillValid = false;
              break;
            }
          } else if (lows[i - j] < lows[pendingIdx]) {
            stillValid = false;
            break;
          }
        }
        if (stillValid) {
          const a = atr14[i];
          const minMove = a !== null ? a * 0.25 : null;
          let shouldAdd = true;
          if (zz.length >= 2 && minMove !== null && Math.abs(pendingVal - zz[0]) < minMove) {
            shouldAdd = false;
          }
          if (shouldAdd) {
            if (pendingDir !== dir || zz.length === 0) {
              zzAdd(pendingVal, pendingIdx);
            } else {
              const isHigher = pendingDir === 1 && pendingVal > zz[0];
              const isLower = pendingDir === -1 && pendingVal < zz[0];
              if (isHigher || isLower) zzUpdate(pendingVal, pendingIdx);
            }
            dir = pendingDir;
          }
        }
        pendingVal = null;
        pendingDir = 0;
        pendingBar = null;
      }
    } else {
      // Simple Pivots
      const rawPh = ph[i];
      const rawPl = pl[i];
      const hasHigh = rawPh !== null;
      const hasLow = rawPl !== null;
      const pivotIdx = i - prd;
      if (pivotIdx >= 0 && (hasHigh || hasLow)) {
        const finalPh = hasHigh ? pivotPriceAt(pivotIdx, true) : 0;
        const finalPl = hasLow ? pivotPriceAt(pivotIdx, false) : 0;
        if (hasHigh && hasLow) {
          if (dir === 1) {
            dir = -1;
            zzAdd(finalPl, pivotIdx);
          } else if (dir === -1) {
            dir = 1;
            zzAdd(finalPh, pivotIdx);
          } else {
            dir = 1;
            zzAdd(finalPh, pivotIdx);
          }
        } else if (hasHigh) {
          if (dir === 1) {
            const currentHigh = zz.length > 0 ? zz[0] : -999999;
            if (finalPh > currentHigh) zzUpdate(finalPh, pivotIdx);
          } else {
            dir = 1;
            zzAdd(finalPh, pivotIdx);
          }
        } else if (hasLow) {
          if (dir === -1) {
            const currentLow = zz.length > 0 ? zz[0] : 999999;
            if (finalPl < currentLow) zzUpdate(finalPl, pivotIdx);
          } else {
            dir = -1;
            zzAdd(finalPl, pivotIdx);
          }
        }
      }
    }

    // Gann Auto-ATR scale freezes on the first bar with a valid ATR
    if (settings.gannScaleMethod === 'Auto (ATR-based)' && gannFixedScale === null && atr14[i] !== null) {
      gannFixedScale = (atr14[i] as number) * settings.gannATRMultiplier;
    }

    const swingFlip = dir !== dirAtPrevBarEnd;
    dirAtPrevBarEnd = dir;

    // ── 2. Per-bar fib logic (needs two pivots) ──
    if (zz.length < 4) continue;

    let b = zz[2];
    let l = zz[0];
    let bIdx = Math.round(zz[3]);
    let lIdx = Math.round(zz[1]);
    let d = l - b;
    let up = d >= 0;
    let forceRebuild = false;

    // Instant flip on threshold break
    if (settings.flipEnable) {
      const rFlip =
        settings.flipLevel === '0.000'
          ? 0
          : settings.flipLevel === '±0.618'
            ? up
              ? negExtLevel
              : -negExtLevel
            : up
              ? -1.618
              : 1.618;
      const flipPx = b + d * rFlip;
      const doFlip =
        settings.flipTrigger === 'Wick'
          ? up
            ? lows[i] < flipPx
            : highs[i] > flipPx
          : up
            ? closes[i] < flipPx
            : closes[i] > flipPx;
      if (doFlip) {
        const newVal = settings.flipTrigger === 'Wick' ? (up ? lows[i] : highs[i]) : closes[i];
        zzAdd(newVal, i);
        dir = up ? -1 : 1;
        dirAtPrevBarEnd = dir;
        ratios = seedRatios(settings.useStandardRatios);
        b = zz[2];
        l = zz[0];
        bIdx = Math.round(zz[3]);
        lIdx = Math.round(zz[1]);
        d = l - b;
        up = d >= 0;
        forceRebuild = true;
      }
    }

    const pivotChanged = b !== prevBase || l !== prevLast || bIdx !== prevBaseIdx || lIdx !== prevLastIdx;
    if (swingFlip || pivotChanged || forceRebuild) {
      hit0618Ret = false;
    }

    // ── 3. Hit scan since the last pivot (cap 500 bars, Pine parity) ──
    const maxLookback = Math.min(Math.max(0, i - lIdx), 500, i);
    const hits: boolean[] = new Array(10).fill(false);
    if (maxLookback > 0) {
      let maxHigh = -Infinity;
      let minLow = Infinity;
      for (let j = i - maxLookback + 1; j <= i; j++) {
        maxHigh = Math.max(maxHigh, highs[j]);
        minLow = Math.min(minLow, lows[j]);
      }
      for (let k = 1; k <= 9; k++) {
        const level = b + d * k;
        hits[k] = up ? maxHigh >= level : minLow <= level;
      }
      const lvl0618 = b + d * FIB_0618;
      hit0618Ret = up ? maxHigh >= lvl0618 : minLow <= lvl0618;
    }

    // ── 4. Ratio growth ──
    if (settings.ptAlwaysShowFirst) {
      ensureExtRatios(ratios, [FIB_1618, 1.786], [TWC_COLORS.gold50, TWC_COLORS.gold50]);
    }
    if (hits[1])
      ensureExtRatios(
        ratios,
        [1.162, FIB_1618, 1.786, 2.0],
        [TWC_COLORS.white50, TWC_COLORS.gold50, TWC_COLORS.gold50, TWC_COLORS.white50],
      );
    for (let k = 2; k <= 9; k++) {
      if (hits[k])
        ensureExtRatios(
          ratios,
          [k + 0.618, k + 0.786, k + 1],
          [TWC_COLORS.gold50, TWC_COLORS.gold50, TWC_COLORS.white50],
        );
    }

    // ── 5. PT gates ──
    let allowMaxPT = settings.ptAlwaysShowFirst ? 1 : -1;
    if (hit0618Ret) allowMaxPT = Math.max(allowMaxPT, 0);
    for (let k = 1; k <= 9; k++) {
      if (hits[k]) allowMaxPT = Math.max(allowMaxPT, k);
    }
    let maxHitRange = 0;
    for (let k = 9; k >= 1; k--) {
      if (hits[k]) {
        maxHitRange = k;
        break;
      }
    }

    // Track "rebuild" prev-state like Pine (only relevant for latch semantics)
    const ptChanged = allowMaxPT !== prevAllowMaxPT || hit0618Ret !== prevBand0 || maxHitRange !== prevMaxHit;
    if (swingFlip || pivotChanged || prevBase === null || forceRebuild || ptChanged) {
      prevBase = b;
      prevLast = l;
      prevBaseIdx = bIdx;
      prevLastIdx = lIdx;
      prevAllowMaxPT = allowMaxPT;
      prevBand0 = hit0618Ret;
      prevMaxHit = maxHitRange;
    }

    finalBase = b;
    finalLast = l;
    finalBaseIdx = bIdx;
    finalLastIdx = lIdx;
    finalUp = up;
    finalHasSwing = true;
    for (let k = 1; k <= 9; k++) finalHits[k] = hits[k];
    finalAllowMaxPT = allowMaxPT;
    finalMaxHitRange = maxHitRange;
  }

  if (!finalHasSwing) return empty;

  // ── Geometry assembly from the final-bar state ──
  const lastBar = n - 1;
  const diff = finalLast - finalBase;
  const clampStart = (x: number): number =>
    Math.min(Math.max(x, Math.max(0, lastBar - FIB_LINE_LOOKBACK)), lastBar);

  const finalAtr = atr14[lastBar];
  let pricePerBar: number;
  if (settings.gannScaleMethod === 'Swing-Relative (Original)') {
    pricePerBar = Math.abs(diff) / Math.max(1, Math.abs(finalLastIdx - finalBaseIdx));
  } else if (settings.gannScaleMethod === 'Auto (ATR-based)') {
    pricePerBar = gannFixedScale ?? (finalAtr !== null ? finalAtr * settings.gannATRMultiplier : 0);
  } else {
    pricePerBar = settings.gannManualScale;
  }
  if (!pricePerBar) pricePerBar = finalAtr !== null ? finalAtr * 0.1 : 1;

  const boxH = Math.abs(diff);
  const gannWidth = Math.min(Math.max(1, Math.round(boxH / pricePerBar)), 500);
  const gannXL = clampStart(finalLastIdx);
  const gannXR = Math.min(gannXL + gannWidth, lastBar + 500);

  const extensionBars = settings.showGannFan ? Math.max(FIB_PROJ_X_RIGHT, gannXR - lastBar) : FIB_PROJ_X_RIGHT;
  const xRight = lastBar + extensionBars;

  const segments: TwcSegment[] = [];
  const bands: TwcBand[] = [];
  const labels: TwcLabel[] = [];

  // Per-ratio visibility ladder (hit-gated; alwaysShowFirst reveals exactly
  // the 1.618/1.786 band lines early)
  const ratioVisible = (r: number): boolean => {
    if (r <= 1 + FIB_EPSILON) return true;
    if (r <= 2 + FIB_EPSILON) {
      return (
        finalHits[1] ||
        (settings.ptAlwaysShowFirst && (approxEqual(r, round4(FIB_1618)) || approxEqual(r, 1.786)))
      );
    }
    for (let k = 2; k <= 9; k++) {
      if (r <= k + 1 + FIB_EPSILON) return finalHits[k];
    }
    return finalHits[9];
  };

  const ratioX1 = new Map<number, number>();
  for (const entry of ratios) {
    const x1 = clampStart(approxEqual(entry.ratio, 1) ? finalLastIdx : finalBaseIdx);
    ratioX1.set(entry.ratio, x1);
    if (!ratioVisible(entry.ratio)) continue;
    const level = finalBase + diff * entry.ratio;
    segments.push({ x1, y1: level, x2: xRight, y2: level, color: entry.color, width: 2, style: 'solid' });

    if (settings.showFibRatioLabels || settings.showFibPriceLabels) {
      const parts: string[] = [];
      if (settings.showFibRatioLabels) parts.push(entry.ratio.toFixed(4).replace(/\.?0+$/, '') || '0');
      if (settings.showFibPriceLabels) {
        const price = level.toFixed(2);
        parts.push(settings.showFibRatioLabels ? `(${price})` : price);
      }
      labels.push({
        barIndex: settings.fibLabelPosition === 'Left' ? x1 - 1 : xRight,
        price: level,
        text: parts.join('  '),
        textColor: TWC_COLORS.fibLabel,
        align: settings.fibLabelPosition === 'Left' ? 'right' : 'left',
      });
    }
  }

  // Profit-target bands + labels
  if (settings.shadeBands || settings.showPTLabels) {
    let ptN = 1;
    for (let kk = 0; kk <= Math.max(0, finalAllowMaxPT); kk++) {
      if (kk > finalAllowMaxPT) continue;
      // Pine parity: band 0 (the 0.618–0.786 retracement shade) NEVER
      // renders on TradingView — the script looks up its 0.786 end line by
      // the literal key "0.786" while the stored seed ratio rounds to
      // 0.7862, so the map lookup silently fails. Reproduce that exactly.
      if (kk === 0) continue;
      const rStart = round4(kk + 0.618);
      const rEnd = round4(kk + 0.786);
      const startEntry = ratios.find((e) => approxEqual(e.ratio, rStart));
      const endEntry = ratios.find((e) => approxEqual(e.ratio, rEnd));
      if (!startEntry || !endEntry) continue;
      const yStart = finalBase + diff * startEntry.ratio;
      const yEnd = finalBase + diff * endEntry.ratio;
      const xLeft = Math.max(ratioX1.get(startEntry.ratio) ?? 0, ratioX1.get(endEntry.ratio) ?? 0);
      if (settings.shadeBands) {
        bands.push({
          x1: xLeft,
          x2: xRight,
          yTop: Math.max(yStart, yEnd),
          yBottom: Math.min(yStart, yEnd),
          fillColor: TWC_COLORS.amberBand,
        });
      }
      const isExtBand = rStart >= 1;
      if (settings.showPTLabels && (isExtBand || !settings.ptExtensionsOnly)) {
        labels.push({
          barIndex: Math.min(xLeft + 20, lastBar + FIB_PROJ_X_RIGHT / 2),
          price: (yStart + yEnd) / 2,
          text: `${settings.ptPrefix}${ptN}`,
          textColor: TWC_COLORS.ptText,
          bgColor: TWC_COLORS.ptPill,
          align: 'center',
        });
      }
      if (isExtBand) ptN += 1;
    }
  }

  // Gann squares: projected forward from the fib-1 pivot; one square per
  // unlocked extension range, stacked vertically in the same time span
  if (settings.showGannFan && gannXR - gannXL >= 1 && boxH > 0) {
    const boxW = gannXR - gannXL;
    const fanAngles: { on: boolean; ratio: number }[] = [
      { on: settings.gann1x1, ratio: 1 },
      { on: settings.gann2x1, ratio: 2 },
      { on: settings.gann1x2, ratio: 0.5 },
      { on: settings.gann3x1, ratio: 3 },
      { on: settings.gann1x3, ratio: 0.333 },
      { on: settings.gann4x1, ratio: 4 },
      { on: settings.gann1x4, ratio: 0.25 },
      { on: settings.gann8x1, ratio: 8 },
      { on: settings.gann1x8, ratio: 0.125 },
    ];
    const cornerRay = (cx: number, cy: number, dxSign: number, dySign: number, ratio: number): void => {
      const endX = ratio <= 1 ? cx + dxSign * boxW : cx + dxSign * Math.max(1, Math.round(boxW / ratio));
      const endY = ratio <= 1 ? cy + dySign * ratio * boxH : cy + dySign * boxH;
      segments.push({ x1: cx, y1: cy, x2: endX, y2: endY, color: TWC_COLORS.gannFan, width: 1, style: 'dotted' });
    };
    for (let k = 0; k <= Math.max(0, finalMaxHitRange); k++) {
      const yA = finalBase + diff * k;
      const yB = finalBase + diff * (k + 1);
      const yTop = Math.max(yA, yB);
      const yBot = Math.min(yA, yB);
      for (const angle of fanAngles) {
        if (!angle.on) continue;
        cornerRay(gannXL, yTop, +1, -1, angle.ratio);
        cornerRay(gannXL, yBot, +1, +1, angle.ratio);
        cornerRay(gannXR, yTop, -1, -1, angle.ratio);
        cornerRay(gannXR, yBot, -1, +1, angle.ratio);
      }
      if (settings.showGannBox) {
        const frame = TWC_COLORS.gannBox;
        segments.push({ x1: gannXL, y1: yTop, x2: gannXR, y2: yTop, color: frame, width: 1, style: 'dashed' });
        segments.push({ x1: gannXL, y1: yBot, x2: gannXR, y2: yBot, color: frame, width: 1, style: 'dashed' });
        segments.push({ x1: gannXL, y1: yTop, x2: gannXL, y2: yBot, color: frame, width: 1, style: 'dashed' });
        segments.push({ x1: gannXR, y1: yTop, x2: gannXR, y2: yBot, color: frame, width: 1, style: 'dashed' });
      }
    }
  }

  // `finalUp` documents swing direction for future consumers (confluence
  // engine, phase 2); geometry itself is direction-agnostic.
  void finalUp;

  return { segments, bands, labels };
}
