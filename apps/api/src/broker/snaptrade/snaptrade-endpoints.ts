import { OrderRequest } from '@0dtetrader/shared-types';
import { formatOccSymbol } from '../contract-resolution';

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

export interface SnapTradeHosts {
  /** SnapTrade API host (no separate data host — all calls are JSON API). */
  api: string;
}

export const SNAPTRADE_PROD_HOSTS: SnapTradeHosts = {
  api: 'https://api.snaptrade.com',
};

export const SNAPTRADE_SANDBOX_HOSTS: SnapTradeHosts = {
  api: 'https://api.sandbox.snaptrade.com',
};

// ---------------------------------------------------------------------------
// Enums / constants
// ---------------------------------------------------------------------------

export type PositionIntent = 'BUY_TO_OPEN' | 'BUY_TO_CLOSE' | 'SELL_TO_OPEN' | 'SELL_TO_CLOSE';

/** Derive the SnapTrade position intent from side + existing position qty. */
export function positionIntentFor(side: 'buy' | 'sell', existingQuantity: number): PositionIntent {
  if (side === 'buy') {
    return existingQuantity < 0 ? 'BUY_TO_CLOSE' : 'BUY_TO_OPEN';
  }
  return existingQuantity > 0 ? 'SELL_TO_CLOSE' : 'SELL_TO_OPEN';
}

// ---------------------------------------------------------------------------
// Equity order payload (placeForceOrder)
// ---------------------------------------------------------------------------

export interface EquityOrderPayload {
  account_id: string;
  action: 'BUY' | 'SELL';
  symbol: string;
  order_type: 'Market' | 'Limit' | 'Stop' | 'StopLimit';
  time_in_force: 'Day' | 'GTC';
  units: number;
  price?: number | null;
  client_order_id?: string | null;
  universal_symbol_id: null;
}

export function buildEquityOrderPayload(
  accountId: string,
  order: OrderRequest,
  limitPrice?: number,
  clientOrderId?: string,
): EquityOrderPayload {
  const action = order.side.toUpperCase() as 'BUY' | 'SELL';
  const payload: EquityOrderPayload = {
    account_id: accountId,
    action,
    symbol: order.underlying.toUpperCase(),
    order_type: order.orderType === 'market' ? 'Market' : 'Limit',
    time_in_force: 'Day',
    units: order.quantity,
    universal_symbol_id: null,
  };
  if (order.orderType === 'mid' && limitPrice !== undefined) {
    payload.price = limitPrice;
  }
  if (clientOrderId) payload.client_order_id = clientOrderId;
  return payload;
}

// ---------------------------------------------------------------------------
// Option order payload (placeMlegOrder)
// ---------------------------------------------------------------------------

export interface OptionLegPayload {
  instrument: {
    symbol: string;
    instrument_type: 'OPTION';
  };
  action: PositionIntent;
  units: number;
}

export interface OptionOrderPayload {
  order_type: 'MARKET' | 'LIMIT';
  time_in_force: 'Day' | 'GTC';
  limit_price?: string | null;
  price_effect?: 'DEBIT' | 'CREDIT' | 'EVEN';
  legs: OptionLegPayload[];
}

export function buildOptionOrderPayload(
  _accountId: string,
  order: OrderRequest,
  limitPrice?: number,
  priceEffect?: 'DEBIT' | 'CREDIT',
  positionIntent?: PositionIntent,
): OptionOrderPayload {
  const occ = formatOccSymbol(
    order.underlying,
    order.selection.expiration ?? '',
    order.selection.optionType ?? 'call',
    order.selection.strike ?? 0,
  );
  const intent = positionIntent ?? (order.side === 'buy' ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN');
  const payload: OptionOrderPayload = {
    order_type: order.orderType === 'market' ? 'MARKET' : 'LIMIT',
    time_in_force: 'Day',
    legs: [
      {
        instrument: { symbol: occ, instrument_type: 'OPTION' },
        action: intent,
        units: order.quantity,
      },
    ],
  };
  if (order.orderType === 'mid' && limitPrice !== undefined) {
    payload.limit_price = String(limitPrice);
  }
  if (priceEffect) payload.price_effect = priceEffect;
  return payload;
}

// ---------------------------------------------------------------------------
// Preview payloads
// ---------------------------------------------------------------------------

export function buildEquityImpactPayload(
  accountId: string,
  order: OrderRequest,
  limitPrice?: number,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    account_id: accountId,
    action: order.side.toUpperCase(),
    universal_symbol_id: null,
    symbol: order.underlying.toUpperCase(),
    order_type: order.orderType === 'market' ? 'Market' : 'Limit',
    time_in_force: 'Day',
    units: order.quantity,
  };
  if (order.orderType === 'mid' && limitPrice !== undefined) {
    payload.price = limitPrice;
  }
  return payload;
}

export function buildOptionImpactPayload(
  order: OrderRequest,
  limitPrice?: number,
  priceEffect?: 'DEBIT' | 'CREDIT',
  positionIntent?: PositionIntent,
): OptionOrderPayload {
  const occ = formatOccSymbol(
    order.underlying,
    order.selection.expiration ?? '',
    order.selection.optionType ?? 'call',
    order.selection.strike ?? 0,
  );
  const intent = positionIntent ?? (order.side === 'buy' ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN');
  const payload: OptionOrderPayload = {
    order_type: order.orderType === 'market' ? 'MARKET' : 'LIMIT',
    time_in_force: 'Day',
    legs: [
      {
        instrument: { symbol: occ, instrument_type: 'OPTION' },
        action: intent,
        units: order.quantity,
      },
    ],
  };
  if (order.orderType === 'mid' && limitPrice !== undefined) {
    payload.limit_price = String(limitPrice);
  }
  if (priceEffect) payload.price_effect = priceEffect;
  return payload;
}
