import { MAX_OPTION_PRICE, OptionContract, OptionType } from '@0dtetrader/shared-types';
import { errors } from '../common/api-exception';

/**
 * Pure contract-resolution helpers shared by the trading module (server-side
 * re-validation, docs/SECURITY.md §4) and the broker gateways. Keeping them
 * here means the resolution rules live in exactly one place.
 */

export const OPTION_MULTIPLIER = 100;

// ---------------------------------------------------------------------------
// Expiration selection
// ---------------------------------------------------------------------------

/**
 * Picks the expiration to trade. Defaults to the nearest (first) expiration
 * in the chain; a requested expiration must exist in the chain.
 */
export function pickExpiration(expirations: string[], requested?: string): string {
  if (expirations.length === 0) {
    throw errors.validation('No expirations available for this underlying');
  }
  if (!requested) return expirations[0];
  if (!expirations.includes(requested)) {
    throw errors.validation(
      `Expiration ${requested} is not available. Available: ${expirations.join(', ')}`,
    );
  }
  return requested;
}

// ---------------------------------------------------------------------------
// Classic Auto strike resolution (ATM anchor + exactly one strike OTM)
// ---------------------------------------------------------------------------

/**
 * Resolves the auto-selected contract from the live quote and chain: anchor on
 * the ATM strike — the one closest to the underlying's last price, ties
 * resolving toward the OTM side — then step exactly one rung out of the money
 * (calls up the ladder, puts down).
 */
export function resolveAutoOtm(
  contracts: OptionContract[],
  optionType: OptionType,
  last: number,
): OptionContract {
  const ladder = [
    ...new Set(contracts.filter((c) => c.optionType === optionType).map((c) => c.strike)),
  ].sort((a, b) => a - b);

  // Ties prefer the later (higher) rung for calls and the earlier (lower) one
  // for puts — both are the OTM side of an equidistant pair.
  let atm = 0;
  for (let i = 1; i < ladder.length; i++) {
    const distance = Math.abs(ladder[i] - last);
    const best = Math.abs(ladder[atm] - last);
    if (distance < best || (distance === best && optionType === 'call')) atm = i;
  }

  // Out-of-range indexes (including the empty ladder) fall out as undefined.
  const target: number | undefined = ladder[optionType === 'call' ? atm + 1 : atm - 1];

  if (target === undefined) {
    throw errors.validation(
      `No ${optionType} contract one strike out from ` +
        `the at-the-money strike for underlying price ${last} in this chain`,
    );
  }
  return contracts.find((c) => c.optionType === optionType && c.strike === target)!;
}

/** Finds an explicitly requested option contract in the chain. */
export function findExplicitOption(
  contracts: OptionContract[],
  optionType: OptionType,
  strike: number,
): OptionContract | undefined {
  return contracts.find((c) => c.optionType === optionType && c.strike === strike);
}

// ---------------------------------------------------------------------------
// Mid price
// ---------------------------------------------------------------------------

/**
 * Mid price = (bid + ask) / 2, recomputed from the live quote. A crossed or
 * locked-abnormal market (bid >= ask beyond rounding) is a validation error
 * per docs/API-SPEC.md.
 */
export function computeMid(bid: number, ask: number): number {
  // Finiteness AND the shared ceiling: a feed glitch can deliver ±Infinity,
  // and two FINITE sides can still overflow the sum below (1e308 + 1e308 is
  // Infinity). Bounding the inputs to MAX_OPTION_PRICE makes the result
  // finite and in range by construction; the final check is the belt for
  // any arithmetic surprise.
  if (
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    !(bid > 0) ||
    !(ask > 0) ||
    bid > ask ||
    ask > MAX_OPTION_PRICE
  ) {
    throw errors.validation(
      `Cannot compute mid price: spread is crossed or invalid (bid=${bid}, ask=${ask})`,
    );
  }
  const mid = Math.round(((bid + ask) / 2) * 100) / 100;
  if (!Number.isFinite(mid) || mid > MAX_OPTION_PRICE) {
    throw errors.validation(
      `Cannot compute mid price: result out of range (bid=${bid}, ask=${ask})`,
    );
  }
  return mid;
}

// ---------------------------------------------------------------------------
// OCC-style option symbols (e.g. SPY260717C00503000)
// ---------------------------------------------------------------------------

const OCC_RE = /^([A-Z.]{1,6})(\d{6})([CP])(\d{8})$/;

export function formatOccSymbol(
  underlying: string,
  expiration: string, // YYYY-MM-DD
  optionType: OptionType,
  strike: number,
): string {
  const [y, m, d] = expiration.split('-');
  const cp = optionType === 'call' ? 'C' : 'P';
  const strikeField = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${underlying.toUpperCase()}${y.slice(2)}${m}${d}${cp}${strikeField}`;
}

export function parseOccSymbol(symbol: string): {
  underlying: string;
  expiration: string;
  optionType: OptionType;
  strike: number;
} | null {
  const match = OCC_RE.exec(symbol);
  if (!match) return null;
  const [, underlying, ymd, cp, strikeField] = match;
  return {
    underlying,
    expiration: `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`,
    optionType: cp === 'C' ? 'call' : 'put',
    strike: Number(strikeField) / 1000,
  };
}

// ---------------------------------------------------------------------------
// Buying power estimate
// ---------------------------------------------------------------------------

export function estimateBuyingPower(quantity: number, price: number): number {
  return quantity * price * OPTION_MULTIPLIER;
}
