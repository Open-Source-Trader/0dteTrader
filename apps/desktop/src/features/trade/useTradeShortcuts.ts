import { useEffect } from 'react';
import type { OrderSide } from '@0dtetrader/shared-types';

interface UseTradeShortcutsOptions {
  /** Whether the hotkey layer is active at all (desktop grid only — the
   *  compact/phone-derived layout has its own touch controls). */
  enabled: boolean;
  /** Whether an order can currently be armed (contract selected, not locked). */
  canTrade: boolean;
  onArm: (side: OrderSide) => void;
  onToggleLock: () => void;
  onOpenSymbolSearch: () => void;
}

/** Minimal shape of a keydown event this module cares about — kept separate
 *  from the DOM's KeyboardEvent so the decision logic is testable without a
 *  DOM (this project has no jsdom dependency; see other *.test.ts files). */
export interface TradeShortcutKeyInfo {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isTypingTarget: boolean;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Pure decision logic for a single keydown: which action (if any) fires,
 *  and whether the browser default should be prevented. Trading-desk
 *  hotkeys: B/S arm an order, Cmd/Ctrl+K jumps to symbol search, L toggles
 *  the trading lock. No-ops while a text input has focus. */
export function resolveTradeShortcut(
  info: TradeShortcutKeyInfo,
  canTrade: boolean,
): {
  action: 'arm-buy' | 'arm-sell' | 'toggle-lock' | 'open-symbol-search';
  preventDefault: boolean;
} | null {
  if (info.isTypingTarget) return null;

  if (info.metaKey || info.ctrlKey) {
    if (info.key.toLowerCase() === 'k') {
      return { action: 'open-symbol-search', preventDefault: true };
    }
    return null;
  }
  if (info.altKey || info.shiftKey) return null;

  switch (info.key.toLowerCase()) {
    case 'b':
      return canTrade ? { action: 'arm-buy', preventDefault: false } : null;
    case 's':
      return canTrade ? { action: 'arm-sell', preventDefault: false } : null;
    case 'l':
      return { action: 'toggle-lock', preventDefault: false };
    default:
      return null;
  }
}

/** Trading-desk hotkeys for the desktop grid: B/S arm an order, Cmd/Ctrl+K
 *  jumps to symbol search, L toggles the trading lock. Disabled while any
 *  text input has focus so normal typing is never hijacked. */
export function useTradeShortcuts({
  enabled,
  canTrade,
  onArm,
  onToggleLock,
  onOpenSymbolSearch,
}: UseTradeShortcutsOptions): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const resolved = resolveTradeShortcut(
        {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isTypingTarget: isTypingTarget(event.target),
        },
        canTrade,
      );
      if (!resolved) return;
      if (resolved.preventDefault) event.preventDefault();

      switch (resolved.action) {
        case 'arm-buy':
          onArm('buy');
          break;
        case 'arm-sell':
          onArm('sell');
          break;
        case 'toggle-lock':
          onToggleLock();
          break;
        case 'open-symbol-search':
          onOpenSymbolSearch();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, canTrade, onArm, onToggleLock, onOpenSymbolSearch]);
}
