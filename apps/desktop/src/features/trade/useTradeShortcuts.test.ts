import { describe, expect, it } from 'vitest';
import { resolveTradeShortcut } from './useTradeShortcuts';
import type { TradeShortcutKeyInfo } from './useTradeShortcuts';

const baseKey: TradeShortcutKeyInfo = {
  key: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isTypingTarget: false,
};

describe('resolveTradeShortcut', () => {
  it('arms a buy on B when trading is enabled', () => {
    expect(resolveTradeShortcut({ ...baseKey, key: 'b' }, true, true)).toEqual({
      action: 'arm-buy',
      preventDefault: false,
    });
  });

  it('arms a sell on S when trading is enabled', () => {
    expect(resolveTradeShortcut({ ...baseKey, key: 's' }, true, true)).toEqual({
      action: 'arm-sell',
      preventDefault: false,
    });
  });

  it('does not arm an order when canTrade is false', () => {
    expect(resolveTradeShortcut({ ...baseKey, key: 'b' }, false, true)).toBeNull();
    expect(resolveTradeShortcut({ ...baseKey, key: 's' }, false, true)).toBeNull();
  });

  it('toggles the trading lock on L regardless of canTrade', () => {
    expect(resolveTradeShortcut({ ...baseKey, key: 'l' }, false, true)).toEqual({
      action: 'toggle-lock',
      preventDefault: false,
    });
  });

  it('opens symbol search on Cmd/Ctrl+K and prevents the default', () => {
    expect(resolveTradeShortcut({ ...baseKey, key: 'k', metaKey: true }, true, true)).toEqual({
      action: 'open-symbol-search',
      preventDefault: true,
    });
    expect(resolveTradeShortcut({ ...baseKey, key: 'k', ctrlKey: true }, true, true)).toEqual({
      action: 'open-symbol-search',
      preventDefault: true,
    });
  });

  it('opens symbol search on Cmd+K even when trading shortcuts are disabled', () => {
    expect(resolveTradeShortcut({ ...baseKey, key: 'k', metaKey: true }, true, false)).toEqual({
      action: 'open-symbol-search',
      preventDefault: true,
    });
  });

  it('does not arm or toggle the lock when trading shortcuts are disabled', () => {
    expect(resolveTradeShortcut({ ...baseKey, key: 'b' }, true, false)).toBeNull();
    expect(resolveTradeShortcut({ ...baseKey, key: 's' }, true, false)).toBeNull();
    expect(resolveTradeShortcut({ ...baseKey, key: 'l' }, true, false)).toBeNull();
  });

  it('ignores hotkeys while a text input has focus', () => {
    expect(
      resolveTradeShortcut({ ...baseKey, key: 'b', isTypingTarget: true }, true, true),
    ).toBeNull();
    expect(
      resolveTradeShortcut({ ...baseKey, key: 'l', isTypingTarget: true }, true, true),
    ).toBeNull();
  });

  it('ignores letter keys combined with a modifier other than Cmd/Ctrl', () => {
    expect(resolveTradeShortcut({ ...baseKey, key: 'b', shiftKey: true }, true, true)).toBeNull();
    expect(resolveTradeShortcut({ ...baseKey, key: 'b', altKey: true }, true, true)).toBeNull();
  });

  it('ignores unmapped keys', () => {
    expect(resolveTradeShortcut({ ...baseKey, key: 'x' }, true, true)).toBeNull();
  });
});
