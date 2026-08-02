import type { ChartOrder, OptionType, Position } from '@0dtetrader/shared-types';
import { positionProfitDirection } from '@0dtetrader/shared-types';
import { parseDateTime } from '../../core/models/dates';
import { Format } from '../../design/format';

/** What "Move stop to entry" would do: move `stop` to the position's
 *  underlying entry. Null when there is no stop line, no entry anchor, no
 *  live price, no known option type — or when the entry is NOT on the loss
 *  side of the live price: a "stop" moved to the profit side of the market
 *  arms as a break-even recovery exit, firing when the position comes BACK,
 *  which is the opposite of what the button's label promises. Null is exactly
 *  when the button disables, so gate and action agree. */
export function moveStopToEntryRequest(
  position: Position,
  stop: ChartOrder | null,
  underlyingPrice: number | null,
  optionType: OptionType | null,
): { order: ChartOrder; triggerPrice: number } | null {
  if (!stop || position.underlyingEntryPrice === undefined) return null;
  if (underlyingPrice === null || optionType === null) return null;
  const direction = positionProfitDirection(optionType, position.quantity);
  if ((underlyingPrice - position.underlyingEntryPrice) * direction <= 0) return null;
  return { order: stop, triggerPrice: position.underlyingEntryPrice };
}

export function signedCurrency(value: number): string {
  if (value === 0) return `$${Format.price(0)}`;
  return value < 0 ? `-$${Format.price(Math.abs(value))}` : `+$${Format.price(value)}`;
}

/** `4m` / `1h 12m` since the position run opened; an em dash when unknown. */
export function timeInTrade(position: Position, now = Date.now()): string {
  if (!position.openedAt) return '—';
  const opened = parseDateTime(position.openedAt);
  if (opened === null) return '—';
  const minutes = Math.max(0, Math.floor((now - opened) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function pnlPercent(position: Position): number {
  const basis = Math.abs(position.avgPrice * position.quantity * position.multiplier);
  return basis > 0 ? (position.unrealizedPnl / basis) * 100 : 0;
}

export function dayPnl(positions: Position[]): number {
  return positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
}

export function desktopTradeWorkspaceHeight({
  expanded,
  hasActivity,
}: {
  expanded: boolean;
  hasActivity: boolean;
}): number {
  if (expanded) return 220;
  return hasActivity ? 124 : 36;
}
