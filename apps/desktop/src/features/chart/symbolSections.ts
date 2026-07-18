export interface SymbolSection {
  title: string;
  symbols: string[];
}

/**
 * Curated watchlist sections for the symbol switcher. Kept in sync by hand
 * with SymbolSearchView.swift (iOS) — a shared source would live in
 * packages/shared-types.
 */
export const SYMBOL_SECTIONS: SymbolSection[] = [
  { title: 'Indices & ETFs', symbols: ['SPY', 'QQQ', 'SPX', 'IWM', 'DIA', 'VXX'] },
  // Live 24/7 data from Coinbase via the backend's crypto data source.
  { title: 'Crypto', symbols: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC'] },
  {
    title: 'Stocks',
    symbols: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'AMZN', 'META', 'GOOGL', 'AVGO', 'SMCI'],
  },
];
