import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckmarkIcon, MagnifierIcon, TextCursorIcon } from '../../design/icons';
import { SYMBOL_SECTIONS } from './symbolSections';

interface SymbolSpotlightProps {
  currentSymbol: string;
  onSelect: (symbol: string) => void;
  onDismiss: () => void;
}

/** Desktop Cmd+K command palette: centered, instant, keyboard-first symbol
 *  jump — the desktop-grid analog of SymbolSearchView's phone bottom sheet.
 *  Same query/filter/keyboard-nav behavior, no slide-up sheet chrome. */
export function SymbolSpotlight({ currentSymbol, onSelect, onDismiss }: SymbolSpotlightProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.toUpperCase().trim();

  const filtered = (symbols: string[]) =>
    normalizedQuery ? symbols.filter((symbol) => symbol.includes(normalizedQuery)) : symbols;

  const showsCustomSymbol = useMemo(() => {
    if (!normalizedQuery) return false;
    return !SYMBOL_SECTIONS.some((section) => section.symbols.includes(normalizedQuery));
  }, [normalizedQuery]);

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

  useEffect(() => setActiveIndex(0), [normalizedQuery]);

  useEffect(() => {
    inputRef.current?.focus();
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => previouslyFocused?.focus();
  }, []);

  const select = (symbol: string) => {
    onSelect(symbol);
    onDismiss();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      onDismiss();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (visibleRows.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => Math.min(visibleRows.length - 1, Math.max(0, index + delta)));
      return;
    }
    if (event.key === 'Enter' && normalizedQuery) {
      select(visibleRows[activeIndex] ?? normalizedQuery);
    }
  };

  const activeStyle = (symbol: string) =>
    rowIndex.get(symbol) === activeIndex ? { background: 'rgba(46, 143, 255, 0.12)' } : undefined;

  return (
    <div
      ref={backdropRef}
      className="spotlight-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Jump to symbol"
      onMouseDown={(event) => {
        if (event.target === backdropRef.current) onDismiss();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="spotlight-card">
        <div className="spotlight-input-row">
          <MagnifierIcon size={15} style={{ color: 'var(--label-secondary)' }} />
          <input
            ref={inputRef}
            placeholder="Jump to symbol…"
            aria-label="Search symbols"
            autoComplete="off"
            spellCheck={false}
            className="spotlight-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="spotlight-hint">esc</span>
        </div>

        <div className="spotlight-results hide-scrollbar">
          {showsCustomSymbol ? (
            <button
              className="spotlight-row"
              style={activeStyle(normalizedQuery)}
              onClick={() => select(normalizedQuery)}
            >
              <TextCursorIcon size={14} style={{ color: 'var(--app-accent)' }} />
              <span>Use &quot;{normalizedQuery}&quot;</span>
            </button>
          ) : null}

          {SYMBOL_SECTIONS.map((section) => {
            const symbols = filtered(section.symbols);
            if (symbols.length === 0) return null;
            return (
              <div key={section.title}>
                <div className="spotlight-section-header">{section.title}</div>
                {symbols.map((symbol) => (
                  <button
                    className="spotlight-row"
                    key={symbol}
                    style={activeStyle(symbol)}
                    aria-current={symbol === currentSymbol ? 'true' : undefined}
                    onClick={() => select(symbol)}
                  >
                    <span>{symbol}</span>
                    {symbol === currentSymbol ? (
                      <CheckmarkIcon size={14} style={{ color: 'var(--app-accent)' }} />
                    ) : null}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
