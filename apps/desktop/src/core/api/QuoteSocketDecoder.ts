import type {
  FreshOrderBookSnapshot,
  IVAlert,
  IVAlertConfiguration,
  IVAlertConfigurationState,
  OrderBookIndicators,
  OrderBookLevel,
  OrderBookStatus,
  StreamServerMessage,
} from '@0dtetrader/shared-types';

export const MAX_QUOTE_SOCKET_MESSAGE_BYTES = 64 * 1024;
const MAX_PROVIDER_FUTURE_SKEW_MS = 1_000;

const IV_ALERT_SYMBOLS = new Set(['SPX', 'NDX', 'RUT']);
const UNAVAILABLE_REASONS = new Set([
  'unsupported_instrument',
  'entitlement_missing',
  'provider_unconfigured',
  'invalid_credentials',
  'provider_error',
  'rate_limiter_unavailable',
  'request_timeout',
  'no_data',
  'market_closed',
  'stale',
  'invalid_book',
  'disconnected',
]);
const STREAM_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,31}$/;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function exactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isoDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_DATE_TIME_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function decodeLevel(value: unknown): OrderBookLevel | null {
  const candidate = object(value);
  if (
    !candidate ||
    !exactKeys(candidate, ['price', 'size']) ||
    !finite(candidate.price) ||
    candidate.price <= 0 ||
    !finite(candidate.size) ||
    candidate.size < 0
  ) {
    return null;
  }
  return { price: candidate.price, size: candidate.size };
}

function decodeLevels(value: unknown, descending: boolean): OrderBookLevel[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) return null;
  const levels: OrderBookLevel[] = [];
  for (const candidate of value) {
    const level = decodeLevel(candidate);
    if (!level) return null;
    const previous = levels.at(-1);
    if (previous && (descending ? level.price >= previous.price : level.price <= previous.price)) {
      return null;
    }
    levels.push(level);
  }
  return levels;
}

function decodeSnapshot(value: unknown): FreshOrderBookSnapshot | null {
  const candidate = object(value);
  if (
    !candidate ||
    !exactKeys(candidate, [
      'symbol',
      'provider',
      'capability',
      'freshness',
      'timestamp',
      'receivedAt',
      'depth',
      'bids',
      'asks',
    ]) ||
    typeof candidate.symbol !== 'string' ||
    !STREAM_SYMBOL_PATTERN.test(candidate.symbol) ||
    candidate.provider !== 'webull' ||
    candidate.capability !== 'nasdaq_totalview_non_display' ||
    candidate.freshness !== 'fresh' ||
    !isoDateTime(candidate.timestamp) ||
    !isoDateTime(candidate.receivedAt) ||
    Date.parse(candidate.timestamp) - Date.parse(candidate.receivedAt) >
      MAX_PROVIDER_FUTURE_SKEW_MS ||
    !boundedInteger(candidate.depth, 1, 50)
  ) {
    return null;
  }
  const bids = decodeLevels(candidate.bids, true);
  const asks = decodeLevels(candidate.asks, false);
  if (
    !bids ||
    !asks ||
    bids.length !== candidate.depth ||
    asks.length !== candidate.depth ||
    bids[0].price > asks[0].price
  ) {
    return null;
  }
  return {
    symbol: candidate.symbol,
    provider: candidate.provider,
    capability: candidate.capability,
    freshness: candidate.freshness,
    timestamp: candidate.timestamp,
    receivedAt: candidate.receivedAt,
    depth: candidate.depth,
    bids,
    asks,
  };
}

function nullableFinite(value: unknown): value is number | null {
  return value === null || finite(value);
}

function decodeIndicators(value: unknown): OrderBookIndicators | null {
  const candidate = object(value);
  const keys = [
    'spreadAbs',
    'spreadBps',
    'spreadPercentile',
    'topBookImbalance',
    'tickPressure',
    'depthImbalance',
    'cumulativePressure',
    'touchDepletion',
  ] as const;
  if (
    !candidate ||
    !exactKeys(candidate, keys) ||
    keys.some((key) => !nullableFinite(candidate[key]))
  ) {
    return null;
  }
  if (
    (candidate.spreadAbs !== null && (candidate.spreadAbs as number) < 0) ||
    (candidate.spreadBps !== null && (candidate.spreadBps as number) < 0) ||
    (candidate.spreadPercentile !== null &&
      ((candidate.spreadPercentile as number) < 0 ||
        (candidate.spreadPercentile as number) > 100)) ||
    [
      'topBookImbalance',
      'tickPressure',
      'depthImbalance',
      'cumulativePressure',
      'touchDepletion',
    ].some(
      (key) =>
        candidate[key] !== null &&
        ((candidate[key] as number) < -1 || (candidate[key] as number) > 1),
    )
  ) {
    return null;
  }
  return candidate as unknown as OrderBookIndicators;
}

function decodeStatus(value: unknown): OrderBookStatus | null {
  const candidate = object(value);
  if (!candidate || typeof candidate.availability !== 'string') return null;
  if (candidate.availability === 'available') {
    if (
      !exactKeys(candidate, ['availability', 'symbol', 'provider', 'capability', 'freshness']) ||
      typeof candidate.symbol !== 'string' ||
      !STREAM_SYMBOL_PATTERN.test(candidate.symbol) ||
      candidate.provider !== 'webull' ||
      candidate.capability !== 'nasdaq_totalview_non_display' ||
      candidate.freshness !== 'fresh'
    ) {
      return null;
    }
    return candidate as unknown as OrderBookStatus;
  }
  if (
    candidate.availability !== 'unavailable' ||
    !exactKeys(candidate, [
      'availability',
      'symbol',
      'provider',
      'capability',
      'freshness',
      'reason',
      'message',
      'retryable',
    ]) ||
    typeof candidate.symbol !== 'string' ||
    !STREAM_SYMBOL_PATTERN.test(candidate.symbol) ||
    (candidate.provider !== null && candidate.provider !== 'webull') ||
    (candidate.capability !== null && candidate.capability !== 'nasdaq_totalview_non_display') ||
    (candidate.freshness !== null && candidate.freshness !== 'stale') ||
    typeof candidate.reason !== 'string' ||
    !UNAVAILABLE_REASONS.has(candidate.reason) ||
    typeof candidate.message !== 'string' ||
    candidate.message.trim() === '' ||
    typeof candidate.retryable !== 'boolean'
  ) {
    return null;
  }
  return candidate as unknown as OrderBookStatus;
}

export function isIVAlertConfiguration(value: unknown): value is IVAlertConfiguration {
  const candidate = object(value);
  if (
    !candidate ||
    !exactKeys(candidate, [
      'enabled',
      'symbols',
      'lookbackMinutes',
      'thresholdK',
      'consecutiveBreaches',
      'warmupMinutes',
      'warmupSamples',
      'cooldownMinutes',
    ]) ||
    typeof candidate.enabled !== 'boolean' ||
    !Array.isArray(candidate.symbols) ||
    candidate.symbols.length < 1 ||
    candidate.symbols.length > 3 ||
    new Set(candidate.symbols).size !== candidate.symbols.length ||
    candidate.symbols.some(
      (symbol) => typeof symbol !== 'string' || !IV_ALERT_SYMBOLS.has(symbol),
    ) ||
    !boundedInteger(candidate.lookbackMinutes, 5, 240) ||
    !finite(candidate.thresholdK) ||
    candidate.thresholdK < 0.1 ||
    candidate.thresholdK > 20 ||
    !boundedInteger(candidate.consecutiveBreaches, 1, 10) ||
    !boundedInteger(candidate.warmupMinutes, 0, 60) ||
    !boundedInteger(candidate.warmupSamples, 1, 240) ||
    !boundedInteger(candidate.cooldownMinutes, 0, 1_440)
  ) {
    return false;
  }
  return true;
}

function decodeConfigurationState(value: unknown): IVAlertConfigurationState | null {
  const candidate = object(value);
  if (
    !candidate ||
    !exactKeys(candidate, [
      'enabled',
      'symbols',
      'lookbackMinutes',
      'thresholdK',
      'consecutiveBreaches',
      'warmupMinutes',
      'warmupSamples',
      'cooldownMinutes',
      'schemaVersion',
      'updatedAt',
    ])
  )
    return null;
  const configuration = {
    enabled: candidate.enabled,
    symbols: candidate.symbols,
    lookbackMinutes: candidate.lookbackMinutes,
    thresholdK: candidate.thresholdK,
    consecutiveBreaches: candidate.consecutiveBreaches,
    warmupMinutes: candidate.warmupMinutes,
    warmupSamples: candidate.warmupSamples,
    cooldownMinutes: candidate.cooldownMinutes,
  };
  if (
    !isIVAlertConfiguration(configuration) ||
    candidate.schemaVersion !== 1 ||
    !isoDateTime(candidate.updatedAt)
  ) {
    return null;
  }
  return candidate as unknown as IVAlertConfigurationState;
}

function decodeAlert(value: unknown): IVAlert | null {
  const candidate = object(value);
  if (
    !candidate ||
    !exactKeys(candidate, [
      'symbol',
      'direction',
      'currentIv',
      'baselineIv',
      'zScore',
      'timestamp',
    ]) ||
    typeof candidate.symbol !== 'string' ||
    !IV_ALERT_SYMBOLS.has(candidate.symbol) ||
    (candidate.direction !== 'expansion' && candidate.direction !== 'crush') ||
    !finite(candidate.currentIv) ||
    candidate.currentIv < 0 ||
    !finite(candidate.baselineIv) ||
    candidate.baselineIv < 0 ||
    !finite(candidate.zScore) ||
    !isoDateTime(candidate.timestamp)
  ) {
    return null;
  }
  return candidate as unknown as IVAlert;
}

/** Strict runtime boundary for the four new shared websocket DTOs. Legacy
 * messages retain their established handling, while unknown message types are dropped. */
export function decodeQuoteSocketMessage(raw: string): StreamServerMessage | null {
  if (new TextEncoder().encode(raw).byteLength > MAX_QUOTE_SOCKET_MESSAGE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const message = object(parsed);
  if (!message || typeof message.type !== 'string') return null;
  switch (message.type) {
    case 'l2Snapshot': {
      if (!exactKeys(message, ['type', 'data'])) return null;
      const data = object(message.data);
      if (!data || !exactKeys(data, ['snapshot', 'indicators'])) return null;
      const snapshot = decodeSnapshot(data.snapshot);
      const indicators = decodeIndicators(data.indicators);
      return snapshot && indicators ? { type: 'l2Snapshot', data: { snapshot, indicators } } : null;
    }
    case 'l2Status': {
      if (!exactKeys(message, ['type', 'data'])) return null;
      const status = decodeStatus(message.data);
      return status ? { type: 'l2Status', data: status } : null;
    }
    case 'ivAlert': {
      if (!exactKeys(message, ['type', 'data'])) return null;
      const alert = decodeAlert(message.data);
      return alert ? { type: 'ivAlert', data: alert } : null;
    }
    case 'ivAlertConfiguration': {
      if (!exactKeys(message, ['type', 'data'])) return null;
      const configuration = decodeConfigurationState(message.data);
      return configuration ? { type: 'ivAlertConfiguration', data: configuration } : null;
    }
    case 'quote':
    case 'orderUpdate':
    case 'chartOrder':
    case 'eventCursor':
    case 'error':
      return message as unknown as StreamServerMessage;
    default:
      return null;
  }
}
