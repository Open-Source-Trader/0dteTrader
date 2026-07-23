/**
 * TWC Heatmap V5 — SMC subset for phase 2: swing/internal structure state
 * (always computed — it feeds the confluence engine's bias inputs), order
 * blocks, and premium/discount zones. Ports the LuxAlgo-heritage Pine
 * sections bar-by-bar; drawing is assembled from the final-bar state, exactly
 * like Pine's present-mode redraw. Keep in sync with TwcSmc.swift.
 *
 * Out of scope here (still phase 3): BOS/CHoCH lines & labels, EQH/EQL, FVG,
 * D/W/M levels, strong/weak high/low. The Pine confluence filter for internal
 * structure defaults OFF and is not ported.
 */

import { TWC_COLORS } from './twcColors';
import type { TwcHeatmapSettings } from './twcSettings';
import type { TwcBand, TwcLabel } from './twcTypes';
import { pineAtr, type TwcCandle } from './twcMath';

const INTERNAL_SIZE = 5;
const ZONE_EXTEND_BARS = 20;
const OB_EXTEND_BARS = 40;
const MAX_ORDER_BLOCKS = 100;

interface PivotState {
  currentLevel: number | null;
  /** The level as of the END of the previous bar — Pine's ta.crossover
   * compares close[1] against level[1], which matters on the exact bar a new
   * pivot confirms. */
  prevBarLevel: number | null;
  crossed: boolean;
  barIndex: number;
}

interface OrderBlock {
  barHigh: number;
  barLow: number;
  barIndex: number;
  bias: number; // +1 bullish, -1 bearish
}

export interface TwcSmcResult {
  /** Per-bar swing/internal structure bias (+1 / -1 / 0) for the confluence engine. */
  swingBias: number[];
  internalBias: number[];
  bands: TwcBand[];
  labels: TwcLabel[];
}

/**
 * Pine leg(): 0 = bearish leg (new high `size` bars back), 1 = bullish leg.
 * A leg flips when the bar `size` back exceeds every bar since.
 */
function legAt(
  values: { highs: number[]; lows: number[] },
  i: number,
  size: number,
  prevLeg: number,
): number {
  if (i < size) return prevLeg;
  let windowHigh = -Infinity;
  let windowLow = Infinity;
  for (let j = i - size + 1; j <= i; j++) {
    windowHigh = Math.max(windowHigh, values.highs[j]);
    windowLow = Math.min(windowLow, values.lows[j]);
  }
  if (values.highs[i - size] > windowHigh) return 0; // BEARISH_LEG
  if (values.lows[i - size] < windowLow) return 1; // BULLISH_LEG
  return prevLeg;
}

export function computeSmc(candles: TwcCandle[], settings: TwcHeatmapSettings): TwcSmcResult {
  const n = candles.length;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const series = { highs, lows };

  const swingBias: number[] = new Array(n).fill(0);
  const internalBias: number[] = new Array(n).fill(0);
  const empty: TwcSmcResult = { swingBias, internalBias, bands: [], labels: [] };
  if (n === 0) return empty;

  const wantSwingOB = settings.showSwingOrderBlocks;
  const wantInternalOB = settings.showInternalOrderBlocks;
  const mitigateOnClose = settings.orderBlockMitigation === 'Close';

  // Volatility parse (Pine: swap high/low on bars ranging >= 2x the measure)
  const atr200 = pineAtr(candles, 200);
  const parsedHighs: number[] = new Array(n);
  const parsedLows: number[] = new Array(n);
  let cumTrueRange = 0;
  for (let i = 0; i < n; i++) {
    const prevClose = i > 0 ? closes[i - 1] : closes[i];
    cumTrueRange += Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - prevClose),
      Math.abs(lows[i] - prevClose),
    );
    const measure = settings.orderBlockFilter === 'Atr' ? atr200[i] : cumTrueRange / Math.max(i, 1);
    const highVolatility = measure !== null && highs[i] - lows[i] >= 2 * measure;
    parsedHighs[i] = highVolatility ? lows[i] : highs[i];
    parsedLows[i] = highVolatility ? highs[i] : lows[i];
  }

  // ── Fold state (Pine `var`s) ──
  const swingHigh: PivotState = {
    currentLevel: null,
    prevBarLevel: null,
    crossed: false,
    barIndex: 0,
  };
  const swingLow: PivotState = {
    currentLevel: null,
    prevBarLevel: null,
    crossed: false,
    barIndex: 0,
  };
  const internalHigh: PivotState = {
    currentLevel: null,
    prevBarLevel: null,
    crossed: false,
    barIndex: 0,
  };
  const internalLow: PivotState = {
    currentLevel: null,
    prevBarLevel: null,
    crossed: false,
    barIndex: 0,
  };
  let swingTrendBias = 0;
  let internalTrendBias = 0;
  let legSwing = 0;
  let legInternal = 0;
  let trailingTop: number | null = null;
  let trailingBottom: number | null = null;
  let lastTopIdx = 0;
  let lastBottomIdx = 0;
  const swingOrderBlocks: OrderBlock[] = [];
  const internalOrderBlocks: OrderBlock[] = [];

  const storeOrderBlock = (
    pivot: PivotState,
    internal: boolean,
    bias: number,
    barIndex: number,
  ): void => {
    if (internal ? !wantInternalOB : !wantSwingOB) return;
    // Bearish blocks anchor at the highest parsed high since the broken
    // pivot; bullish at the lowest parsed low (Pine storeOrdeBlock).
    let anchor = pivot.barIndex;
    for (let j = pivot.barIndex; j < barIndex; j++) {
      if (bias === -1) {
        if (parsedHighs[j] > parsedHighs[anchor]) anchor = j;
      } else if (parsedLows[j] < parsedLows[anchor]) {
        anchor = j;
      }
    }
    const blocks = internal ? internalOrderBlocks : swingOrderBlocks;
    if (blocks.length >= MAX_ORDER_BLOCKS) blocks.pop();
    blocks.unshift({
      barHigh: parsedHighs[anchor],
      barLow: parsedLows[anchor],
      barIndex: anchor,
      bias,
    });
  };

  const deleteOrderBlocks = (blocks: OrderBlock[], i: number): void => {
    for (let index = blocks.length - 1; index >= 0; index--) {
      const block = blocks[index];
      const bearishSource = mitigateOnClose ? closes[i] : highs[i];
      const bullishSource = mitigateOnClose ? closes[i] : lows[i];
      const crossed =
        (block.bias === -1 && bearishSource > block.barHigh) ||
        (block.bias === 1 && bullishSource < block.barLow);
      if (crossed) blocks.splice(index, 1);
    }
  };

  // displayStructure: a close crossing the tracked pivot flips the bias and
  // (when enabled) stores an order block from the opposing extreme.
  const displayStructure = (internal: boolean, i: number): void => {
    const pivotHigh = internal ? internalHigh : swingHigh;
    const pivotLow = internal ? internalLow : swingLow;
    const prevClose = i > 0 ? closes[i - 1] : closes[i];

    // Internal breaks that coincide with the swing level defer to the swing
    // structure (Pine extra condition; confluence filter input not ported).
    const extraBull = internal ? internalHigh.currentLevel !== swingHigh.currentLevel : true;
    if (
      pivotHigh.currentLevel !== null &&
      pivotHigh.prevBarLevel !== null &&
      !pivotHigh.crossed &&
      extraBull &&
      closes[i] > pivotHigh.currentLevel &&
      prevClose <= pivotHigh.prevBarLevel
    ) {
      pivotHigh.crossed = true;
      if (internal) internalTrendBias = 1;
      else swingTrendBias = 1;
      storeOrderBlock(pivotHigh, internal, 1, i);
    }

    const extraBear = internal ? internalLow.currentLevel !== swingLow.currentLevel : true;
    if (
      pivotLow.currentLevel !== null &&
      pivotLow.prevBarLevel !== null &&
      !pivotLow.crossed &&
      extraBear &&
      closes[i] < pivotLow.currentLevel &&
      prevClose >= pivotLow.prevBarLevel
    ) {
      pivotLow.crossed = true;
      if (internal) internalTrendBias = -1;
      else swingTrendBias = -1;
      storeOrderBlock(pivotLow, internal, -1, i);
    }
  };

  const applyStructure = (internal: boolean, size: number, i: number, prevLeg: number): number => {
    const leg = legAt(series, i, size, prevLeg);
    if (leg !== prevLeg && i >= size) {
      const pivotIdx = i - size;
      if (leg === 1) {
        // start of bullish leg → confirmed pivot LOW
        const pivot = internal ? internalLow : swingLow;
        pivot.currentLevel = lows[pivotIdx];
        pivot.crossed = false;
        pivot.barIndex = pivotIdx;
        if (!internal) {
          trailingBottom = pivot.currentLevel;
          lastBottomIdx = pivotIdx;
        }
      } else {
        // start of bearish leg → confirmed pivot HIGH
        const pivot = internal ? internalHigh : swingHigh;
        pivot.currentLevel = highs[pivotIdx];
        pivot.crossed = false;
        pivot.barIndex = pivotIdx;
        if (!internal) {
          trailingTop = pivot.currentLevel;
          lastTopIdx = pivotIdx;
        }
      }
    }
    return leg;
  };

  for (let i = 0; i < n; i++) {
    // Trailing extremes feed the premium/discount zones (Pine gates the
    // per-bar update on the display toggle; pivot resets are unconditional).
    if (settings.showPremiumDiscountZones) {
      trailingTop = Math.max(highs[i], trailingTop ?? highs[i]);
      if (trailingTop === highs[i]) lastTopIdx = i;
      trailingBottom = Math.min(lows[i], trailingBottom ?? lows[i]);
      if (trailingBottom === lows[i]) lastBottomIdx = i;
    }

    legSwing = applyStructure(false, settings.swingsLength, i, legSwing);
    legInternal = applyStructure(true, INTERNAL_SIZE, i, legInternal);

    // Structure state always updates (confluence bias); OB storage is gated
    // inside storeOrderBlock, mirroring the Pine execution block.
    displayStructure(true, i);
    displayStructure(false, i);

    if (wantInternalOB) deleteOrderBlocks(internalOrderBlocks, i);
    if (wantSwingOB) deleteOrderBlocks(swingOrderBlocks, i);

    swingBias[i] = swingTrendBias;
    internalBias[i] = internalTrendBias;

    // Snapshot each pivot level for next bar's crossover [1] comparison
    swingHigh.prevBarLevel = swingHigh.currentLevel;
    swingLow.prevBarLevel = swingLow.currentLevel;
    internalHigh.prevBarLevel = internalHigh.currentLevel;
    internalLow.prevBarLevel = internalLow.currentLevel;
  }

  // ── Final-bar drawing ──
  const bands: TwcBand[] = [];
  const labels: TwcLabel[] = [];
  const lastBar = n - 1;

  const pushOrderBlocks = (blocks: OrderBlock[], count: number, internal: boolean): void => {
    for (const block of blocks.slice(0, Math.min(count, blocks.length))) {
      const bullish = block.bias === 1;
      let fillColor: string;
      if (internal) {
        fillColor = bullish ? TWC_COLORS.internalBullishOB : TWC_COLORS.internalBearishOB;
      } else {
        fillColor = bullish ? TWC_COLORS.swingBullishOB : TWC_COLORS.swingBearishOB;
      }
      // Pine: swing blocks are outlined, internal blocks are fill-only
      let borderColor: string | undefined;
      if (!internal) {
        borderColor = bullish ? TWC_COLORS.swingBullishOBBorder : TWC_COLORS.swingBearishOBBorder;
      }
      bands.push({
        x1: block.barIndex,
        x2: lastBar + OB_EXTEND_BARS,
        yTop: block.barHigh,
        yBottom: block.barLow,
        fillColor,
        borderColor,
      });
    }
  };
  if (wantInternalOB) pushOrderBlocks(internalOrderBlocks, settings.internalOrderBlocksSize, true);
  if (wantSwingOB) pushOrderBlocks(swingOrderBlocks, settings.swingOrderBlocksSize, false);

  if (settings.showPremiumDiscountZones && trailingTop !== null && trailingBottom !== null) {
    const top = trailingTop;
    const bottom = trailingBottom;
    const leftIdx = Math.min(lastTopIdx, lastBottomIdx);
    const rightIdx = lastBar + ZONE_EXTEND_BARS;
    const premiumBottom = 0.95 * top + 0.05 * bottom;
    const equilibriumTop = 0.525 * top + 0.475 * bottom;
    const equilibriumBottom = 0.525 * bottom + 0.475 * top;
    const discountTop = 0.95 * bottom + 0.05 * top;

    const zone = (
      yTop: number,
      yBottom: number,
      fill: string,
      text: string,
      textColor: string,
    ): void => {
      bands.push({ x1: leftIdx, x2: rightIdx, yTop, yBottom, fillColor: fill });
      labels.push({
        barIndex: rightIdx,
        price: (yTop + yBottom) / 2,
        text,
        textColor,
        align: 'left',
      });
    };
    zone(top, premiumBottom, TWC_COLORS.premiumZone, 'Premium', TWC_COLORS.premiumText);
    zone(
      equilibriumTop,
      equilibriumBottom,
      TWC_COLORS.equilibriumZone,
      'Equilibrium',
      TWC_COLORS.equilibriumText,
    );
    zone(discountTop, bottom, TWC_COLORS.discountZone, 'Discount', TWC_COLORS.discountText);
  }

  return { swingBias, internalBias, bands, labels };
}
