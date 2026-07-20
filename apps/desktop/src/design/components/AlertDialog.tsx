import { useEffect, useRef } from 'react';

export interface AlertAction {
  label: string;
  role?: 'destructive' | 'cancel';
  onSelect?: () => void;
}

interface AlertDialogProps {
  title: string;
  message?: string;
  actions: AlertAction[];
  onDismiss: () => void;
}

/**
 * Centered iOS-style alert (270px card, hairline-separated buttons). Modal:
 * Escape dismisses, focus starts on the first action, Tab is trapped inside,
 * and focus is restored on close.
 */
export function AlertDialog({ title, message, actions, onDismiss }: AlertDialogProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  // See Sheet: parents hand us inline closures, so keep the latest callback in
  // a ref and let the focus/effect logic below run once on mount instead of
  // re-focusing the first button on every parent re-render.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    const backdrop = backdropRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    backdrop?.querySelector<HTMLElement>('.alert-button')?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDismissRef.current();
        return;
      }
      if (event.key !== 'Tab' || !backdrop) return;
      const items = Array.from(backdrop.querySelectorAll<HTMLElement>('.alert-button'));
      if (items.length === 0) return;
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
      ref={backdropRef}
      className="alert-backdrop"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="alert-card">
        <div className="alert-title">{title}</div>
        {message ? <div className="alert-message">{message}</div> : null}
        {actions.map((action) => (
          <button
            key={action.label}
            className={`alert-button ${action.role ?? ''}`}
            onClick={() => {
              onDismiss();
              action.onSelect?.();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
