import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  /** Preferred open direction; the menu auto-flips to stay inside the frame. */
  direction?: 'down' | 'up';
  className?: string;
}

const MENU_GAP = 6;
const MENU_MAX_HEIGHT = 320;

/**
 * Resolve the fixed phone frame's unscaled local coordinate space so a
 * portalled dropdown can be positioned with plain absolute coordinates.
 * Everything renders inside `#root`, which is uniformly `transform:
 * scale(--app-scale)`; dividing viewport rects by that scale yields the
 * 430x932 logical layout the dropdown is positioned within.
 */
function getFrameMetrics() {
  if (typeof document === 'undefined') return { content: null, scale: 1, width: 430, height: 932 };
  const content = document.querySelector<HTMLElement>('.phone-content');
  const scale =
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-scale')) || 1;
  if (!content) return { content: null, scale, width: 430, height: 932 };
  const rect = content.getBoundingClientRect();
  return { content, scale, width: rect.width / scale, height: rect.height / scale };
}

/** iOS Menu analog: anchored dropdown with checkmark rows. The dropdown is
 *  portalled into `.phone-content` so it can never be clipped by an ancestor
 *  `overflow: hidden` (the trade panel, the phone frame), and it auto-flips
 *  vertically/horizontally to stay inside the frame. */
export function Menu({ trigger, items, direction = 'down', className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; visible: boolean }>({
    top: 0,
    left: 0,
    visible: false,
  });

  // Position the portalled dropdown after layout, flipping to stay in-frame.
  const reposition = useCallback(() => {
    const wrap = wrapRef.current;
    const menu = menuRef.current;
    const { content, scale, width: frameW, height: frameH } = getFrameMetrics();
    if (!wrap || !menu || !content) {
      setPos((p) => ({ ...p, visible: true }));
      return;
    }
    const wrapRect = wrap.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const w = menuRect.width / scale;
    const h = Math.min(menuRect.height / scale, MENU_MAX_HEIGHT);

    // Trigger position in unscaled frame-local coordinates.
    const contentRect = content.getBoundingClientRect();
    const tLeft = (wrapRect.left - contentRect.left) / scale;
    const tTop = (wrapRect.top - contentRect.top) / scale;
    const tRight = (wrapRect.right - contentRect.left) / scale;
    const tBottom = (wrapRect.bottom - contentRect.top) / scale;

    // Vertical: honor the preferred direction, flip if it would overflow.
    let top: number;
    if (direction === 'up') {
      top = tTop - MENU_GAP - h;
      if (top < 0) top = tBottom + MENU_GAP;
    } else {
      top = tBottom + MENU_GAP;
      if (top + h > frameH) top = tTop - MENU_GAP - h;
    }
    top = Math.max(0, Math.min(top, frameH - h));

    // Horizontal: keep inside the frame, right-align near the right edge.
    let left = tLeft;
    if (left + w > frameW) left = tRight - w;
    left = Math.max(0, Math.min(left, frameW - w));

    setPos({ top, left, visible: true });
  }, [direction]);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // The dropdown lives in a portal, so ignore clicks there too.
      if (wrapRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    menuRef.current?.querySelector<HTMLElement>('.menu-item')?.focus();
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

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
              className="menu-dropdown"
              role="menu"
              onKeyDown={onMenuKeyDown}
              style={{
                position: 'absolute',
                top: pos.top,
                left: pos.left,
                visibility: pos.visible ? 'visible' : 'hidden',
                maxWidth: '100%',
              }}
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
            </div>,
            target,
          )
        : null}
    </div>
  );
}
