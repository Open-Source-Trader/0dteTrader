import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../../core/api/ApiClient';

async function loadHookModule() {
  return import('./useOptionsAnalytics').catch(() => null);
}

const settings = {
  enabled: true,
  showImpliedRange: true,
  showGammaProfile: true,
  showMarkedOi: false,
  showLiquidity: false,
  showDealerProxy: false,
  refreshSeconds: 45,
  profileStrikeCount: 12,
};

async function runClientEffect(expiration: string | null, enabled: boolean) {
  vi.resetModules();
  vi.doMock('react', () => ({
    useState: <T,>(initial: T) => [initial, vi.fn()],
    useEffect: (effect: () => void | (() => void)) => effect(),
  }));
  const optionsAnalytics = vi.fn().mockReturnValue(new Promise(() => undefined));
  const module = await loadHookModule();
  expect(module).not.toBeNull();
  if (module) {
    module.useOptionsAnalytics({ optionsAnalytics } as unknown as ApiClient, 'SPY', expiration, {
      ...settings,
      enabled,
    });
  }
  return optionsAnalytics;
}

describe('useOptionsAnalytics', () => {
  it('starts from an empty non-loading state before the client effect runs', async () => {
    const module = await loadHookModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const Harness: FunctionComponent = () => {
      const state = module.useOptionsAnalytics({} as ApiClient, 'SPY', '2026-07-19', settings);
      return createElement(
        'span',
        null,
        `${state.snapshot === null}:${state.isLoading}:${state.retained}:${state.errorMessage === null}`,
      );
    };

    expect(renderToStaticMarkup(createElement(Harness))).toBe('<span>true:false:false:true</span>');
  });

  it('does not poll until an expiration is selected', async () => {
    try {
      const optionsAnalytics = await runClientEffect(null, true);
      expect(optionsAnalytics).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('react');
      vi.resetModules();
    }
  });

  it('shadow-fetches the exact selected key while the overlay is disabled', async () => {
    try {
      const optionsAnalytics = await runClientEffect('2026-07-19', false);

      expect(optionsAnalytics).toHaveBeenCalledTimes(1);
      expect(optionsAnalytics).toHaveBeenCalledWith('SPY', '2026-07-19', expect.any(AbortSignal));
    } finally {
      vi.doUnmock('react');
      vi.resetModules();
    }
  });
});
