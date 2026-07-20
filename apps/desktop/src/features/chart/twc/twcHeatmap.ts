/**
 * TWC Heatmap V5 — heatmap ensemble (HMM + MSI), SuperTrend stack, MACD
 * alignment, Bollinger envelope, markers, regime candle colors and the bias
 * banner. Pure port of the Pine sections; keep in sync with TwcHeatmap.swift.
 */

import { bollingerBands, ema, macd } from '../indicatorEngine';
import { TWC_COLORS, withOpacity } from './twcColors';
import type { TwcHeatmapSettings } from './twcSettings';
import type { TwcAreaFill, TwcBanner, TwcLine, TwcMarker } from './twcTypes';
import {
  crossesOver,
  crossesUnder,
  cogSeries,
  gaussPdf,
  linreg,
  mapConfirmedHtf,
  pineAtr,
  resampleHtf,
  seriesCrossOver,
  seriesCrossUnder,
  sessionVwap,
  sourceSeries,
  supertrend,
  zscore,
  type TwcCandle,
} from './twcMath';

// HMM emission archetypes (mean, sigma) per state for (return, volatility)
const MU_RET = { bull: 0.7, chop: 0.0, bear: -0.7 };
const SD_RET = { bull: 0.9, chop: 0.6, bear: 0.9 };
const MU_VOL = { bull: 0.3, chop: -0.3, bear: 0.5 };
const SD_VOL = { bull: 1.0, chop: 0.8, bear: 1.0 };

export interface TwcHeatmapResult {
  candleColors: (string | null)[] | null;
  markers: TwcMarker[];
  lines: TwcLine[];
  fills: TwcAreaFill[];
  banner: TwcBanner | null;
  /** ta.atr(14) reused by the fib engine (minMove + Gann fallback scale). */
  atr14: (number | null)[];
  // ── Per-bar series consumed by the confluence engine ──
  msi: (number | null)[];
  /** CTF supertrend direction sign per bar: +1 bull, -1 bear, 0 warm-up. */
  ctfDir: number[];
  /** All-enabled HTF stack agreement per bar (+1/-1/0), respecting toggles. */
  stackDir: number[];
  /** ST-gated heatmap LONG/SHORT triggers per bar. */
  crossUp: boolean[];
  crossDn: boolean[];
}

export function computeHeatmap(
  candles: TwcCandle[],
  settings: TwcHeatmapSettings,
  intervalSeconds: number,
): TwcHeatmapResult {
  const n = candles.length;
  const src = sourceSeries(candles, settings.source);
  const closes = candles.map((c) => c.close);
  const atr14 = pineAtr(candles, 14);

  // ── MODEL 1: HMM observations ──
  const logret: (number | null)[] = src.map((v, i) => {
    const prev = i > 0 ? src[i - 1] : v;
    return prev === 0 ? 0 : Math.log(v / prev);
  });
  const zRet = zscore(logret, settings.hmmLook);
  const zVol = zscore(atr14, settings.hmmLook);

  // HMM forward fold (posteriors seeded uniform; na observations carry the
  // transition prior forward — same as Pine's underflow branch)
  const off = (1 - settings.hmmStay) / 2;
  const stay = settings.hmmStay;
  let pBull = 1 / 3;
  let pChop = 1 / 3;
  let pBear = 1 / 3;
  const hmmDominant: number[] = new Array(n).fill(0);
  const sHmm: number[] = new Array(n).fill(1 / 3);
  for (let i = 0; i < n; i++) {
    const priBull = stay * pBull + off * pChop + off * pBear;
    const priChop = off * pBull + stay * pChop + off * pBear;
    const priBear = off * pBull + off * pChop + stay * pBear;
    const zr = zRet[i];
    const zv = zVol[i];
    let unSum = 0;
    let unBull = 0;
    let unChop = 0;
    let unBear = 0;
    if (zr !== null && zv !== null) {
      unBull =
        priBull * gaussPdf(zr, MU_RET.bull, SD_RET.bull) * gaussPdf(zv, MU_VOL.bull, SD_VOL.bull);
      unChop =
        priChop * gaussPdf(zr, MU_RET.chop, SD_RET.chop) * gaussPdf(zv, MU_VOL.chop, SD_VOL.chop);
      unBear =
        priBear * gaussPdf(zr, MU_RET.bear, SD_RET.bear) * gaussPdf(zv, MU_VOL.bear, SD_VOL.bear);
      unSum = unBull + unChop + unBear;
    }
    if (unSum > 0) {
      pBull = unBull / unSum;
      pChop = unChop / unSum;
      pBear = unBear / unSum;
    } else {
      pBull = priBull;
      pChop = priChop;
      pBear = priBear;
    }
    hmmDominant[i] = pBull >= Math.max(pChop, pBear) ? 1 : pBear >= Math.max(pBull, pChop) ? -1 : 0;
    sHmm[i] = pBull;
  }

  // ── MODEL 2: VWAP z-score ──
  const vw = sessionVwap(candles, intervalSeconds);
  const dev: (number | null)[] = src.map((v, i) => (vw[i] === null ? null : v - (vw[i] as number)));
  const vwapZ = zscore(dev, settings.vwapLook);

  // ── MODEL 3: linear regression slope sign ──
  const lrNow = linreg(src, settings.lenLR, 0);
  const lrPrev = linreg(src, settings.lenLR, 1);
  const lrSign: number[] = src.map((_, i) => {
    const a = lrNow[i];
    const b = lrPrev[i];
    if (a === null || b === null) return 0;
    const slope = a - b;
    return slope > 0 ? 1 : slope < 0 ? -1 : 0;
  });

  // ── MODEL 4: Holt-Winters velocity ──
  let hwLevel: number | null = null;
  let hwTrend = 0;
  const hwSign: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const prevLevel: number = hwLevel === null ? src[i] : hwLevel;
    hwLevel = settings.hwAlpha * src[i] + (1 - settings.hwAlpha) * (prevLevel + hwTrend);
    hwTrend = settings.hwBeta * (hwLevel - prevLevel) + (1 - settings.hwBeta) * hwTrend;
    hwSign[i] = hwTrend > 0 ? 1 : hwTrend < 0 ? -1 : 0;
  }

  // ── MODEL 5: Center of Gravity turn sign ──
  const cog = cogSeries(src, settings.lenCoG);
  const cogSign: number[] = cog.map((v, i) => {
    const prev = i > 0 ? cog[i - 1] : 0;
    return v > prev ? 1 : v < prev ? -1 : 0;
  });

  // ── Forecast index + MSI composite ──
  const ema20 = ema(src, 20);
  const ema50 = ema(src, 50);
  let trendRun = 0;
  const msi: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const voteSum = lrSign[i] + hwSign[i] + cogSign[i];
    const forecastIdx = voteSum > 0 ? 1 : voteSum < 0 ? -1 : 0;
    const e20 = ema20[i];
    const e50 = ema50[i];
    const emaVel = e20 !== null && e50 !== null ? (e20 > e50 ? 1 : e20 < e50 ? -1 : 0) : 0;
    const prevLr = i > 0 ? lrSign[i - 1] : 0;
    trendRun = lrSign[i] === prevLr && lrSign[i] !== 0 ? trendRun + 1 : 0;
    const runScore = Math.min(trendRun, 20) / 20;

    const vz = vwapZ[i];
    if (vz === null) continue; // MSI is na until the VWAP z-score warms up
    const sFcst = (forecastIdx + 1) / 2;
    const sVwap = Math.max(0, Math.min(1, 0.5 + vz / 4));
    const sEmav = (emaVel + 1) / 2;
    const sRun = lrSign[i] > 0 ? 0.5 + 0.5 * runScore : lrSign[i] < 0 ? 0.5 - 0.5 * runScore : 0.5;
    msi[i] = 100 * (0.3 * sHmm[i] + 0.3 * sFcst + 0.15 * sVwap + 0.15 * sEmav + 0.1 * sRun);
  }

  // ── SuperTrend stack ──
  const ctf = supertrend(candles, settings.ctfMultiplier, settings.ctfAtrLength);
  const { htfCandles, chartToHtf } = resampleHtf(candles, intervalSeconds);
  const htfAtrLen = settings.useCustomHTFAtrLength ? settings.htfAtrLength : 50;
  const htf3 = supertrend(htfCandles, 3.0, htfAtrLen);
  const htf4 = supertrend(htfCandles, 4.0, htfAtrLen);
  const htf3Value = mapConfirmedHtf(htf3.value, chartToHtf);
  const htf3Dir = mapConfirmedHtf(htf3.direction, chartToHtf);
  const htf4Value = mapConfirmedHtf(htf4.value, chartToHtf);
  const htf4Dir = mapConfirmedHtf(htf4.direction, chartToHtf);

  // ── MACD alignment (12/26/9 EMA cross; the engine's compacted-signal EMA
  //    matches Pine's na-skipping ta.ema behavior) ──
  const macdValues = macd(candles, settings.macdFast, settings.macdSlow, settings.macdSignal);

  // ── Bollinger (length fixed 20) ──
  const bb2 = bollingerBands(candles, 20, 2);
  const bb3 = bollingerBands(candles, 20, 3);

  // ── Per-bar signal derivation ──
  const markers: TwcMarker[] = [];
  const candleColors: (string | null)[] | null = settings.colorBars
    ? new Array(n).fill(null)
    : null;
  const ctfDirOut: number[] = new Array(n).fill(0);
  const stackDirOut: number[] = new Array(n).fill(0);
  const crossUpOut: boolean[] = new Array(n).fill(false);
  const crossDnOut: boolean[] = new Array(n).fill(false);
  let lastStackBull = false;
  let lastStackBear = false;

  for (let i = 0; i < n; i++) {
    const ctfDir = ctf.direction[i];
    const ctfBullish = ctfDir !== null && ctfDir < 0;
    const ctfBearish = ctfDir !== null && ctfDir > 0;
    const h3 = htf3Dir[i];
    // NOTE: the gate reads the HTF x3 direction regardless of the showHTF3
    // display toggle (Pine behavior); HTF warm-up (null) blocks signals.
    const stackAgreeBull = ctfBullish && h3 !== null && h3 < 0;
    const stackAgreeBear = ctfBearish && h3 !== null && h3 > 0;
    if (i === n - 1) {
      lastStackBull = stackAgreeBull;
      lastStackBear = stackAgreeBear;
    }
    ctfDirOut[i] = ctfBullish ? 1 : ctfBearish ? -1 : 0;

    // All-ENABLED HTF stack agreement (display toggles included, unlike the
    // signal gate above) — the confluence engine's `stackDir` component.
    // Pine counts a toggled-on HTF toward enabledCount even while its
    // direction is still warming up (na), which forces stackDir to 0 then.
    const h4 = htf4Dir[i];
    const included3 = settings.showHTF3;
    const included4 = settings.showHTF4;
    const enabledCount = (included3 ? 1 : 0) + (included4 ? 1 : 0);
    const bullCount =
      (included3 && h3 !== null && h3 < 0 ? 1 : 0) + (included4 && h4 !== null && h4 < 0 ? 1 : 0);
    const bearCount =
      (included3 && h3 !== null && h3 > 0 ? 1 : 0) + (included4 && h4 !== null && h4 > 0 ? 1 : 0);
    stackDirOut[i] =
      enabledCount > 0 && bullCount === enabledCount
        ? 1
        : enabledCount > 0 && bearCount === enabledCount
          ? -1
          : 0;

    // ST-gated heatmap triggers (independent of showMarkers; feed CL/CS too)
    const rawUp = crossesOver(msi, i, settings.msiBullThr) && hmmDominant[i] === 1;
    const rawDn = crossesUnder(msi, i, settings.msiBearThr) && hmmDominant[i] === -1;
    crossUpOut[i] = rawUp && stackAgreeBull;
    crossDnOut[i] = rawDn && stackAgreeBear;

    // Regime candle color: saturation tracks |MSI - 50| (Pine conv/alpha math)
    if (candleColors) {
      const m = msi[i];
      const hidden = settings.hideUnalignedCandles && !stackAgreeBull && !stackAgreeBear;
      if (m !== null && !hidden) {
        const conv = Math.max(0, Math.min(1, Math.abs(m - 50) / 50));
        const transparency = Math.round(80 - conv * 70);
        const base =
          hmmDominant[i] === 1
            ? TWC_COLORS.bull
            : hmmDominant[i] === -1
              ? TWC_COLORS.bear
              : TWC_COLORS.chop;
        candleColors[i] = withOpacity(base, (100 - transparency) / 100);
      }
    }

    if (settings.showMarkers) {
      // Regime flip diamonds
      const prevDom = i > 0 ? hmmDominant[i - 1] : 0;
      if (hmmDominant[i] === 1 && prevDom !== 1) {
        markers.push({
          barIndex: i,
          placement: 'belowBar',
          shape: 'diamond',
          color: TWC_COLORS.bull,
          size: 'tiny',
        });
      }
      if (hmmDominant[i] === -1 && prevDom !== -1) {
        markers.push({
          barIndex: i,
          placement: 'aboveBar',
          shape: 'diamond',
          color: TWC_COLORS.bear,
          size: 'tiny',
        });
      }

      // ST-gated heatmap LONG/SHORT triangles
      if (crossUpOut[i]) {
        markers.push({
          barIndex: i,
          placement: 'belowBar',
          shape: 'triangleUp',
          color: TWC_COLORS.bull,
          size: 'small',
        });
      }
      if (crossDnOut[i]) {
        markers.push({
          barIndex: i,
          placement: 'aboveBar',
          shape: 'triangleDown',
          color: TWC_COLORS.bear,
          size: 'small',
        });
      }
    }

    // VWAP rip: |z| first crossing the stretch threshold, split by sign
    // (the Pine alert-only trigger, surfaced as amber chart pills).
    // Pine's nz(vwapZ[1]) substitutes 0 for na, so the rip can fire on the
    // very first bar the z-score exists.
    if (settings.showVwapRip) {
      const z = vwapZ[i];
      const zPrev = i > 0 ? vwapZ[i - 1] : null;
      const zPrevAbs = zPrev === null ? 0 : Math.abs(zPrev);
      if (z !== null && Math.abs(z) >= settings.vwapWarn && zPrevAbs < settings.vwapWarn) {
        if (z > 0) {
          markers.push({
            barIndex: i,
            placement: 'aboveBar',
            shape: 'labelDown',
            color: TWC_COLORS.vwapRip,
            size: 'tiny',
            text: 'RIP',
          });
        } else {
          markers.push({
            barIndex: i,
            placement: 'belowBar',
            shape: 'labelUp',
            color: TWC_COLORS.vwapRip,
            size: 'tiny',
            text: 'RIP',
          });
        }
      }
    }

    // MACD + SuperTrend alignment triangles (own toggle, not showMarkers)
    if (settings.showMacdAlign) {
      if (seriesCrossOver(macdValues.macdLine, macdValues.signalLine, i) && stackAgreeBull) {
        markers.push({
          barIndex: i,
          placement: 'belowBar',
          shape: 'triangleUp',
          color: TWC_COLORS.macdBull,
          size: 'small',
        });
      }
      if (seriesCrossUnder(macdValues.macdLine, macdValues.signalLine, i) && stackAgreeBear) {
        markers.push({
          barIndex: i,
          placement: 'aboveBar',
          shape: 'triangleDown',
          color: TWC_COLORS.macdBear,
          size: 'small',
        });
      }
    }

    // CTF flip Buy/Sell pills
    if (settings.showBuySellSignals && i > 0) {
      const prevDir = ctf.direction[i - 1];
      if (ctfBullish && prevDir !== null && prevDir > 0) {
        markers.push({
          barIndex: i,
          placement: 'belowBar',
          shape: 'labelUp',
          color: TWC_COLORS.stBull,
          size: 'tiny',
          text: 'Buy',
        });
      }
      if (ctfBearish && prevDir !== null && prevDir < 0) {
        markers.push({
          barIndex: i,
          placement: 'aboveBar',
          shape: 'labelDown',
          color: TWC_COLORS.stBear,
          size: 'tiny',
          text: 'Sell',
        });
      }
    }

    // Envelope rejection triangles: confirmed on the CLOSED prior bar,
    // drawn one bar back (Pine offset = -1)
    if (settings.showEnvelopeRejection && i >= 1) {
      const useThird = settings.rejectionEnvelope === '3 Std';
      const upperArr = useThird ? bb3.upper : bb2.upper;
      const lowerArr = useThird ? bb3.lower : bb2.lower;
      const u1 = upperArr[i - 1];
      const l1 = lowerArr[i - 1];
      if (
        u1 !== null &&
        candles[i - 1].high > u1 &&
        candles[i - 1].close < u1 &&
        closes[i] < closes[i - 1]
      ) {
        markers.push({
          barIndex: i - 1,
          placement: 'aboveBar',
          shape: 'triangleDown',
          color: TWC_COLORS.stBear,
          size: 'tiny',
        });
      }
      if (
        l1 !== null &&
        candles[i - 1].low < l1 &&
        candles[i - 1].close > l1 &&
        closes[i] > closes[i - 1]
      ) {
        markers.push({
          barIndex: i - 1,
          placement: 'belowBar',
          shape: 'triangleUp',
          color: TWC_COLORS.stBull,
          size: 'tiny',
        });
      }
    }
  }

  // ── Line + fill series ──
  const lines: TwcLine[] = [];
  const fills: TwcAreaFill[] = [];
  const splitByDir = (
    values: (number | null)[],
    dirs: (number | null)[],
    wantBull: boolean,
  ): (number | null)[] =>
    values.map((v, i) => {
      const d = dirs[i];
      if (v === null || d === null) return null;
      return wantBull ? (d < 0 ? v : null) : d > 0 ? v : null;
    });

  if (settings.showCTFLine) {
    lines.push({
      id: 'ctfBull',
      values: splitByDir(ctf.value, ctf.direction, true),
      color: TWC_COLORS.stBull,
      lineWidth: 2,
    });
    lines.push({
      id: 'ctfBear',
      values: splitByDir(ctf.value, ctf.direction, false),
      color: TWC_COLORS.stBear,
      lineWidth: 2,
    });
  }
  if (settings.showTransparentHighlight) {
    const opacity = (100 - settings.highlightTransparency) / 100;
    const hl2 = candles.map((c) => (c.high + c.low) / 2);
    fills.push({
      id: 'ctfHighlight',
      top: hl2,
      bottom: ctf.value,
      colors: ctf.direction.map((d) =>
        d === null ? null : withOpacity(d < 0 ? '#00D68F' : '#FF5252', opacity),
      ),
    });
  }
  if (settings.showHTF3) {
    lines.push({
      id: 'htf3Bull',
      values: splitByDir(htf3Value, htf3Dir, true),
      color: TWC_COLORS.stBull,
      lineWidth: 2,
    });
    lines.push({
      id: 'htf3Bear',
      values: splitByDir(htf3Value, htf3Dir, false),
      color: TWC_COLORS.stBear,
      lineWidth: 2,
    });
  }
  if (settings.showHTF4) {
    lines.push({
      id: 'htf4Bull',
      values: splitByDir(htf4Value, htf4Dir, true),
      color: TWC_COLORS.stBull,
      lineWidth: 2,
    });
    lines.push({
      id: 'htf4Bear',
      values: splitByDir(htf4Value, htf4Dir, false),
      color: TWC_COLORS.stBear,
      lineWidth: 2,
    });
  }
  if (settings.showBB2 || settings.showBB3) {
    lines.push({ id: 'bbBasis', values: bb2.middle, color: TWC_COLORS.bbBasis, lineWidth: 1 });
  }
  if (settings.showBB2) {
    lines.push({ id: 'bbUpper2', values: bb2.upper, color: TWC_COLORS.bbSigma2, lineWidth: 1 });
    lines.push({ id: 'bbLower2', values: bb2.lower, color: TWC_COLORS.bbSigma2, lineWidth: 1 });
    fills.push({
      id: 'bb2Fill',
      top: bb2.upper,
      bottom: bb2.lower,
      colors: bb2.upper.map((v) => (v === null ? null : TWC_COLORS.bbSigma2Fill)),
    });
  }
  if (settings.showBB3) {
    lines.push({ id: 'bbUpper3', values: bb3.upper, color: TWC_COLORS.bbSigma3, lineWidth: 1 });
    lines.push({ id: 'bbLower3', values: bb3.lower, color: TWC_COLORS.bbSigma3, lineWidth: 1 });
    fills.push({
      id: 'bb3Fill',
      top: bb3.upper,
      bottom: bb3.lower,
      colors: bb3.upper.map((v) => (v === null ? null : TWC_COLORS.bbSigma3Fill)),
    });
  }

  // ── Bias banner (last bar stack agreement) ──
  const banner: TwcBanner | null = settings.showBiasBanner
    ? {
        text: lastStackBull
          ? settings.biasLongText
          : lastStackBear
            ? settings.biasShortText
            : settings.biasChopText,
        color: lastStackBull
          ? TWC_COLORS.bannerLong
          : lastStackBear
            ? TWC_COLORS.bannerShort
            : TWC_COLORS.bannerChop,
        position: settings.biasBannerPosition,
        size: settings.biasBannerSize,
      }
    : null;

  return {
    candleColors,
    markers,
    lines,
    fills,
    banner,
    atr14,
    msi,
    ctfDir: ctfDirOut,
    stackDir: stackDirOut,
    crossUp: crossUpOut,
    crossDn: crossDnOut,
  };
}
