import { useCallback, useState } from 'react';

/**
 * Which side of the frame the popup lines up with — its trigger's own side, so
 * the popup reads as having come out of the chip rather than having appeared
 * somewhere. `'trigger'` keeps the old behaviour of starting at the trigger's
 * left edge, for popups whose chip is not near either border.
 */
export type PopupEdge = 'leading' | 'trailing' | 'trigger';

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

export interface AnchoredPanelPosition {
  top: number;
  left: number;
  visible: boolean;
  up: boolean;
}

/**
 * Places a portalled panel against an anchor element, flipping to stay inside
 * the phone frame. Used by `AnchoredPopup` — every chip dropdown on the
 * screen.
 *
 * Returns the position and the function that recomputes it; the caller drives
 * it, because only the caller knows when its panel exists.
 */
export function useAnchoredPanelPosition(
  anchorRef: { current: HTMLElement | null },
  panelRef: { current: HTMLElement | null },
  direction: 'down' | 'up',
  edge: PopupEdge,
  maxHeight = MENU_MAX_HEIGHT,
) {
  const [pos, setPos] = useState<AnchoredPanelPosition>({
    top: 0,
    left: 0,
    visible: false,
    up: false,
  });

  // Position the portalled panel after layout, flipping to stay in-frame.
  const reposition = useCallback(() => {
    const wrap = anchorRef.current;
    const menu = panelRef.current;
    const { content, scale, width: frameW, height: frameH } = getFrameMetrics();
    if (!wrap || !menu || !content) {
      setPos((p) => ({ ...p, visible: true }));
      return;
    }
    const wrapRect = wrap.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const w = menuRect.width / scale;
    const h = Math.min(menuRect.height / scale, maxHeight);

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
  }, [anchorRef, panelRef, direction, edge, maxHeight]);

  return { pos, reposition };
}
