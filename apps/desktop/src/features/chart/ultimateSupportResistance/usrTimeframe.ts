import type { UsrSettings } from './usrSettings';
import type { UsrAnalysisCandle, UsrCandle, UsrComputeContext } from './usrTypes';
import { applyLaggedVolumeBaselines, atrSeries, isFiniteCandle, isRegularSession } from './usrMath';

const MONDAY_EPOCH_OFFSET = 345_600;
const DAY = 86_400;
const WEEK = 604_800;

export interface UsrPreparedHistory {
  /** Canonical chart input, including the newest open candle for rendering. */
  presentationCandles: UsrCandle[];
  /** Fully closed chart candles used by every analytical state transition. */
  chartCandles: UsrCandle[];
  analysisCandles: UsrAnalysisCandle[];
  analysisSeconds: number | null;
  timeframeTag: string;
  usedChartTimeframe: boolean;
  warnings: string[];
}

interface TimeframeValue {
  seconds: number | null;
  months: number | null;
  ticks: number | null;
  tag: string;
}

function fixedSeconds(seconds: number): TimeframeValue {
  return { seconds, months: null, ticks: null, tag: String(seconds) };
}

function fixedMonths(months: number): TimeframeValue {
  return { seconds: null, months, ticks: null, tag: `${months}M` };
}

function fixedTicks(ticks: number): TimeframeValue {
  return { seconds: null, months: null, ticks, tag: `${ticks}T` };
}

function autoTimeframe(chartSeconds: number): TimeframeValue {
  if (chartSeconds <= 5) return { ...fixedSeconds(15), tag: '15S' };
  if (chartSeconds <= 15) return { ...fixedSeconds(60), tag: '1' };
  if (chartSeconds <= 30) return { ...fixedSeconds(120), tag: '2' };
  if (chartSeconds <= 60) return { ...fixedSeconds(300), tag: '5' };
  if (chartSeconds <= 180) return { ...fixedSeconds(900), tag: '15' };
  if (chartSeconds <= 300) return { ...fixedSeconds(1_800), tag: '30' };
  if (chartSeconds <= 900) return { ...fixedSeconds(3_600), tag: '60' };
  if (chartSeconds <= 1_800) return { ...fixedSeconds(7_200), tag: '120' };
  if (chartSeconds <= 3_600) return { ...fixedSeconds(14_400), tag: '240' };
  if (chartSeconds <= 7_200) return { ...fixedSeconds(28_800), tag: '480' };
  if (chartSeconds <= 14_400) return { ...fixedSeconds(DAY), tag: '1D' };
  if (chartSeconds <= 43_200) return { ...fixedSeconds(2 * DAY), tag: '2D' };
  if (chartSeconds <= DAY) return { ...fixedSeconds(WEEK), tag: '1W' };
  if (chartSeconds <= 3 * DAY) return { ...fixedSeconds(2 * WEEK), tag: '2W' };
  if (chartSeconds <= WEEK) return fixedMonths(1);
  if (chartSeconds <= 2 * WEEK) return fixedMonths(2);
  if (chartSeconds <= 31 * DAY) return fixedMonths(3);
  return fixedMonths(12);
}

export function parseUsrTimeframeValue(value: string): TimeframeValue | null {
  const match = /^([1-9]\d*)?(T|S|D|W|M)?$/.exec(value.trim().toUpperCase());
  if (!match) return null;
  const unit = match[2] ?? '';
  if (!match[1] && unit.length === 0) return null;
  const amount = Number(match[1] ?? 1);
  if (!Number.isSafeInteger(amount)) return null;
  switch (unit) {
    case 'T':
      return [1, 10, 100, 1_000].includes(amount) ? fixedTicks(amount) : null;
    case 'S':
      return [1, 5, 10, 15, 30, 45].includes(amount)
        ? { ...fixedSeconds(amount), tag: `${amount}S` }
        : null;
    case 'D':
      return amount <= 365 ? { ...fixedSeconds(amount * DAY), tag: `${amount}D` } : null;
    case 'W':
      return amount <= 52 ? { ...fixedSeconds(amount * WEEK), tag: `${amount}W` } : null;
    case 'M':
      return amount <= 12 ? fixedMonths(amount) : null;
    default:
      if (!match[1]) return null;
      return amount <= 1_440 ? { ...fixedSeconds(amount * 60), tag: String(amount) } : null;
  }
}

function selectedTimeframe(
  settings: UsrSettings,
  chartSeconds: number | null,
): TimeframeValue | null {
  switch (settings.analysisTimeframe) {
    case 'chart':
      return chartSeconds === null
        ? null
        : {
            ...fixedSeconds(chartSeconds),
            tag: chartTimeframeTag(chartSeconds) ?? String(chartSeconds),
          };
    case 'auto':
      return chartSeconds === null ? null : autoTimeframe(chartSeconds);
    case '4h':
      return { ...fixedSeconds(14_400), tag: '240' };
    case '1d':
      return { ...fixedSeconds(DAY), tag: '1D' };
    case '3d':
      return { ...fixedSeconds(3 * DAY), tag: '3D' };
    case '1w':
      return { ...fixedSeconds(WEEK), tag: '1W' };
    case '2w':
      return { ...fixedSeconds(2 * WEEK), tag: '2W' };
    case '1m':
      return fixedMonths(1);
    case 'custom':
      return parseUsrTimeframeValue(settings.customTimeframe);
  }
}

function monthIndex(epochSeconds: number): number {
  const date = new Date(epochSeconds * 1_000);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

function chartTimeframeTag(seconds: number | null): string | null {
  switch (seconds) {
    case 60:
      return '1';
    case 300:
      return '5';
    case 900:
      return '15';
    case 1_800:
      return '30';
    case 3_600:
      return '60';
    case 14_400:
      return '240';
    case DAY:
      return '1D';
    case WEEK:
      return '1W';
    default:
      return seconds === null ? null : String(seconds);
  }
}

function bucketKey(
  epochSeconds: number,
  seconds: number | null,
  months: number | null,
  weekly: boolean,
): string {
  if (months !== null) return String(Math.floor(monthIndex(epochSeconds) / months));
  if (seconds === null) return String(epochSeconds);
  if (weekly) {
    return String(Math.floor((epochSeconds - MONDAY_EPOCH_OFFSET) / seconds));
  }
  return String(Math.floor(epochSeconds / seconds));
}

function aggregate(
  candles: readonly UsrCandle[],
  seconds: number | null,
  months: number | null,
  weekly: boolean,
  chartSeconds: number | null,
  useChartClock: boolean,
  continuousSession: boolean,
): UsrAnalysisCandle[] {
  const groups: Array<{ key: string; start: number; end: number; candle: UsrCandle }> = [];
  candles.forEach((candle, chartIndex) => {
    const key = bucketKey(candle.time, seconds, months, weekly);
    const last = groups[groups.length - 1];
    if (!last || last.key !== key) {
      groups.push({ key, start: chartIndex, end: chartIndex, candle: { ...candle } });
      return;
    }
    last.end = chartIndex;
    last.candle.high = Math.max(last.candle.high, candle.high);
    last.candle.low = Math.min(last.candle.low, candle.low);
    last.candle.close = candle.close;
    last.candle.volume += candle.volume;
  });

  const chartContext = useChartClock;
  const usable = chartContext ? groups : groups.slice(0, -1);
  const analysis = usable.map((group, index): UsrAnalysisCandle => {
    const next = groups[index + 1];
    const eventChartIndex = chartContext ? group.end : (next?.start ?? group.end);
    return {
      ...group.candle,
      chartStartIndex: group.start,
      chartEndIndex: group.end,
      eventChartIndex,
      eventTime: candles[eventChartIndex].time + (chartSeconds ?? 0),
      closeTime: candles[group.end].time + (chartSeconds ?? 0),
      regularSession: continuousSession || isRegularSession(group.candle.time),
      atr: null,
      volumeMean: null,
      volumeStd: null,
    };
  });
  const atr = atrSeries(analysis);
  analysis.forEach((candle, index) => {
    candle.atr = atr[index];
  });
  return analysis;
}

export function prepareUsrHistory(
  input: readonly UsrCandle[],
  settings: UsrSettings,
  context: UsrComputeContext,
): UsrPreparedHistory {
  const warnings: string[] = [];
  const candlesByTime = new Map<number, UsrCandle>();
  for (const candle of input) {
    if (isFiniteCandle(candle)) candlesByTime.set(candle.time, { ...candle });
  }
  // A later record at the same timestamp is the provider/live-stream
  // correction. Keeping the first record would silently analyze stale OHLCV.
  const sorted = [...candlesByTime.values()].sort((a, b) => a.time - b.time);
  if (sorted.length !== input.length) {
    warnings.push('Invalid or duplicate candles were excluded before analysis.');
  }

  let confirmedCount = sorted.length;
  const last = sorted.at(-1);
  const lastCandleIsOpen =
    context.lastCandleIsOpen ??
    (last !== undefined &&
      (context.chartIntervalSeconds === null ||
        last.time + context.chartIntervalSeconds > context.now));
  if (last && lastCandleIsOpen) {
    confirmedCount -= 1;
  }
  const chartCandles = sorted.slice(0, Math.max(0, confirmedCount));
  const requested = selectedTimeframe(settings, context.chartIntervalSeconds);
  let analysisSeconds = requested?.seconds ?? null;
  let analysisMonths = requested?.months ?? null;
  let usedChartTimeframe = settings.analysisTimeframe === 'chart';
  const requestedComparableSeconds =
    requested?.seconds ?? (requested?.months ? requested.months * (365.25 / 12) * DAY : null);
  const requestedIsChartClock =
    settings.analysisTimeframe === 'chart' ||
    (requested !== null && requested.tag === chartTimeframeTag(context.chartIntervalSeconds));
  const requestedIsLower =
    context.chartIntervalSeconds !== null &&
    requestedComparableSeconds !== null &&
    requestedComparableSeconds < context.chartIntervalSeconds;
  if (
    context.chartIntervalSeconds === null ||
    requested === null ||
    requestedComparableSeconds === null ||
    requestedIsLower ||
    (requestedComparableSeconds === context.chartIntervalSeconds && requestedIsChartClock)
  ) {
    if (requestedIsLower) {
      warnings.push(
        'The selected analysis timeframe is not above the chart timeframe; chart bars are used.',
      );
    }
    analysisSeconds = context.chartIntervalSeconds;
    analysisMonths = null;
    usedChartTimeframe = true;
  }
  const timeframeTag = usedChartTimeframe
    ? 'chart'
    : (requested?.tag ?? analysisSeconds?.toString() ?? 'chart');
  const analysisCandles = aggregate(
    chartCandles,
    analysisSeconds,
    analysisMonths,
    !usedChartTimeframe && timeframeTag.endsWith('W'),
    context.chartIntervalSeconds,
    usedChartTimeframe,
    context.continuousSession === true,
  );
  applyLaggedVolumeBaselines(
    analysisCandles,
    settings.volumeLookback,
    settings.sessionAwareVolume,
    analysisSeconds !== null && analysisSeconds < DAY,
  );
  return {
    presentationCandles: sorted,
    chartCandles,
    analysisCandles,
    analysisSeconds,
    timeframeTag,
    usedChartTimeframe,
    warnings,
  };
}
