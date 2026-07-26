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

/**
 * Which side of the frame the popup lines up with — its trigger's own side, so
 * the popup reads as having come out of the chip rather than having appeared
 * somewhere. `'trigger'` keeps the old behaviour of starting at the trigger's
 * left edge, for popups whose chip is not near either border.
 */
export type PopupEdge = 'leading' | 'trailing' | 'trigger';

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
}

const MENU_GAP = 6;
const MENU_MAX_HEIGHT = 320;
/** The inset the chart's chip row already keeps off the pane's borders. */
const FRAME_INSET = 8;

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
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    visible: boolean;
    up: boolean;
  }>({ top: 0, left: 0, visible: false, up: false });

  // Position the portalled popup after layout, flipping to stay in-frame.
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
    let up = false;
    if (direction === 'up') {
      top = tTop - MENU_GAP - h;
      up = true;
      if (top < 0) {
        top = tBottom + MENU_GAP;
        up = false;
      }
    } else {
      top = tBottom + MENU_GAP;
      if (top + h > frameH) {
        top = tTop - MENU_GAP - h;
        up = true;
      }
    }
    top = Math.max(0, Math.min(top, frameH - h));

    // Horizontal: against the named frame edge, or the trigger's own left.
    let left: number;
    if (edge === 'leading') left = FRAME_INSET;
    else if (edge === 'trailing') left = frameW - w - FRAME_INSET;
    else {
      left = tLeft;
      if (left + w > frameW) left = tRight - w;
    }
    left = Math.max(0, Math.min(left, Math.max(0, frameW - w)));

    setPos({ top, left, visible: true, up });
  }, [direction, edge]);

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
