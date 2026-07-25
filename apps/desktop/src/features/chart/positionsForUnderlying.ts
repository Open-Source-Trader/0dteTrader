import type { OptionContract, Position } from '@0dtetrader/shared-types';

/** Positions filtered to those whose contract's underlying matches the
 *  chart's current symbol, using the already-loaded chain to resolve each
 *  position's contract (Position itself carries no underlying field). */
export function positionsForUnderlying(
  positions: Position[],
  chartSymbol: string,
  contracts: OptionContract[],
): Position[] {
  const underlyingBySymbol = new Map(contracts.map((c) => [c.symbol, c.underlying]));
  return positions.filter((position) => underlyingBySymbol.get(position.symbol) === chartSymbol);
}
