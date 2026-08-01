// Canonical spec: docs/apple-intelligence/architecture.md
// (AnalysisSnapshotBuilder) and data-contracts.md. Reads existing domain
// state and normalizes it into an immutable AnalysisSnapshot — it does not
// scrape the DOM, generate prompt prose, or invent facts. A pure function of
// its inputs so it is testable without a live ChartStore/TradeStore/
// ChainStore instance.
import { lastValue, rsi, vwap, type CandleInput } from '../chart/indicatorEngine';
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
    },
    levels: buildCandidateLevels(vwapValue),
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
      candlesFreshAsOf: candles.length > 0 ? capturedAt : capturedAt,
      isChainStale: false,
    },
    omissions,
  };
}

/** Only VWAP is currently promoted to a candidate level — other level
 * sources (pivots, options walls) are legitimate omissions until a later
 * phase supplies them, not silently absent. */
function buildCandidateLevels(vwapValue: number | null): CandidateLevel[] {
  if (vwapValue === null) return [];
  return [
    {
      id: 'vwap',
      kind: 'vwap',
      role: 'support',
      price: vwapValue,
      evidence: 'session VWAP',
      testCount: 0,
      recency: 'current',
      strength: 0.5,
      source: 'vwap',
    },
  ];
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
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return hash;
}
