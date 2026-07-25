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

  // Exactly one row can be "active" (keyboard-highlighted): the row whose
  // position in the flat visibleRows list matches activeIndex. Comparing
  // symbol identity directly (not via a second index lookup) removes any
  // chance of two rows matching at once.
  const activeSymbol = visibleRows[activeIndex];
  const rowClassName = (symbol: string) =>
    symbol === activeSymbol ? 'spotlight-row active' : 'spotlight-row';

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
          <MagnifierIcon size={20} style={{ color: 'var(--label-secondary)' }} />
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
        </div>

        <div className="spotlight-results hide-scrollbar">
          {showsCustomSymbol ? (
            <div>
              <div className="spotlight-section-header">Jump to symbol</div>
              <button
                className={rowClassName(normalizedQuery)}
                onClick={() => select(normalizedQuery)}
              >
                <span className="spotlight-row-icon">
                  <TextCursorIcon size={14} />
                </span>
                <span className="spotlight-row-label numeric">{normalizedQuery}</span>
                <span className="spotlight-row-hint">not in watchlist — press ↵</span>
              </button>
            </div>
          ) : null}

          {SYMBOL_SECTIONS.map((section) => {
            const symbols = filtered(section.symbols);
            if (symbols.length === 0) return null;
            return (
              <div key={section.title}>
                <div className="spotlight-section-header">{section.title}</div>
                {symbols.map((symbol) => {
                  const isCurrent = symbol === currentSymbol;
                  return (
                    <button
                      className={rowClassName(symbol)}
                      key={symbol}
                      aria-current={isCurrent ? 'true' : undefined}
                      onClick={() => select(symbol)}
                    >
                      <span className="spotlight-row-label numeric">{symbol}</span>
                      {isCurrent ? (
                        <CheckmarkIcon size={14} style={{ color: 'var(--app-accent)' }} />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="spotlight-footer">
          <span className="spotlight-footer-hint">
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span className="spotlight-footer-hint">
            <kbd>↵</kbd> select
          </span>
          <span className="spotlight-footer-hint">
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
