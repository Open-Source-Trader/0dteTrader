/** Known tradable futures roots (FuturesRoots.swift). */
export const KNOWN_FUTURES_ROOTS = ['MES', 'ES', 'MNQ', 'NQ', 'CL', 'GC'];

export const FALLBACK_FUTURES_ROOT = 'MES';

/** Derives a futures root from a chart or contract symbol; longest prefix wins. */
export function futuresRootFor(symbol: string): string | null {
  const uppercased = symbol.toUpperCase();
  return (
    [...KNOWN_FUTURES_ROOTS]
      .sort((a, b) => b.length - a.length)
      .find((root) => uppercased.startsWith(root)) ?? null
  );
}
