// Deterministic pre-model eligibility gate. Canonical spec: this session's
// data-validity remediation — see docs/plans (AI Trade Desk correctness
// pass). Runs over an already-built AnalysisSnapshot, before it may be sent
// to the model. Rejects rather than repairs: a bad bid/ask pair or a
// malformed candle is evidence the input isn't trustworthy, not something to
// silently zero out and analyze anyway.
//
// AnalysisSnapshot's market/candles/options/position fields are typed
// Record<string, unknown> (the Swift-shim wire contract deliberately keeps
// this boundary opaque) even though AnalysisSnapshotBuilder always populates
// them with a concrete shape — so every read here goes through a runtime
// type guard rather than trusting the field's static type.
import { deriveMarketSessionState } from './marketSessionState';
import type { AnalysisEligibility, AnalysisIneligibilityReason, AnalysisSnapshot } from './types';

/** Widest plausible bid-ask spread as a fraction of last price. A spread far
 * beyond this on a liquid underlying/contract indicates a corrupt or
 * mismatched quote tick, not real market conditions — reject rather than
 * feed it to the model. Deliberately not per-instrument: this is a coarse
 * plausibility check, not a market-making spread policy. 5% comfortably
 * covers real (if wide) quotes on liquid 0DTE underlyings/contracts while
 * still catching a corrupt tick like Bid 722.25/Ask 766.98 against a Last
 * of 746.79 (~6% spread) — the exact case that motivated this gate. */
const MAX_SPREAD_RATIO = 0.05;

function ineligible(
  reason: AnalysisIneligibilityReason,
  userMessage: string,
  diagnostics?: Record<string, unknown>,
): AnalysisEligibility {
  return { eligible: false, reason, userMessage, diagnostics };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFinitePositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

interface RawQuote {
  last: unknown;
  bid: unknown;
  ask: unknown;
}

function validateUnderlyingQuote(market: Record<string, unknown>): AnalysisEligibility | null {
  const quote = market as unknown as RawQuote;
  if (quote.last === null || quote.last === undefined) {
    return ineligible('missing-underlying-quote', 'No underlying quote available.');
  }
  if (!isFinitePositive(quote.last)) {
    return ineligible('invalid-underlying-quote', 'Underlying last price is invalid.', {
      last: quote.last,
    });
  }
  const last = quote.last;
  const bidPresent = isFiniteNumber(quote.bid) && quote.bid > 0;
  const askPresent = isFiniteNumber(quote.ask) && quote.ask > 0;
  if (quote.bid !== null && quote.bid !== undefined && !bidPresent && quote.bid !== 0) {
    return ineligible('invalid-underlying-quote', 'Underlying bid is invalid.', { bid: quote.bid });
  }
  if (quote.ask !== null && quote.ask !== undefined && !askPresent && quote.ask !== 0) {
    return ineligible('invalid-underlying-quote', 'Underlying ask is invalid.', { ask: quote.ask });
  }
  if (bidPresent && askPresent) {
    const bid = quote.bid as number;
    const ask = quote.ask as number;
    if (bid > ask) {
      return ineligible('invalid-underlying-quote', 'Underlying bid exceeds ask.', { bid, ask });
    }
    const spread = ask - bid;
    if (spread > last * MAX_SPREAD_RATIO) {
      return ineligible('invalid-underlying-quote', 'Underlying bid/ask spread is implausible.', {
        bid,
        ask,
        last,
      });
    }
  }
  return null;
}

interface RawCandle {
  time: unknown;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  volume: unknown;
}

function validateCandles(candles: Record<string, unknown>): AnalysisEligibility | null {
  const recent = candles.recent;
  if (!Array.isArray(recent) || recent.length === 0) {
    return ineligible('missing-candles', 'No candle data available.');
  }

  let previousTime = -Infinity;
  for (const raw of recent as RawCandle[]) {
    if (!isFiniteNumber(raw.time) || raw.time <= previousTime) {
      return ineligible('invalid-candle-data', 'Candle timestamps are not strictly increasing.', {
        time: raw.time,
      });
    }
    previousTime = raw.time;
    const values = [raw.open, raw.high, raw.low, raw.close, raw.volume];
    if (!values.every(isFiniteNumber)) {
      return ineligible('invalid-candle-data', 'Candle contains a non-finite value.', {
        time: raw.time,
      });
    }
    const [open, high, low, close, volume] = values as number[];
    if (volume < 0) {
      return ineligible('invalid-candle-data', 'Candle volume is negative.', { time: raw.time });
    }
    if (low > open || low > close || low > high || high < open || high < close) {
      return ineligible('invalid-candle-data', 'Candle OHLC values are inconsistent.', {
        time: raw.time,
        open,
        high,
        low,
        close,
      });
    }
  }
  return null;
}

interface RawSelectedContract {
  symbol: unknown;
  bid: unknown;
  ask: unknown;
}

function validateSelectedContractQuote(
  options: Record<string, unknown>,
): AnalysisEligibility | null {
  const selected = options.selectedContract as RawSelectedContract | undefined;
  if (!selected) return null;
  const bidPresent = isFiniteNumber(selected.bid) && selected.bid > 0;
  const askPresent = isFiniteNumber(selected.ask) && selected.ask > 0;
  if (selected.bid !== 0 && selected.bid !== null && selected.bid !== undefined && !bidPresent) {
    return ineligible('invalid-selected-contract-quote', 'Selected contract bid is invalid.', {
      bid: selected.bid,
    });
  }
  if (selected.ask !== 0 && selected.ask !== null && selected.ask !== undefined && !askPresent) {
    return ineligible('invalid-selected-contract-quote', 'Selected contract ask is invalid.', {
      ask: selected.ask,
    });
  }
  if (bidPresent && askPresent && (selected.bid as number) > (selected.ask as number)) {
    return ineligible('invalid-selected-contract-quote', 'Selected contract bid exceeds ask.', {
      bid: selected.bid,
      ask: selected.ask,
    });
  }
  return null;
}

interface RawPosition {
  quantity: unknown;
  avgPrice: unknown;
}

// AnalysisSnapshotBuilder's `position` field carries quantity/avgPrice/
// markPrice/unrealizedPnl only — no owning symbol — so a position/selected-
// contract symbol cross-check isn't possible from the snapshot alone. That
// identity match already happened upstream, when buildAnalysisSnapshot chose
// which Position to include by matching selectedContract.symbol (or the
// chart symbol) before this snapshot was ever built. This validator is
// limited to what the snapshot can actually attest to: numeric sanity.
function validatePosition(
  position: Record<string, unknown> | undefined,
): AnalysisEligibility | null {
  if (!position) return null;
  const raw = position as unknown as RawPosition;
  if (!isFiniteNumber(raw.quantity) || !isFiniteNumber(raw.avgPrice)) {
    return ineligible('snapshot-mismatch', 'Position quantity or average price is invalid.', {
      quantity: raw.quantity,
      avgPrice: raw.avgPrice,
    });
  }
  return null;
}

/**
 * Deterministic eligibility gate: validates an already-built AnalysisSnapshot
 * in the order underlying → candles → options → position, returning the
 * first failure found or `{eligible:true, mode, snapshot}` when every check
 * passes. Must run before the snapshot is sent to the model — see
 * AnalysisStore.analyze()/submitCandleClose().
 */
export function evaluateAnalysisEligibility(snapshot: AnalysisSnapshot): AnalysisEligibility {
  const underlyingFailure = validateUnderlyingQuote(snapshot.market);
  if (underlyingFailure) return underlyingFailure;

  const candleFailure = validateCandles(snapshot.candles);
  if (candleFailure) return candleFailure;

  if (snapshot.options) {
    const contractFailure = validateSelectedContractQuote(snapshot.options);
    if (contractFailure) return contractFailure;
  }

  const positionFailure = validatePosition(snapshot.position);
  if (positionFailure) return positionFailure;

  const mode = deriveMarketSessionState({
    isQuoteStreamStale: false,
    isChainStale: snapshot.quality.isChainStale,
  });
  return { eligible: true, mode, snapshot };
}
