import { OrderType } from '@0dtetrader/shared-types';
import { computeMid } from './contract-resolution';

/**
 * Pure order-pricing rules: what price each `OrderType` executes at, what a
 * client-supplied `limitPrice` has to look like to be accepted, and when one is
 * odd enough to warn about.
 *
 * Separate from `contract-resolution.ts` (which answers "which contract") and
 * shared by the DTO, the trading module and both broker gateways, so a price
 * cannot be resolved one way in a preview and another way at placement.
 */

/** Option premiums are quoted in whole cents. */
export const OPTION_TICK = 0.01;

/**
 * Bounds a custom limit has to fall inside. Mirrors the placement guide's
 * level bounds on both clients (`AppPlacementGuide.levelMinimum/Maximum`,
 * `LEVEL_MIN`/`LEVEL_MAX`) so the three agree on what a price even is.
 *
 * The ceiling is the half that matters here: without it a pasted twenty-digit
 * premium is finite, positive, tick-aligned, and would be sent.
 */
export const MIN_LIMIT_PRICE = 0.01;
export const MAX_LIMIT_PRICE = 100_000;

/**
 * How far outside the current spread a custom limit may sit before the preview
 * warns about it. A fraction of the *quote*, not of the spread.
 *
 * Spread-relative was the obvious first choice and is the wrong one: a 0DTE
 * contract is often quoted a penny or two wide and repriced several times a
 * second, so any multiple of the spread tight enough to catch a mistake fires
 * on essentially every custom order — and a warning that always fires is one
 * nobody reads.
 *
 * 0.5 is set against the error this guard actually exists for, a misplaced
 * decimal point: 2.45 typed as 24.50 is 10x the ask and trips it by a mile,
 * while paying up (or bidding under) by the 10-20% a fast contract routinely
 * demands does not. It warns; it never blocks — the user may well mean it.
 */
export const CUSTOM_PRICE_WARNING_MARGIN = 0.5;

/** The bid/ask/last a price is resolved against. */
export interface PricingQuote {
  bid: number;
  ask: number;
  last: number;
}

/**
 * Why `limitPrice` is not acceptable for this `orderType`, or null when it is.
 *
 * Required for `custom` and rejected for everything else: the other four are
 * priced from the server's own quote, so a number alongside them is one the
 * server would silently ignore — better to say so than to fill at a price the
 * client thought it had asked for.
 *
 * Returns the message rather than throwing so the DTO decorator, which needs
 * both a boolean and a reason, can use the one implementation.
 */
export function validateLimitPrice(orderType: OrderType, limitPrice: unknown): string | null {
  if (orderType !== 'custom') {
    return limitPrice === undefined || limitPrice === null
      ? null
      : 'limitPrice is only accepted when orderType is custom';
  }
  if (limitPrice === undefined || limitPrice === null) {
    return 'limitPrice is required when orderType is custom';
  }
  if (typeof limitPrice !== 'number' || !Number.isFinite(limitPrice)) {
    return 'limitPrice must be a finite number';
  }
  if (limitPrice < MIN_LIMIT_PRICE || limitPrice > MAX_LIMIT_PRICE) {
    return `limitPrice must be between ${MIN_LIMIT_PRICE} and ${MAX_LIMIT_PRICE}`;
  }
  // Cents, compared as integers: 0.07 / 0.01 is 6.999999999999999 in binary
  // floating point, so the obvious modulo rejects prices that are perfectly
  // tick-aligned.
  const cents = Math.round(limitPrice / OPTION_TICK);
  if (Math.abs(cents * OPTION_TICK - limitPrice) > 1e-9) {
    return `limitPrice must be a whole number of ${OPTION_TICK} ticks`;
  }
  return null;
}

/**
 * The limit price this order works at, or undefined for a market order.
 *
 * `bid`, `mid` and `ask` are read off the server's own quote at execution time,
 * exactly as `mid` always was — the client never supplies them, so there is
 * nothing here to trust. `custom` is the one price that came from outside, and
 * it has already been through `validateLimitPrice` at the DTO.
 *
 * A crossed or unquotable market fails the same way it always did, via
 * `computeMid`: refusing to price a limit against a broken quote is the whole
 * reason that check exists, and `bid`/`ask` are no more meaningful than `mid`
 * when bid > ask.
 */
export function resolveLimitPrice(
  orderType: OrderType,
  quote: PricingQuote,
  limitPrice?: number,
): number | undefined {
  switch (orderType) {
    case 'market':
      return undefined;
    case 'custom':
      // Undefined only if the DTO was bypassed; fall back to the mid rather
      // than sending a limit order with no limit.
      return limitPrice ?? computeMid(quote.bid, quote.ask);
    case 'bid':
      // Validated through computeMid first: a bid of 0 (or a crossed book) is
      // not a price to rest an order at any more than the mid of one is.
      computeMid(quote.bid, quote.ask);
      return round2(quote.bid);
    case 'ask':
      computeMid(quote.bid, quote.ask);
      return round2(quote.ask);
    case 'mid':
      return computeMid(quote.bid, quote.ask);
  }
}

/**
 * A warning when a custom limit sits more than `CUSTOM_PRICE_WARNING_MARGIN`
 * outside the current spread, or null. Never an error — see the constant.
 */
export function customPriceWarning(
  orderType: OrderType,
  quote: PricingQuote,
  limitPrice?: number,
): string | null {
  if (orderType !== 'custom' || limitPrice === undefined) return null;
  if (!(quote.bid > 0) || !(quote.ask > 0) || quote.bid > quote.ask) return null;

  const ceiling = quote.ask * (1 + CUSTOM_PRICE_WARNING_MARGIN);
  const floor = quote.bid * (1 - CUSTOM_PRICE_WARNING_MARGIN);
  if (limitPrice <= ceiling && limitPrice >= floor) return null;

  const direction = limitPrice > ceiling ? 'above' : 'below';
  return (
    `Custom limit ${round2(limitPrice)} is far ${direction} the current spread ` +
    `${round2(quote.bid)} / ${round2(quote.ask)} — check the decimal point`
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
