import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { CheckmarkIcon } from '../icons';
import { useAnchoredPanelPosition } from './anchoredPanel';
import type { PopupEdge } from './anchoredPanel';

export type { PopupEdge };

export interface MenuItem {
  key: string;
  label: ReactNode;
  checked?: boolean;
  onSelect: () => void;
}

interface AnchoredPopupProps {
  trigger: ReactNode;
  /** Preferred open direction; the popup auto-flips to stay inside the frame. */
  direction?: 'down' | 'up';
  edge?: PopupEdge;
  className?: string;
  /** Extra class on the portalled panel. */
  panelClassName?: string;
  role?: string;
  /** Panel contents. Handed the closer, so a row can select and close at once. */
  children: (close: () => void) => ReactNode;
  onOpen?: () => void;
}

interface MenuProps {
  trigger: ReactNode;
  items: MenuItem[];
  direction?: 'down' | 'up';
  edge?: PopupEdge;
  className?: string;
  panelClassName?: string;
}

/**
 * A popup anchored under (or over) its trigger, portalled into `.phone-content`
 * so it can never be clipped by an ancestor `overflow: hidden` — the trade
 * panel and the phone frame both clip — and edge-aligned to the side of the
 * frame its trigger lives on.
 *
 * `Menu` is the checkmark-row case built on this; the symbol picker is the
 * other one, and it brings its own body because it has a search field.
 */
export function AnchoredPopup({
  trigger,
  direction = 'down',
  edge = 'trigger',
  className,
  panelClassName,
  role,
  children,
  onOpen,
}: AnchoredPopupProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { pos, reposition } = useAnchoredPanelPosition(wrapRef, menuRef, direction, edge);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // The popup lives in a portal, so ignore clicks there too.
      if (wrapRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    // Keyboard users land inside the popup, not behind it: the first row for a
    // menu, the search field for the symbol picker.
    menuRef.current?.querySelector<HTMLElement>('input, .menu-item, button')?.focus();
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (open) onOpen?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const target = typeof document !== 'undefined' ? document.querySelector('.phone-content') : null;

  return (
    <div ref={wrapRef} className={`menu-wrap${className ? ` ${className}` : ''}`}>
      <div style={{ display: 'flex', flex: 1, minWidth: 0 }} onClick={() => setOpen((v) => !v)}>
        {trigger}
      </div>
      {open && target
        ? createPortal(
            <div
              ref={menuRef}
              className={`menu-dropdown${pos.up ? ' up' : ''}${
                panelClassName ? ` ${panelClassName}` : ''
              }`}
              role={role}
              style={{
                position: 'absolute',
                top: pos.top,
                left: pos.left,
                visibility: pos.visible ? 'visible' : 'hidden',
                maxWidth: '100%',
              }}
            >
              {children(() => setOpen(false))}
            </div>,
            target,
          )
        : null}
    </div>
  );
}

/** iOS `HudMenu` analog: an anchored dropdown of centred, checkmarked rows. */
export function Menu({
  trigger,
  items,
  direction = 'down',
  edge = 'trigger',
  className,
  panelClassName,
}: MenuProps) {
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
    <AnchoredPopup
      trigger={trigger}
      direction={direction}
      edge={edge}
      className={className}
      panelClassName={panelClassName}
      role="menu"
    >
      {(close) => (
        <div onKeyDown={onMenuKeyDown} style={{ display: 'contents' }}>
          {items.map((item) => (
            <button
              key={item.key}
              className="menu-item"
              role="menuitem"
              onClick={() => {
                close();
                item.onSelect();
              }}
            >
              <span className="menu-item-label">{item.label}</span>
              {item.checked ? (
                <span className="menu-item-check" aria-hidden="true">
                  <CheckmarkIcon size={13} />
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </AnchoredPopup>
  );
}
