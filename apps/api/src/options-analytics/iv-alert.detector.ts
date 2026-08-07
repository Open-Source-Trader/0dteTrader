import type {
  IVAlert,
  IVAlertConfiguration,
  IVAlertDirection,
  IVAlertSymbol,
} from '@0dtetrader/shared-types';
import { isRegularMarketSessionOpen } from '../broker/expiration-calendar';

const MAX_ABSOLUTE_SCORE = 20;
const GAP_RESET_MS = 2 * 60_000;
const ALERT_SYMBOLS = new Set<IVAlertSymbol>(['SPX', 'NDX', 'RUT']);

export const DEFAULT_IV_ALERT_CONFIGURATION: IVAlertConfiguration = {
  enabled: false,
  symbols: ['SPX', 'NDX', 'RUT'],
  lookbackMinutes: 30,
  thresholdK: 3,
  consecutiveBreaches: 2,
  warmupMinutes: 10,
  warmupSamples: 10,
  cooldownMinutes: 5,
};

export interface IvDetectorSample {
  timestamp: string;
  atmIv: number;
}

export interface IvDetectorState {
  samples: IvDetectorSample[];
  firstPostResetAt: string | null;
  lastProcessedAt: string | null;
  streakDirection: IVAlertDirection | null;
  streakCount: number;
  cooldownUntil: string | null;
}

export interface IvDetectorCapture {
  symbol: IVAlertSymbol;
  timestamp: Date;
  atmIv: number | null;
}

export interface IvDetectorResult {
  kind: 'ignored' | 'suppressed' | 'tracking' | 'alert';
  reason?:
    | 'disabled'
    | 'unsupported'
    | 'closed_session'
    | 'invalid_iv'
    | 'old_capture'
    | 'gap_reset'
    | 'warmup'
    | 'cooldown'
    | 'no_breach';
  state: IvDetectorState;
  baselineIv?: number;
  zScore?: number;
  direction?: IVAlertDirection;
  alert?: IVAlert;
}

export function emptyIvDetectorState(): IvDetectorState {
  return {
    samples: [],
    firstPostResetAt: null,
    lastProcessedAt: null,
    streakDirection: null,
    streakCount: 0,
    cooldownUntil: null,
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('Median requires at least one finite value.');
  }
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function advanceIvDetector(
  state: IvDetectorState,
  capture: IvDetectorCapture,
  configuration: IVAlertConfiguration,
): IvDetectorResult {
  const captureMs = capture.timestamp.getTime();
  if (!configuration.enabled) return ignored(state, 'disabled');
  if (!ALERT_SYMBOLS.has(capture.symbol) || !configuration.symbols.includes(capture.symbol)) {
    return ignored(state, 'unsupported');
  }
  if (!Number.isFinite(captureMs) || !isRegularMarketSessionOpen(capture.timestamp)) {
    return ignored(state, 'closed_session');
  }
  if (capture.atmIv === null || !Number.isFinite(capture.atmIv) || capture.atmIv <= 0) {
    return ignored(state, 'invalid_iv');
  }
  const lastProcessedMs = state.lastProcessedAt === null ? null : Date.parse(state.lastProcessedAt);
  if (lastProcessedMs !== null && captureMs <= lastProcessedMs) {
    return ignored(state, 'old_capture');
  }

  const timestamp = capture.timestamp.toISOString();
  const currentSample = { timestamp, atmIv: capture.atmIv };
  if (lastProcessedMs !== null && captureMs - lastProcessedMs > GAP_RESET_MS) {
    return {
      kind: 'suppressed',
      reason: 'gap_reset',
      state: {
        samples: [currentSample],
        firstPostResetAt: timestamp,
        lastProcessedAt: timestamp,
        streakDirection: null,
        streakCount: 0,
        cooldownUntil: state.cooldownUntil,
      },
    };
  }

  const lookbackStart = captureMs - configuration.lookbackMinutes * 60_000;
  const prior = state.samples.filter((sample) => {
    const sampleMs = Date.parse(sample.timestamp);
    return sampleMs >= lookbackStart && sampleMs < captureMs;
  });
  const firstPostResetAt = state.firstPostResetAt ?? timestamp;
  const nextSamples = [...prior, currentSample];
  const baseState: IvDetectorState = {
    ...state,
    samples: nextSamples,
    firstPostResetAt,
    lastProcessedAt: timestamp,
  };
  const warmupElapsed = captureMs - Date.parse(firstPostResetAt);
  if (
    prior.length < configuration.warmupSamples ||
    warmupElapsed < configuration.warmupMinutes * 60_000
  ) {
    return {
      kind: 'suppressed',
      reason: 'warmup',
      state: { ...baseState, streakDirection: null, streakCount: 0 },
    };
  }

  const baselineIv = median(prior.map((sample) => sample.atmIv));
  const mad = median(prior.map((sample) => Math.abs(sample.atmIv - baselineIv)));
  let rawScore = 0;
  if (mad > 0) rawScore = (capture.atmIv - baselineIv) / mad;
  else if (capture.atmIv > baselineIv) rawScore = MAX_ABSOLUTE_SCORE;
  else if (capture.atmIv < baselineIv) rawScore = -MAX_ABSOLUTE_SCORE;
  const zScore = Math.max(-MAX_ABSOLUTE_SCORE, Math.min(MAX_ABSOLUTE_SCORE, rawScore));

  const cooldownUntilMs = state.cooldownUntil === null ? null : Date.parse(state.cooldownUntil);
  if (cooldownUntilMs !== null && captureMs < cooldownUntilMs) {
    return {
      kind: 'suppressed',
      reason: 'cooldown',
      baselineIv,
      zScore,
      state: { ...baseState, streakDirection: null, streakCount: 0 },
    };
  }

  let direction: IVAlertDirection | null = null;
  if (zScore >= configuration.thresholdK) direction = 'expansion';
  else if (zScore <= -configuration.thresholdK) direction = 'crush';
  if (direction === null) {
    return {
      kind: 'tracking',
      reason: 'no_breach',
      baselineIv,
      zScore,
      state: { ...baseState, streakDirection: null, streakCount: 0 },
    };
  }
  const streakCount = state.streakDirection === direction ? state.streakCount + 1 : 1;
  if (streakCount < configuration.consecutiveBreaches) {
    return {
      kind: 'tracking',
      baselineIv,
      zScore,
      direction,
      state: { ...baseState, streakDirection: direction, streakCount },
    };
  }

  const cooldownUntil = new Date(captureMs + configuration.cooldownMinutes * 60_000).toISOString();
  const alert: IVAlert = {
    symbol: capture.symbol,
    direction,
    currentIv: capture.atmIv,
    baselineIv,
    zScore,
    timestamp,
  };
  return {
    kind: 'alert',
    baselineIv,
    zScore,
    direction,
    alert,
    state: {
      ...baseState,
      streakDirection: null,
      streakCount: 0,
      cooldownUntil,
    },
  };
}

function ignored(
  state: IvDetectorState,
  reason: NonNullable<IvDetectorResult['reason']>,
): IvDetectorResult {
  return { kind: 'ignored', reason, state };
}
