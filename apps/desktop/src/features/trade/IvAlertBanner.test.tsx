// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IVAlert } from '@0dtetrader/shared-types';
import { IvAlertBanner } from './IvAlertBanner';

const alert: IVAlert = {
  symbol: 'SPX',
  direction: 'expansion',
  currentIv: 0.241,
  baselineIv: 0.213,
  zScore: 3.2,
  timestamp: '2026-08-05T14:31:00.000Z',
};

describe('IvAlertBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('is nonblocking, accessible, complete, and dismissible', () => {
    const dismiss = vi.fn();
    act(() => root.render(<IvAlertBanner alert={alert} onDismiss={dismiss} />));
    const banner = container.querySelector('[role="status"]');
    expect(banner).not.toBeNull();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(banner?.textContent).toContain('SPX');
    expect(banner?.textContent).toContain('IV expansion');
    expect(banner?.textContent).toContain('24.10%');
    expect(banner?.textContent).toContain('21.30%');
    expect(banner?.textContent).toContain('10:31 AM');
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss SPX IV alert"]',
    );
    expect(button).not.toBeNull();
    act(() => button?.click());
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
