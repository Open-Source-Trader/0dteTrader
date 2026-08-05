import type { OptionType } from '@0dtetrader/shared-types';

const OCC_RE = /^([A-Z.]{1,6})(\d{6})([CP])(\d{8})$/;

/**
 * Parses an OCC-style option symbol (SPY260717C00503000) — the format broker
 * positions carry. CURR mode resolves holdings through this rather than the
 * loaded chain, so a leg on a not-yet-fetched expiration still shows up.
 * Mirrors the server's parseOccSymbol (apps/api contract-resolution.ts).
 */
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
