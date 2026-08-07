export interface SymbolSection {
  title: string;
  symbols: string[];
}

export const CRYPTO_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC'];

export function isContinuousMarketSymbol(symbol: string): boolean {
  return CRYPTO_SYMBOLS.includes(symbol.trim().toUpperCase());
}

/**
 * Curated watchlist sections for the symbol switcher. Kept in sync by hand
 * with SymbolSearchView.swift (iOS) — a shared source would live in
 * packages/shared-types.
 */
export const SYMBOL_SECTIONS: SymbolSection[] = [
  // SPX/NDX/VIX are index quotes from Tradier via the backend (not tradeable).
  { title: 'Indices & ETFs', symbols: ['SPY', 'QQQ', 'SPX', 'NDX', 'VIX', 'IWM', 'DIA', 'VXX'] },
  // Live 24/7 data from Coinbase via the backend's crypto data source.
  { title: 'Crypto', symbols: CRYPTO_SYMBOLS },
  {
    title: 'Stocks',
    symbols: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'AMZN', 'META', 'GOOGL', 'AVGO', 'SMCI'],
  },
];

/** Enter-key selection for the symbol switcher (SymbolSpotlight,
 *  SymbolSearchView): prefer whichever row is keyboard-highlighted — this
 *  works whether or not the user typed anything, since arrow keys alone can
 *  move the highlight onto a curated symbol from an empty query. Falls back
 *  to the raw typed text only when nothing is highlighted (empty results). */
export function resolveEnterSelection(
  visibleRows: string[],
  activeIndex: number,
  normalizedQuery: string,
): string | null {
  const highlighted = visibleRows[activeIndex];
  if (highlighted) return highlighted;
  return normalizedQuery || null;
}
