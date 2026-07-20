import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface SheetProps {
  detent?: 'large' | 'medium';
  onDismiss: () => void;
  children: ReactNode;
}

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

/**
 * iOS sheet emulation inside the phone frame: dimmed backdrop + panel sliding
 * up. `large` is a page sheet (10px top gap); `medium` covers ~half. Backdrop
 * click or Escape dismisses (the swipe-down analog). Renders as a modal
 * dialog: focus moves into the panel on open, Tab is trapped inside, and
 * focus returns to the previously focused element on close.
 */
export function Sheet({ detent = 'large', onDismiss, children }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Parents pass inline closures whose identity changes on every re-render
  // (e.g. TradeScreen re-renders on each quote tick). Track the latest
  // callback in a ref so the mount effect below runs exactly once — re-running
  // it would steal focus back to the first field while the user is typing.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDismissRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute('disabled'),
      );
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        lastItem.focus();
        event.preventDefault();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        firstItem.focus();
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <>
      <div className="sheet-backdrop" onClick={() => onDismissRef.current()} />
      <div
        ref={panelRef}
        className={`sheet-panel ${detent}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        {children}
      </div>
    </>
  );
}
