import { MAX_OPTION_PRICE } from '@0dtetrader/shared-types';

/**
 * Shared rules for a free-text price field.
 *
 * Extracted from `OrderPlacementPopover`, which learned them the hard way, so
 * the trade panel's custom-limit field inherits them rather than rediscovering
 * them. Mirrors `PlacementGuide.swift`'s `isLevelInputShape` / `parseLevelInput`
 * on iOS; the two test suites are what keep the platforms from drifting apart.
 *
 * The rule that matters: hold the raw draft on every keystroke, shape-gate
 * before parsing, and only settle to the canonical string on blur. A field that
 * re-renders `String(price)` mid-word eats the decimal point — `'4300.'` parses
 * perfectly well to `4300`, so `4300.50` becomes `430050`.
 */

/** One tick. Option premiums and chart levels are both quoted in whole cents. */
export const PRICE_STEP = 0.01;

/**
 * Bounds a typed price has to fall inside. A stepper clamps to the same range,
 * but the validation is what stops a *typed or pasted* price from getting
 * through — without the ceiling a twenty-digit number is finite and passes every
 * other guard. Mirrored by `AppPlacementGuide.levelMinimum/Maximum` on iOS and
 * by `MIN_LIMIT_PRICE`/`MAX_LIMIT_PRICE` on the server.
 */
export const PRICE_MIN = 0.01;
// The shared option-price ceiling — typed input must refuse exactly what
// readiness and resolution refuse.
export const PRICE_MAX = MAX_OPTION_PRICE;

/**
 * Digits, optionally one decimal point. Deliberately matches the part-typed
 * forms a price passes through on the way in (`''`, `'.'`, `'4300.'`), because
 * rejecting those is what eats the decimal point mid-word. It rejects
 * everything `Number` is otherwise happy to read as a price: `'1e5'`, `'0x1f'`,
 * `'Infinity'`, `'-3'`, `' 42 '`.
 */
export const PRICE_SHAPE = /^\d*\.?\d*$/;

/** Whether `text` is a shape the field is allowed to hold. */
export function isPriceInputShape(text: string): boolean {
  return PRICE_SHAPE.test(text);
}

/**
 * The price `text` names, or null while it does not name one yet.
 *
 * Null covers both "still being typed" (`''`, `'.'`) and "not a price at all".
 * The caller cannot submit either, which is the point: a cleared field parses to
 * `0`, which is finite and passes every other guard.
 */
export function parsePriceInput(text: string): number | null {
  if (!isPriceInputShape(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < PRICE_MIN || value > PRICE_MAX) return null;
  return value;
}

/**
 * Rounds to the tick a price is actually quoted at.
 *
 * Divide-and-multiply by the step is the obvious spelling and the wrong one:
 * `Math.round(2.45 / 0.01) * 0.01` is 2.4500000000000002, which the server's
 * tick check then rejects. Scaling by 100 keeps the arithmetic on integers.
 */
export function roundToTick(value: number): number {
  return Math.round(value * 100) / 100;
}
