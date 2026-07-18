import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { CheckmarkIcon } from '../icons';

export interface MenuItem {
  key: string;
  label: ReactNode;
  checked?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  trigger: ReactNode;
  items: MenuItem[];
  /** Open the dropdown above the trigger (for menus near the bottom). */
  direction?: 'down' | 'up';
  className?: string;
}

/** iOS Menu analog: anchored dropdown with checkmark rows. */
export function Menu({ trigger, items, direction = 'down', className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    wrapRef.current?.querySelector<HTMLElement>('.menu-item')?.focus();
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** ArrowUp/ArrowDown move focus between items, wrapping at the ends. */
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const menuItems = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('.menu-item'));
    if (menuItems.length === 0) return;
    const index = menuItems.indexOf(document.activeElement as HTMLElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next =
      index === -1
        ? menuItems[delta === 1 ? 0 : menuItems.length - 1]
        : menuItems[(index + delta + menuItems.length) % menuItems.length];
    next.focus();
  };

  return (
    <div ref={wrapRef} className={`menu-wrap${className ? ` ${className}` : ''}`}>
      <div style={{ display: 'flex', flex: 1, minWidth: 0 }} onClick={() => setOpen((v) => !v)}>
        {trigger}
      </div>
      {open ? (
        <div
          className={`menu-dropdown${direction === 'up' ? ' up' : ''}`}
          role="menu"
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.key}
              className="menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {item.label}
              </span>
              {item.checked ? <CheckmarkIcon size={13} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
