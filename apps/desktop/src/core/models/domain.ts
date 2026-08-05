import type {
  OptionContract,
  OptionType,
  OrderSide,
  OrderStatus,
  OrderType,
} from '@0dtetrader/shared-types';

/**
 * `(bid + ask) / 2` rounded to pennies (PriceMath.swift). Advisory only.
 * Null when the quote is unusable (zero/negative side, crossed spread, NaN),
 * mirroring the server's computeMid validation; a locked market is allowed.
 */
export function midPrice(bid: number, ask: number, precision = 2): number | null {
  if (!(bid > 0) || !(ask > 0) || bid > ask) return null;
  const factor = Math.pow(10, precision);
  return Math.round(((bid + ask) / 2) * factor) / factor;
}

/**
 * No TWO-SIDED quote — a CURR leg synthesized from its OCC symbol before its
 * expiration's contracts load, or a contract with nothing but a stale last
 * trade. Every trading gate (split panel, desktop rail, fullscreen
 * buttons/shortcuts) disables on it so a 0.00 display is never tradeable;
 * TradeStore.arm keeps a matching guard as the backstop.
 *
 * `last` deliberately does not count. It is a print from whenever the
 * contract last traded, which on an illiquid strike can be hours old, and
 * every order type this app sends is priced from the live bid/ask — a mid
 * order with no book has nothing to compute a limit from. iOS applies the
 * same rule (`hasTradeableQuote`), and the two clients disagreeing about
 * whether an order can be sent is worse than either rule alone.
 */
export function quotesPending(contract: OptionContract | null): boolean {
  return contract !== null && contract.bid <= 0 && contract.ask <= 0;
}

export function oppositeSide(side: OrderSide): OrderSide {
  return side === 'buy' ? 'sell' : 'buy';
}

export function sideDisplayName(side: OrderSide): string {
  return side.toUpperCase();
}

/** Short name for a list (history, the positions strip). */
export function orderTypeDisplayName(type: OrderType | string): string {
  switch (type) {
    case 'custom':
      return 'Custom';
    case 'bid':
      return 'Bid';
    case 'mid':
      return 'Mid';
    case 'ask':
      return 'Ask';
    case 'market':
      return 'Market';
    // Rows written before this widened, and anything a broker reports back
    // that we do not have a name for, print as they came.
    default:
      return String(type);
  }
}

/**
 * How the order is priced, spelled out — the confirm sheet's phrasing, where
 * "Ask" alone would not say whether it is a limit or a market order.
 */
export function orderPricingDescription(type: OrderType): string {
  switch (type) {
    case 'custom':
      return 'Limit at your price';
    case 'bid':
      return 'Limit at bid';
    case 'mid':
      return 'Limit at mid';
    case 'ask':
      return 'Limit at ask';
    case 'market':
      return 'Market';
  }
}

export function optionTypeDisplayName(type: OptionType): string {
  return type === 'call' ? 'Call' : 'Put';
}

export function optionTypeShortName(type: OptionType): string {
  return type === 'call' ? 'C' : 'P';
}

/** Tolerant of unknown status strings, like the iOS OrderStatus enum. */
export function orderStatusDisplayName(status: OrderStatus | string): string {
  switch (status) {
    case 'submitted':
      return 'Submitted';
    case 'filled':
      return 'Filled';
    case 'partially_filled':
      return 'Partially filled';
    case 'cancelled':
      return 'Cancelled';
    case 'rejected':
      return 'Rejected';
    default:
      return 'Unknown';
  }
}

/**
 * History-row label: an order still resting at the broker reads as "Waiting"
 * rather than its wire status name. Display only — the wire values are
 * unchanged and toasts keep the status names.
 */
export function orderStatusHistoryLabel(status: OrderStatus | string): string {
  if (status === 'submitted') return 'Waiting';
  if (status === 'partially_filled') return 'Waiting · partial fill';
  return orderStatusDisplayName(status);
}
