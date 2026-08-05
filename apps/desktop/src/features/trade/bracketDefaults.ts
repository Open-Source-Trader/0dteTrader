import type { OptionType } from '@0dtetrader/shared-types';
import { positionProfitDirection } from '@0dtetrader/shared-types';

/** Fraction of the live underlying price a freshly created leg sits away from it. */
export const BRACKET_DEFAULT_OFFSET_FRACTION = 0.0025;

/**
 * Default level for a workspace-created stop or target leg: 0.25% of the LIVE
 * underlying price, on the profit side for a target and the loss side for a
 * stop (per `positionProfitDirection` — a long put profits downward, so its
 * target sits BELOW the market). Close enough to read as attached, far enough
 * to grab and drag — a starting point, not advice.
 *
 * Anchored on the live price, never the entry: however far the market has
 * moved since entry, the default lands on the correct side of it. A level the
 * market already sits beyond would arm inverted — a "target" below the price
 * fires on the way down, exactly like a stop.
 */
export function defaultBracketLevel(
  kind: 'stop' | 'target',
  optionType: OptionType,
  quantity: number,
  underlyingPrice: number,
): number {
  const profitDirection = positionProfitDirection(optionType, quantity);
  const towardProfit = kind === 'target' ? 1 : -1;
  const level =
    underlyingPrice * (1 + BRACKET_DEFAULT_OFFSET_FRACTION * profitDirection * towardProfit);
  return Math.round(level * 100) / 100;
}
