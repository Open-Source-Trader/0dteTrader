import { OrderBookIndicators, OrderBookSnapshot } from '@0dtetrader/shared-types';
import { isRegularMarketSessionOpen } from '../broker/expiration-calendar';

const WINDOW_MS = 60_000;
const MAX_SESSION_SAMPLES = 23_400;

const UNAVAILABLE: OrderBookIndicators = {
  spreadAbs: null,
  spreadBps: null,
  spreadPercentile: null,
  topBookImbalance: null,
  tickPressure: null,
  depthImbalance: null,
  cumulativePressure: null,
  touchDepletion: null,
};

const sessionFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function validateOrderBook(snapshot: OrderBookSnapshot): boolean {
  if (
    !snapshot ||
    typeof snapshot.symbol !== 'string' ||
    snapshot.symbol.length === 0 ||
    snapshot.freshness !== 'fresh' ||
    !Number.isFinite(Date.parse(snapshot.timestamp)) ||
    !Number.isFinite(Date.parse(snapshot.receivedAt)) ||
    !Number.isInteger(snapshot.depth) ||
    snapshot.depth < 1 ||
    !Array.isArray(snapshot.bids) ||
    !Array.isArray(snapshot.asks) ||
    snapshot.bids.length < snapshot.depth ||
    snapshot.asks.length < snapshot.depth
  ) {
    return false;
  }
  const validSide = (levels: OrderBookSnapshot['bids']): boolean =>
    levels.every(
      ({ price, size }) =>
        Number.isFinite(price) && price > 0 && Number.isFinite(size) && size >= 0,
    );
  if (!validSide(snapshot.bids) || !validSide(snapshot.asks)) return false;
  for (let index = 1; index < snapshot.bids.length; index += 1) {
    if (snapshot.bids[index].price > snapshot.bids[index - 1].price) return false;
  }
  for (let index = 1; index < snapshot.asks.length; index += 1) {
    if (snapshot.asks[index].price < snapshot.asks[index - 1].price) return false;
  }
  return snapshot.asks[0].price >= snapshot.bids[0].price;
}

export function deriveOrderBookIndicators(
  current: OrderBookSnapshot,
  history: readonly OrderBookSnapshot[],
  requestedLevels: number,
): OrderBookIndicators {
  if (!validateOrderBook(current)) return { ...UNAVAILABLE };

  const currentTime = Date.parse(current.timestamp);
  const session = sessionFormatter.format(currentTime);
  const prior = history
    .filter(
      (snapshot) =>
        validateOrderBook(snapshot) &&
        snapshot.symbol === current.symbol &&
        isRegularMarketSessionOpen(new Date(snapshot.timestamp)) &&
        Date.parse(snapshot.timestamp) < currentTime &&
        sessionFormatter.format(Date.parse(snapshot.timestamp)) === session,
    )
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  const sessionPrior = prior.slice(-MAX_SESSION_SAMPLES);
  const recent = sessionPrior.filter(
    (snapshot) => Date.parse(snapshot.timestamp) >= currentTime - WINDOW_MS,
  );

  const bestBid = current.bids[0];
  const bestAsk = current.asks[0];
  const spreadAbs = bestAsk.price - bestBid.price;
  const mid = (bestAsk.price + bestBid.price) / 2;
  const spreadBps = mid > 0 ? (spreadAbs / mid) * 10_000 : null;
  const spreadPercentile = percentile(spreadAbs, sessionPrior.map(spread));
  const topDenominator = bestBid.size + bestAsk.size;
  const topBookImbalance =
    topDenominator > 0 ? (bestBid.size - bestAsk.size) / topDenominator : null;

  const levels = clampLevels(requestedLevels, current.depth);
  const currentTotals = depthTotals(current, levels);
  const depthDenominator = currentTotals.bid + currentTotals.ask;
  const depthImbalance =
    depthDenominator > 0 ? (currentTotals.bid - currentTotals.ask) / depthDenominator : null;

  const sequence = [...recent, current];
  const tickPressure = meanMidpointSign(sequence);
  const cumulativePressure = pressure(sequence, levels);
  const touchDepletion = depletion(sequence);

  return {
    spreadAbs,
    spreadBps,
    spreadPercentile,
    topBookImbalance,
    tickPressure,
    depthImbalance,
    cumulativePressure,
    touchDepletion,
  };
}

function spread(snapshot: OrderBookSnapshot): number {
  return snapshot.asks[0].price - snapshot.bids[0].price;
}

function midpoint(snapshot: OrderBookSnapshot): number {
  return (snapshot.asks[0].price + snapshot.bids[0].price) / 2;
}

function percentile(current: number, prior: readonly number[]): number | null {
  if (prior.length === 0) return null;
  let less = 0;
  let equal = 0;
  for (const value of prior) {
    if (value < current) less += 1;
    else if (value === current) equal += 1;
  }
  return (100 * (less + 0.5 * equal)) / prior.length;
}

function clampLevels(requested: number, depth: number): number {
  const integer = Number.isFinite(requested) ? Math.trunc(requested) : 1;
  return Math.min(depth, Math.max(1, integer));
}

function depthTotals(snapshot: OrderBookSnapshot, levels: number): { bid: number; ask: number } {
  const count = Math.min(levels, snapshot.depth, snapshot.bids.length, snapshot.asks.length);
  let bid = 0;
  let ask = 0;
  for (let index = 0; index < count; index += 1) {
    bid += snapshot.bids[index].size;
    ask += snapshot.asks[index].size;
  }
  return { bid, ask };
}

function meanMidpointSign(sequence: readonly OrderBookSnapshot[]): number | null {
  if (sequence.length < 2) return null;
  let sum = 0;
  for (let index = 1; index < sequence.length; index += 1) {
    sum += Math.sign(midpoint(sequence[index]) - midpoint(sequence[index - 1]));
  }
  return sum / (sequence.length - 1);
}

function pressure(sequence: readonly OrderBookSnapshot[], levels: number): number | null {
  if (sequence.length < 2) return null;
  let numerator = 0;
  let denominator = 0;
  let previous = depthTotals(sequence[0], levels);
  for (let index = 1; index < sequence.length; index += 1) {
    const current = depthTotals(sequence[index], levels);
    const bidDelta = current.bid - previous.bid;
    const askDelta = current.ask - previous.ask;
    numerator += bidDelta - askDelta;
    denominator += Math.abs(bidDelta) + Math.abs(askDelta);
    previous = current;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function depletion(sequence: readonly OrderBookSnapshot[]): number | null {
  if (sequence.length < 2) return null;
  const previous = sequence[sequence.length - 2];
  const current = sequence[sequence.length - 1];
  const bid =
    previous.bids[0].price === current.bids[0].price
      ? Math.max(previous.bids[0].size - current.bids[0].size, 0)
      : 0;
  const ask =
    previous.asks[0].price === current.asks[0].price
      ? Math.max(previous.asks[0].size - current.asks[0].size, 0)
      : 0;
  const denominator = bid + ask;
  return denominator === 0 ? 0 : (ask - bid) / denominator;
}
