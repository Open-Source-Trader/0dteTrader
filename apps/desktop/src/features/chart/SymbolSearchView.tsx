import { useEffect, useMemo, useState } from 'react';
import { NavBar } from '../../design/components/NavBar';
import { Sheet } from '../../design/components/Sheet';
import { CheckmarkIcon, MagnifierIcon, TextCursorIcon } from '../../design/icons';
import { SYMBOL_SECTIONS } from './symbolSections';

interface SymbolSearchViewProps {
  currentSymbol: string;
  onSelect: (symbol: string) => void;
  onDismiss: () => void;
}

/** Symbol switcher: curated watchlist plus arbitrary free-text symbols. */
export function SymbolSearchView({ currentSymbol, onSelect, onDismiss }: SymbolSearchViewProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const normalizedQuery = query.toUpperCase().trim();

  const filtered = (symbols: string[]) =>
    normalizedQuery ? symbols.filter((symbol) => symbol.includes(normalizedQuery)) : symbols;

  const showsCustomSymbol = useMemo(() => {
    if (!normalizedQuery) return false;
    return !SYMBOL_SECTIONS.some((section) => section.symbols.includes(normalizedQuery));
  }, [normalizedQuery]);

  // Flat list of visible rows for keyboard navigation (custom row first).
  const visibleRows = useMemo(
    () => [
      ...(showsCustomSymbol ? [normalizedQuery] : []),
      ...SYMBOL_SECTIONS.flatMap((section) => filtered(section.symbols)),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [normalizedQuery, showsCustomSymbol],
  );
  const rowIndex = useMemo(
    () => new Map(visibleRows.map((symbol, index) => [symbol, index])),
    [visibleRows],
  );

  // Reset the keyboard cursor whenever the query changes the list.
  useEffect(() => setActiveIndex(0), [normalizedQuery]);

  const select = (symbol: string) => {
    onSelect(symbol);
    onDismiss();
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (visibleRows.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) =>
        Math.min(visibleRows.length - 1, Math.max(0, index + delta)),
      );
      return;
    }
    // Enter commits the highlighted match (or the top one), not raw text.
    if (event.key === 'Enter' && normalizedQuery) {
      select(visibleRows[activeIndex] ?? normalizedQuery);
    }
  };

  const activeStyle = (symbol: string) =>
    rowIndex.get(symbol) === activeIndex
      ? { background: 'rgba(46, 143, 255, 0.12)' }
      : undefined;

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
              gap: 8,
              height: 36,
              padding: '0 12px',
              background: 'var(--app-surface-elevated)',
              borderRadius: 'var(--radius-input)',
            }}
          >
            <MagnifierIcon size={14} style={{ color: 'var(--label-secondary)' }} />
            <input
              placeholder="Symbol"
              aria-label="Search symbols"
              autoComplete="off"
              autoFocus
              spellCheck={false}
              style={{ flex: 1, textTransform: 'uppercase' }}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </div>
        </div>

        <div className="sheet-body grouped-list hide-scrollbar">
          {showsCustomSymbol ? (
            <div className="grouped-section">
              <div className="section-card">
                <button
                  className="grouped-row"
                  style={activeStyle(normalizedQuery)}
                  onClick={() => select(normalizedQuery)}
                >
                  <TextCursorIcon size={15} style={{ color: 'var(--app-accent)' }} />
                  <span>Use &quot;{normalizedQuery}&quot;</span>
                </button>
              </div>
            </div>
          ) : null}

          {SYMBOL_SECTIONS.map((section) => {
            const symbols = filtered(section.symbols);
            if (symbols.length === 0) return null;
            return (
              <div className="grouped-section" key={section.title}>
                <div className="section-header">{section.title}</div>
                <div className="section-card">
                  {symbols.map((symbol) => (
                    <button
                      className="grouped-row"
                      key={symbol}
                      style={activeStyle(symbol)}
                      aria-current={symbol === currentSymbol ? 'true' : undefined}
                      onClick={() => select(symbol)}
                    >
                      <span>{symbol}</span>
                      {symbol === currentSymbol ? (
                        <span
                          className="row-value"
                          aria-hidden="true"
                          style={{ color: 'var(--app-accent)', display: 'flex', alignItems: 'center' }}
                        >
                          <CheckmarkIcon size={17} />
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
