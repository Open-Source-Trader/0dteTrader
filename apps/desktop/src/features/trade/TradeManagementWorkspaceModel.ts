import type { Position } from '@0dtetrader/shared-types';
import { Format } from '../../design/format';

export function signedCurrency(value: number): string {
  if (value === 0) return `$${Format.price(0)}`;
  return value < 0 ? `-$${Format.price(Math.abs(value))}` : `+$${Format.price(value)}`;
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
