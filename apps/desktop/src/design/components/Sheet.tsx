import { useEffect } from 'react';
import type { ReactNode } from 'react';

interface SheetProps {
  detent?: 'large' | 'medium';
  onDismiss: () => void;
  children: ReactNode;
}

/**
 * iOS sheet emulation inside the phone frame: dimmed backdrop + panel sliding
 * up. `large` is a page sheet (10px top gap); `medium` covers ~half. Backdrop
 * click or Escape dismisses (the swipe-down analog).
 */
export function Sheet({ detent = 'large', onDismiss, children }: SheetProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onDismiss} />
      <div className={`sheet-panel ${detent}`}>{children}</div>
    </>
  );
}
