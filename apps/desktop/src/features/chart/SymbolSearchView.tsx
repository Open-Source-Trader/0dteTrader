import { useMemo, useState } from 'react';
import { NavBar } from '../../design/components/NavBar';
import { Sheet } from '../../design/components/Sheet';
import { CheckmarkIcon, MagnifierIcon, TextCursorIcon } from '../../design/icons';

interface SymbolSection {
  title: string;
  symbols: string[];
}

const SECTIONS: SymbolSection[] = [
  { title: 'Indices & ETFs', symbols: ['SPY', 'QQQ', 'SPX', 'IWM', 'DIA', 'VXX'] },
  { title: 'Futures Roots', symbols: ['MES', 'ES', 'MNQ', 'NQ', 'CL', 'GC'] },
  {
    title: 'Stocks',
    symbols: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'AMZN', 'META', 'GOOGL', 'AVGO', 'SMCI'],
  },
];

interface SymbolSearchViewProps {
  currentSymbol: string;
  onSelect: (symbol: string) => void;
  onDismiss: () => void;
}

/** Symbol switcher: curated watchlist plus arbitrary free-text symbols. */
export function SymbolSearchView({ currentSymbol, onSelect, onDismiss }: SymbolSearchViewProps) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.toUpperCase().trim();

  const showsCustomSymbol = useMemo(() => {
    if (!normalizedQuery) return false;
    return !SECTIONS.some((section) => section.symbols.includes(normalizedQuery));
  }, [normalizedQuery]);

  const filtered = (symbols: string[]) =>
    normalizedQuery ? symbols.filter((symbol) => symbol.includes(normalizedQuery)) : symbols;

  const select = (symbol: string) => {
    onSelect(symbol);
    onDismiss();
  };

  return (
    <Sheet detent="large" onDismiss={onDismiss}>
      <div style={{ background: 'var(--app-background)', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <NavBar
          title="Symbol"
          trailing={
            <button className="navbar-text-button" onClick={onDismiss}>
              Close
            </button>
          }
        />
        <div style={{ padding: '4px 16px 8px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 36,
              padding: '0 10px',
              background: 'var(--app-surface-elevated)',
              borderRadius: 10,
            }}
          >
            <MagnifierIcon size={14} style={{ color: 'var(--label-secondary)' }} />
            <input
              placeholder="Symbol"
              autoFocus
              spellCheck={false}
              style={{ flex: 1, textTransform: 'uppercase' }}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && normalizedQuery) select(normalizedQuery);
              }}
            />
          </div>
        </div>

        <div className="sheet-body grouped-list hide-scrollbar">
          {showsCustomSymbol ? (
            <div className="grouped-section">
              <div className="section-card">
                <button className="grouped-row" onClick={() => select(normalizedQuery)}>
                  <TextCursorIcon size={15} style={{ color: 'var(--app-accent)' }} />
                  <span>Use &quot;{normalizedQuery}&quot;</span>
                </button>
              </div>
            </div>
          ) : null}

          {SECTIONS.map((section) => {
            const symbols = filtered(section.symbols);
            if (symbols.length === 0) return null;
            return (
              <div className="grouped-section" key={section.title}>
                <div className="section-header">{section.title}</div>
                <div className="section-card">
                  {symbols.map((symbol) => (
                    <button className="grouped-row" key={symbol} onClick={() => select(symbol)}>
                      <span>{symbol}</span>
                      {symbol === currentSymbol ? (
                        <span className="row-value" style={{ color: 'var(--app-accent)' }}>
                          <CheckmarkIcon size={14} />
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}
