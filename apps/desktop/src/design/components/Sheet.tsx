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

  useEffect(() => {
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDismiss();
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
  }, [onDismiss]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onDismiss} />
      <div ref={panelRef} className={`sheet-panel ${detent}`} role="dialog" aria-modal="true" tabIndex={-1}>
        {children}
      </div>
    </>
  );
}
