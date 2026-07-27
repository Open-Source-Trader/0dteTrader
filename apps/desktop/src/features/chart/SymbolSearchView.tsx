import { useEffect, useMemo, useState } from 'react';
import { CheckmarkIcon, MagnifierIcon, TextCursorIcon } from '../../design/icons';
import { resolveEnterSelection, SYMBOL_SECTIONS } from './symbolSections';

interface SymbolSearchViewProps {
  currentSymbol: string;
  onSelect: (symbol: string) => void;
  onDismiss: () => void;
}

/**
 * Symbol switcher: curated watchlist plus arbitrary free-text symbols.
 *
 * The body of the ticker chip's dropdown, which is where this used to be a
 * sheet. Every capability the sheet had is still here — the search field, the
 * curated sections, the keyboard cursor, the "use this ticker anyway" row — and
 * it is the search field that sets the width, so this is the one anchored popup
 * that does not shrink to its widest row.
 */
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
      setActiveIndex((index) => Math.min(visibleRows.length - 1, Math.max(0, index + delta)));
      return;
    }
    if (event.key === 'Enter') {
      const selection = resolveEnterSelection(visibleRows, activeIndex, normalizedQuery);
      if (selection) select(selection);
    }
  };

  const activeStyle = (symbol: string) =>
    rowIndex.get(symbol) === activeIndex ? { background: 'rgba(46, 143, 255, 0.12)' } : undefined;

  return (
    <div className="symbol-dropdown">
      <div className="symbol-dropdown-search">
        <MagnifierIcon size={14} style={{ color: 'var(--label-secondary)' }} />
        <input
          placeholder="Search"
          aria-label="Search symbols"
          autoComplete="off"
          spellCheck={false}
          style={{ flex: 1, textTransform: 'uppercase', minWidth: 0 }}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
        />
      </div>

      <div className="symbol-dropdown-list">
        {showsCustomSymbol ? (
          <button
            className="menu-item"
            style={{ color: 'var(--app-accent)', ...activeStyle(normalizedQuery) }}
            onClick={() => select(normalizedQuery)}
          >
            <span className="menu-item-label">
              <TextCursorIcon size={13} />
              Use &quot;{normalizedQuery}&quot;
            </span>
          </button>
        ) : null}

        {SYMBOL_SECTIONS.map((section) => {
          const symbols = filtered(section.symbols);
          if (symbols.length === 0) return null;
          return (
            <div key={section.title}>
              <div className="symbol-dropdown-header">{section.title}</div>
              {symbols.map((symbol) => (
                <button
                  className="menu-item"
                  key={symbol}
                  style={activeStyle(symbol)}
                  aria-current={symbol === currentSymbol ? 'true' : undefined}
                  onClick={() => select(symbol)}
                >
                  <span className="menu-item-label">{symbol}</span>
                  {symbol === currentSymbol ? (
                    <span className="menu-item-check" aria-hidden="true">
                      <CheckmarkIcon size={13} />
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
