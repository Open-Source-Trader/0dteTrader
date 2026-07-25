import {
  Candle,
  OptionContract,
  OptionType,
  OrderResult,
  OrderSide,
  OrderStatus,
  OrderType,
  Position,
  Quote,
} from '@0dtetrader/shared-types';
import { OPTION_MULTIPLIER, parseOccSymbol } from '../contract-resolution';
import {
  SdkBar,
  SdkOptionSnapshot,
  SdkOrder,
  SdkPosition,
  SdkStockSnapshot,
} from './alpaca-sdk.types';

export function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : fallback;
}

function isoFrom(value: unknown): string {
  if (value === undefined || value === null) return new Date(0).toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') {
    // Seconds vs milliseconds: Alpaca timestamps are always whole-second epochs.
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  return String(value);
}

/**
 * Build a Quote from an option or stock snapshot. Both snapshot shapes expose
 * `latestQuote` (bp/ap/bps/aps) and `latestTrade` (p/s), so a single mapper
 * covers equities and options.
 */
export function toQuote(symbol: string, snap: SdkOptionSnapshot | SdkStockSnapshot): Quote {
  const q = snap.latestQuote ?? {};
  const t = snap.latestTrade ?? {};
  const stock = snap as SdkStockSnapshot;
  return {
    symbol,
    bid: num(q.bp),
    ask: num(q.ap),
    last: num(t.p ?? q.bp),
    bidSize: num(q.bps),
    askSize: num(q.aps),
    volume: num(t.s ?? stock.dailyBar?.v),
    timestamp: isoFrom(q.t ?? t.t),
  };
}

export function toCandle(bar: SdkBar): Candle {
  return {
    time: isoFrom(bar.timestamp),
    open: num(bar.open),
    high: num(bar.high),
    low: num(bar.low),
    close: num(bar.close),
    volume: num(bar.volume),
  };
}

export function toOptionContract(symbol: string, snap: SdkOptionSnapshot): OptionContract {
  const terms = parseOccSymbol(symbol);
  const optionType: OptionType =
    (terms?.optionType ?? 'call').toUpperCase() === 'PUT' ? 'put' : 'call';
  const q = snap.latestQuote ?? {};
  const t = snap.latestTrade ?? {};
  return {
    symbol,
    underlying: (terms?.underlying ?? '').toUpperCase(),
    expiration: terms?.expiration ?? '',
    strike: terms?.strike ?? 0,
    optionType,
    bid: num(q.bp),
    ask: num(q.ap),
    last: num(t.p ?? q.bp),
  };
}

function mapOrderStatus(status: string | undefined): OrderStatus {
  switch ((status ?? '').toLowerCase()) {
    case 'new':
    case 'accepted':
    case 'pending_new':
    case 'accepted_for_bidding':
      return 'submitted';
    case 'partially_filled':
      return 'partially_filled';
    case 'filled':
      return 'filled';
    case 'canceled':
    case 'cancelled':
    case 'pending_cancel':
      return 'cancelled';
    case 'rejected':
    case 'expired':
    case 'done_for_day':
    case 'stopped':
    case 'suspended':
      return 'rejected';
    default:
      return 'submitted';
  }
}

export function toOrderResult(order: SdkOrder, orderId?: string): OrderResult {
  const id = order.client_order_id ?? order.id ?? orderId ?? '';
  const rawType = (order.type ?? 'limit').toLowerCase();
  const orderType: OrderType = rawType === 'market' ? 'market' : 'mid';
  return {
    orderId: id,
    status: mapOrderStatus(order.status),
    contractSymbol: order.symbol ?? '',
    side: (order.side as OrderSide) ?? 'buy',
    quantity: num(order.qty),
    orderType,
    limitPrice:
      order.limit_price !== null && order.limit_price !== undefined
        ? num(order.limit_price)
        : undefined,
    filledPrice:
      order.filled_avg_price !== null && order.filled_avg_price !== undefined
        ? num(order.filled_avg_price)
        : undefined,
    filledQuantity: num(order.filled_qty),
    timestamp: isoFrom(order.submitted_at),
  };
}

export function toPosition(pos: SdkPosition): Position | null {
  const assetClass = (pos.asset_class ?? '').toUpperCase();
  // The shared contract is options-only; equity/crypto positions are out of scope.
  if (assetClass !== 'OPT' && assetClass !== 'US_OPTION') return null;
  return {
    symbol: pos.symbol ?? '',
    assetClass: 'option',
    quantity: num(pos.qty),
    avgPrice: num(pos.avg_entry_price),
    markPrice: num(pos.current_price),
    unrealizedPnl: num(pos.unrealized_pl),
    multiplier: OPTION_MULTIPLIER,
  };
}
