import type { OptionType } from '@0dtetrader/shared-types';
import { bracketKindFor } from '@0dtetrader/shared-types';

/** Fraction of the underlying entry a freshly created leg sits away from it. */
export const BRACKET_DEFAULT_OFFSET_FRACTION = 0.0025;

/**
 * Default level for a workspace-created stop or target leg: 0.25% of the
 * underlying entry, in the loss direction for a stop and the profit direction
 * for a target. Close enough to read as attached to the entry, far enough to
 * grab and drag — a starting point, not advice.
 *
 * The direction is derived through `bracketKindFor` — the same classifier the
 * bracket drag uses — so a level this function returns can never be one the
 * drag path would label as the other kind (a long put's target sits BELOW its
 * entry, which a naive screen-up-is-target mapping gets wrong).
 */
export function defaultBracketLevel(
  kind: 'stop' | 'target',
  optionType: OptionType,
  quantity: number,
  underlyingEntryPrice: number,
): number {
  const up = underlyingEntryPrice * (1 + BRACKET_DEFAULT_OFFSET_FRACTION);
  const down = underlyingEntryPrice * (1 - BRACKET_DEFAULT_OFFSET_FRACTION);
  const level = bracketKindFor(optionType, quantity, underlyingEntryPrice, up) === kind ? up : down;
  return Math.round(level * 100) / 100;
}
