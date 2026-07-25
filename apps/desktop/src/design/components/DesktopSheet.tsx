import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface DesktopSheetProps {
  onDismiss: () => void;
  children: ReactNode;
}

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Desktop-grid equivalent of Sheet: same modal behavior (focus trap, Escape
 * to dismiss, Tab cycling, focus restore on close) but rendered as a
 * centered floating panel instead of an iOS bottom sheet sliding up full
 * height — settings/indicators/history read as app windows on a desktop,
 * not phone screens. Compact/phone layout keeps using Sheet unchanged.
 */
export function DesktopSheet({ onDismiss, children }: DesktopSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
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
    <div
      className="desktop-sheet-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismissRef.current();
      }}
    >
      <div
        ref={panelRef}
        className="desktop-sheet-panel"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
