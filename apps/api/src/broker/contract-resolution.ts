import { AssetClass, OptionContract, OptionType } from '@0dtetrader/shared-types';
import { errors } from '../common/api-exception';

/**
 * Pure contract-resolution helpers shared by the trading module (server-side
 * re-validation, docs/SECURITY.md §4) and the broker gateways. Keeping them
 * here means the resolution rules live in exactly one place.
 */

export const OPTION_MULTIPLIER = 100;

/** Futures root → contract specs used by the mock gateway. */
export const FUTURES_SPECS: Record<
  string,
  { base: number; multiplier: number }
> = {
  ES: { base: 6000, multiplier: 50 },
  MES: { base: 6000, multiplier: 5 },
  NQ: { base: 22000, multiplier: 20 },
  MNQ: { base: 22000, multiplier: 2 },
  CL: { base: 80, multiplier: 1000 },
  GC: { base: 2400, multiplier: 100 },
};

/** Fraction of notional required as buying power for a futures position. */
export const FUTURES_MARGIN_RATE = 0.1;

// ---------------------------------------------------------------------------
// Expiration selection
// ---------------------------------------------------------------------------

/**
 * Picks the expiration to trade. Defaults to the nearest (first) expiration
 * in the chain; a requested expiration must exist in the chain.
 */
export function pickExpiration(
  expirations: string[],
  requested?: string,
): string {
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
// Auto-OTM strike resolution (+1 strike out of the money)
// ---------------------------------------------------------------------------

/**
 * Resolves the +1 OTM contract from the live quote and chain:
 * - calls: the lowest strike STRICTLY above the underlying's last price
 * - puts:  the highest strike STRICTLY below the underlying's last price
 *
 * Strictly above/below: when the last price sits exactly on a strike, that
 * strike is ATM and is excluded in both directions.
 */
export function resolveAutoOtm(
  contracts: OptionContract[],
  optionType: OptionType,
  last: number,
): OptionContract {
  const candidates = contracts
    .filter((c) => c.optionType === optionType)
    .map((c) => c.strike);

  let target: number | undefined;
  if (optionType === 'call') {
    target = candidates.filter((s) => s > last).sort((a, b) => a - b)[0];
  } else {
    target = candidates.filter((s) => s < last).sort((a, b) => b - a)[0];
  }

  if (target === undefined) {
    throw errors.validation(
      `No ${optionType} contract ${optionType === 'call' ? 'above' : 'below'} ` +
        `the underlying price ${last} in this chain`,
    );
  }
  return contracts.find(
    (c) => c.optionType === optionType && c.strike === target,
  )!;
}

/** Finds an explicitly requested option contract in the chain. */
export function findExplicitOption(
  contracts: OptionContract[],
  optionType: OptionType,
  strike: number,
): OptionContract | undefined {
  return contracts.find(
    (c) => c.optionType === optionType && c.strike === strike,
  );
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
  if (!(bid > 0) || !(ask > 0) || bid > ask) {
    throw errors.validation(
      `Cannot compute mid price: spread is crossed or invalid (bid=${bid}, ask=${ask})`,
    );
  }
  return Math.round(((bid + ask) / 2) * 100) / 100;
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

export function parseOccSymbol(
  symbol: string,
): {
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

export function estimateBuyingPower(
  assetClass: AssetClass,
  contractSymbol: string,
  quantity: number,
  price: number,
): number {
  if (assetClass === 'option') {
    return quantity * price * OPTION_MULTIPLIER;
  }
  const root = futuresRootOf(contractSymbol);
  const multiplier = root ? FUTURES_SPECS[root].multiplier : 1;
  return quantity * price * multiplier * FUTURES_MARGIN_RATE;
}

const FUTURES_SYMBOL_RE = /^([A-Z]{1,4})([FGHJKMNQUVXZ])(\d{2})$/;

/** Extracts the futures root from a contract symbol like MESU26 → MES. */
export function futuresRootOf(symbol: string): string | null {
  const match = FUTURES_SYMBOL_RE.exec(symbol);
  if (!match) return null;
  const root = match[1];
  return FUTURES_SPECS[root] ? root : null;
}
