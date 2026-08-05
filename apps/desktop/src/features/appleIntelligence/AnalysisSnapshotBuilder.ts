// Canonical spec: docs/apple-intelligence/architecture.md
// (AnalysisSnapshotBuilder) and data-contracts.md. Reads existing domain
// state and normalizes it into an immutable AnalysisSnapshot — it does not
// scrape the DOM, generate prompt prose, or invent facts. A pure function of
// its inputs so it is testable without a live ChartStore/TradeStore/
// ChainStore instance.
import { ema, lastValue, rsi, vwap, type CandleInput } from '../chart/indicatorEngine';
import type { ChartCandle, ChartStoreState } from '../chart/ChartStore';
import type { OptionContract, Position } from '@0dtetrader/shared-types';
import type {
  AnalysisSnapshot,
  CandidateLevel,
  Omission,
  TriggerKind,
  TriggerPriority,
} from './types';

let snapshotSequenceCounter = 0;

// Options/chain facts are a declared omission in this phase (see the
// `omissions` push below), not yet read here — Phase 3 scope is the manual
// candle/indicator/position path end to end; chain data is a later slice.
export interface BuildSnapshotInput {
  chart: Pick<ChartStoreState, 'symbol' | 'interval' | 'candles' | 'quote' | 'isStale'>;
  positions: Position[];
  trigger?: { kind: TriggerKind; priority: TriggerPriority; reason: string };
  /** Position lifecycle triggers know exactly which position changed —
   * option positions are keyed by contract symbol and never match the
   * chart's underlying symbol, so the default lookup below can't find
   * them. `null` means "explicitly no position" (a close event). */
  triggeredPosition?: Position | null;
  selectedContract?: OptionContract | null;
  now?: () => Date;
}

/** Builds an immutable analysis snapshot from current domain state. Each
 * call advances the module-level sequence counter — the staleness gate
 * relies on this to detect a newer snapshot superseding an older one. */
export function buildAnalysisSnapshot(input: BuildSnapshotInput): AnalysisSnapshot {
  const now = (input.now ?? (() => new Date()))();
  const capturedAt = now.toISOString();
  snapshotSequenceCounter += 1;

  const candles = input.chart.candles;
  const candleInputs: CandleInput[] = candles.map((c) => ({
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));

  const rsiValue = lastValue(rsi(candleInputs));
  const vwapValue = lastValue(vwap(candleInputs));
  // Short EMA (period 9): the "short EMA reclaim" a reversal setup needs as
  // grounded evidence, not just RSI/VWAP. Reuses the existing ema()
  // implementation (indicatorEngine.ts), previously only consumed
  // internally by macd() — same math, a new caller.
  const ema9Value = lastValue(
    ema(
      candleInputs.map((c) => c.close),
      9,
    ),
  );
  const swing = findRecentSwingPoints(candles);

  const omissions: Omission[] = [
    {
      code: 'options-chain-not-supplied',
      category: 'options',
      reason: 'unsupported',
      material: false,
    },
  ];
  if (input.chart.isStale) {
    omissions.push({
      code: 'quote-stream-stale',
      category: 'market',
      reason: 'stale',
      material: true,
    });
  }

  let position: Position | null;
  if (input.triggeredPosition !== undefined) {
    position = input.triggeredPosition;
  } else if (input.selectedContract) {
    position = input.positions.find((p) => p.symbol === input.selectedContract?.symbol) ?? null;
  } else {
    position = input.positions.find((p) => p.symbol === input.chart.symbol) ?? null;
  }

  const trigger = input.trigger ?? {
    kind: 'manual' as TriggerKind,
    priority: 'manual' as TriggerPriority,
    reason: 'user requested',
  };
  // Management tasks must never silently proceed without position data
  // (context-and-prompt-budgeting.md priority 1): declaring it material
  // lets the Swift budgeter downgrade to observation-only analysis.
  if ((trigger.kind === 'position-change' || trigger.kind === 'material-change') && !position) {
    omissions.push({
      code: 'position-data-missing',
      category: 'position',
      reason: 'unavailable',
      material: true,
    });
  }

  return {
    snapshotSchemaVersion: 1,
    identity: {
      snapshotId: `${input.chart.symbol}-${capturedAt}-${snapshotSequenceCounter}`,
      capturedAt,
      symbol: input.chart.symbol,
      timeframe: input.chart.interval,
      candleCloseTime: lastCandleCloseTime(candles),
      snapshotSequence: snapshotSequenceCounter,
      positionVersion: position ? hashPositionVersion(position) : 0,
      selectedContractSymbol: input.selectedContract?.symbol,
    },
    trigger,
    market: {
      last: input.chart.quote?.last ?? null,
      bid: input.chart.quote?.bid ?? null,
      ask: input.chart.quote?.ask ?? null,
    },
    candles: {
      count: candles.length,
      recent: candles.slice(-50).map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    },
    indicators: {
      rsi: rsiValue,
      vwap: vwapValue,
      ema9: ema9Value,
      swingHigh: swing.high,
      swingLow: swing.low,
    },
    levels: buildCandidateLevels(vwapValue, ema9Value, swing),
    options: input.selectedContract
      ? {
          selectedContract: {
            symbol: input.selectedContract.symbol,
            underlying: input.selectedContract.underlying,
            expiration: input.selectedContract.expiration,
            strike: input.selectedContract.strike,
            optionType: input.selectedContract.optionType,
            bid: input.selectedContract.bid,
            ask: input.selectedContract.ask,
            last: input.selectedContract.last,
          },
        }
      : undefined,
    position: position
      ? {
          quantity: position.quantity,
          avgPrice: position.avgPrice,
          markPrice: position.markPrice,
          unrealizedPnl: position.unrealizedPnl,
        }
      : undefined,
    quality: {
      capturedAt,
      candlesFreshAsOf: capturedAt,
      isChainStale: false,
    },
    omissions,
  };
}

interface SwingPoints {
  high: number | null;
  low: number | null;
}

/** Simplest possible swing-high/low detector over the visible candle
 * window: the highest high and lowest low among the local extrema (a candle
 * whose high/low exceeds both neighbors), falling back to the window's
 * plain max/min when fewer than 3 candles are available for a local-extrema
 * check. Deliberately not a general swing-detection library — this exists
 * only to give the model grounded "higher lows" / range-break evidence
 * without it having to eyeball raw candles for structure. */
function findRecentSwingPoints(candles: ChartCandle[]): SwingPoints {
  if (candles.length === 0) return { high: null, low: null };
  if (candles.length < 3) {
    return {
      high: Math.max(...candles.map((c) => c.high)),
      low: Math.min(...candles.map((c) => c.low)),
    };
  }
  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];
    if (curr.high > prev.high && curr.high > next.high) swingHighs.push(curr.high);
    if (curr.low < prev.low && curr.low < next.low) swingLows.push(curr.low);
  }
  return {
    high: swingHighs.length > 0 ? Math.max(...swingHighs) : Math.max(...candles.map((c) => c.high)),
    low: swingLows.length > 0 ? Math.min(...swingLows) : Math.min(...candles.map((c) => c.low)),
  };
}

/** VWAP, the short EMA, and recent swing high/low are promoted as candidate
 * levels — other level sources (pivots, options walls) remain legitimate
 * omissions until a later phase supplies them, not silently absent. */
function buildCandidateLevels(
  vwapValue: number | null,
  ema9Value: number | null,
  swing: SwingPoints,
): CandidateLevel[] {
  const levels: CandidateLevel[] = [];
  if (vwapValue !== null) {
    levels.push({
      id: 'vwap',
      kind: 'vwap',
      role: 'support',
      price: vwapValue,
      evidence: 'session VWAP',
      testCount: 0,
      recency: 'current',
      strength: 0.5,
      source: 'vwap',
    });
  }
  if (ema9Value !== null) {
    levels.push({
      id: 'ema9',
      kind: 'ema',
      role: 'support',
      price: ema9Value,
      evidence: '9-period EMA',
      testCount: 0,
      recency: 'current',
      strength: 0.5,
      source: 'ema9',
    });
  }
  if (swing.high !== null) {
    levels.push({
      id: 'swing-high',
      kind: 'swing',
      role: 'resistance',
      price: swing.high,
      evidence: 'recent swing high',
      testCount: 0,
      recency: 'current',
      strength: 0.5,
      source: 'swing-detection',
    });
  }
  if (swing.low !== null) {
    levels.push({
      id: 'swing-low',
      kind: 'swing',
      role: 'support',
      price: swing.low,
      evidence: 'recent swing low',
      testCount: 0,
      recency: 'current',
      strength: 0.5,
      source: 'swing-detection',
    });
  }
  return levels;
}

function lastCandleCloseTime(candles: ChartCandle[]): string | undefined {
  const last = candles.at(-1);
  if (!last) return undefined;
  return new Date(last.time * 1000).toISOString();
}

/** Positions have no server-supplied version field; a cheap content hash
 * lets the staleness gate detect a position change between snapshot capture
 * and result delivery without adding a version field to shared-types. */
export function hashPositionVersion(position: Position): number {
  const key = `${position.quantity}:${position.avgPrice}:${position.markPrice}`;
  return stringHash(key);
}

function stringHash(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Deterministic content fingerprint of everything about a snapshot that
 * could materially change model output — explicitly excluding capturedAt/
 * snapshotId/snapshotSequence, which are uniqueness/identity fields, not
 * content. Two snapshots built moments apart from unchanged underlying data
 * (the common closed-market "user pressed Refresh again" case) must produce
 * the same fingerprint so AnalysisStore can recognize the request as
 * redundant and reuse the prior accepted result instead of re-invoking the
 * model. Field order is fixed explicitly (not JSON.stringify on an object)
 * so key ordering can never affect the hash.
 */
export function computeSnapshotFingerprint(snapshot: AnalysisSnapshot): string {
  const market = snapshot.market as { last?: unknown; bid?: unknown; ask?: unknown };
  const candles = snapshot.candles as { recent?: unknown };
  const options = snapshot.options as
    | { selectedContract?: { symbol?: unknown; bid?: unknown; ask?: unknown; last?: unknown } }
    | undefined;

  const parts = [
    snapshot.identity.symbol,
    snapshot.identity.timeframe,
    snapshot.identity.candleCloseTime ?? '',
    String(market.last ?? ''),
    String(market.bid ?? ''),
    String(market.ask ?? ''),
    JSON.stringify(candles.recent ?? []),
    options?.selectedContract?.symbol ?? '',
    String(options?.selectedContract?.bid ?? ''),
    String(options?.selectedContract?.ask ?? ''),
    String(options?.selectedContract?.last ?? ''),
    String(snapshot.identity.selectedContractSymbol ?? ''),
    String(snapshot.identity.positionVersion),
  ];
  return String(stringHash(parts.join('|')));
}
