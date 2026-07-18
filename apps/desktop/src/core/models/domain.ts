import type { OptionType, OrderSide, OrderStatus, OrderType } from '@0dtetrader/shared-types';

/** `(bid + ask) / 2` rounded to pennies (PriceMath.swift). Advisory only. */
export function midPrice(bid: number, ask: number, precision = 2): number {
  const factor = Math.pow(10, precision);
  return Math.round(((bid + ask) / 2) * factor) / factor;
}

export function oppositeSide(side: OrderSide): OrderSide {
  return side === 'buy' ? 'sell' : 'buy';
}

export function sideDisplayName(side: OrderSide): string {
  return side.toUpperCase();
}

export function orderTypeDisplayName(type: OrderType): string {
  return type === 'mid' ? 'Mid' : 'Market';
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
