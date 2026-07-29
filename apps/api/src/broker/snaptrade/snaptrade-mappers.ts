import {
  AccountOrderRecord,
  AccountOrderRecordOptionSymbol,
  AccountOrderRecordUniversalSymbol,
  AllAccountPositionsResponse,
  BrokerageAuthorization,
  OptionInstrument,
} from 'snaptrade-typescript-sdk';
import { OrderResult, OrderStatus, Position } from '@0dtetrader/shared-types';

// ---------------------------------------------------------------------------
// SnapTrade status → app status
// ---------------------------------------------------------------------------

const SNAPTRADE_STATUS_MAP: Record<string, OrderStatus> = {
  NONE: 'submitted',
  PENDING: 'submitted',
  ACCEPTED: 'submitted',
  FAILED: 'rejected',
  REJECTED: 'rejected',
  CANCELED: 'cancelled',
  CANCEL_PENDING: 'cancelled',
  PARTIAL_CANCELED: 'partially_filled',
  EXECUTED: 'filled',
  PARTIAL: 'partially_filled',
  REPLACE_PENDING: 'submitted',
  REPLACED: 'submitted',
  EXPIRED: 'cancelled',
  QUEUED: 'submitted',
  TRIGGERED: 'submitted',
  ACTIVATED: 'submitted',
};

export function mapOrderStatus(status: string | undefined): OrderStatus {
  return SNAPTRADE_STATUS_MAP[(status ?? '').toUpperCase()] ?? 'submitted';
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export function toOrderResult(order: AccountOrderRecord): OrderResult {
  const limitPrice = order.limit_price ? Number(order.limit_price) : undefined;
  const filledPrice = order.execution_price ? Number(order.execution_price) : undefined;
  const filledQuantity = order.filled_quantity ? Number(order.filled_quantity) : undefined;
  const symbol = optionSymbolOf(order) ?? equitySymbolOf(order) ?? '';
  return {
    orderId: order.brokerage_order_id ?? '',
    status: mapOrderStatus(order.status),
    contractSymbol: symbol,
    side: mapSide(order.action),
    quantity: Number(order.total_quantity ?? 0),
    orderType: mapOrderType(order.order_type),
    ...(Number.isFinite(limitPrice ?? NaN) ? { limitPrice } : {}),
    ...(Number.isFinite(filledPrice ?? NaN) ? { filledPrice } : {}),
    ...(Number.isFinite(filledQuantity ?? NaN) ? { filledQuantity } : {}),
    timestamp: order.time_placed ?? new Date().toISOString(),
  };
}

function optionSymbolOf(order: AccountOrderRecord): string | null {
  const opt = order.option_symbol as AccountOrderRecordOptionSymbol | undefined;
  if (!opt?.ticker) return null;
  return opt.ticker;
}

function equitySymbolOf(order: AccountOrderRecord): string | null {
  const uni = order.universal_symbol as AccountOrderRecordUniversalSymbol | undefined;
  if (!uni?.symbol) return null;
  return uni.symbol;
}

function mapSide(action: string | undefined): 'buy' | 'sell' {
  const a = (action ?? '').toUpperCase();
  if (a.startsWith('SELL')) return 'sell';
  return 'buy';
}

function mapOrderType(type: string | null | undefined): 'market' | 'mid' {
  const t = (type ?? '').toUpperCase();
  return t === 'MARKET' ? 'market' : 'mid';
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export function toPositions(response: AllAccountPositionsResponse): Position[] {
  return response.results.map((p) => toPosition(p)).filter((p): p is Position => p !== null);
}

export function toPosition(
  position: AllAccountPositionsResponse['results'][number],
): Position | null {
  const instrument = position.instrument as OptionInstrument | { kind: string };
  if (instrument.kind !== 'option') return null;
  const option = instrument as OptionInstrument;
  const multiplier = Number(option.multiplier ?? 100);
  const costBasis = Number(position.cost_basis ?? 0);
  const price = Number(position.price ?? 0);
  const units = Number(position.units ?? 0);
  return {
    symbol: option.symbol,
    assetClass: 'option',
    quantity: units,
    avgPrice: multiplier > 0 ? costBasis / multiplier : costBasis,
    markPrice: price,
    unrealizedPnl: (price - costBasis / multiplier) * multiplier * units,
    multiplier,
  };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export function mapConnection(auth: BrokerageAuthorization): {
  connectionId: string;
  brokerage: string;
  name: string;
  type: string;
  status: 'active' | 'broken' | 'pending';
  accountIds: string[];
} {
  return {
    connectionId: auth.id ?? '',
    brokerage: auth.brokerage?.name ?? 'unknown',
    name: auth.name ?? '',
    type: auth.type ?? 'read',
    status: auth.status === 'DISABLED' ? 'broken' : 'active',
    accountIds: [], // populated separately via listConnectionAccounts
  };
}

// ---------------------------------------------------------------------------
// Webhook order status
// ---------------------------------------------------------------------------

export function mapWebhookOrder(webhookOrder: AccountOrderRecord): OrderResult {
  return toOrderResult(webhookOrder);
}
