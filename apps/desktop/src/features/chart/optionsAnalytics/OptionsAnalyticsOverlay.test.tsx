import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeOptionsAnalyticsSnapshot } from './optionsAnalyticsTestFixture';
import { buildOptionsAnalyticsPresentation } from './optionsAnalyticsPresentation';
import { optionsAnalyticsHoverLines } from './optionsAnalyticsHover';

async function loadOverlayModule() {
  return import('./OptionsAnalyticsOverlay').catch(() => null);
}

describe('OptionsAnalyticsOverlay accessibility', () => {
  it('renders visible quality and an adjacent described summary without a live region', async () => {
    const module = await loadOverlayModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const markup = renderToStaticMarkup(
      createElement(module.OptionsAnalyticsOverlay, {
        chart: {} as never,
        series: {} as never,
        snapshot: makeOptionsAnalyticsSnapshot(),
        settings: {
          enabled: true,
          showImpliedRange: true,
          showGammaProfile: true,
          showMarkedOi: false,
          showLiquidity: false,
          showDealerProxy: false,
          refreshSeconds: 45,
          profileStrikeCount: 12,
          showDiagnostics: true,
        },
        candles: [],
        retained: true,
        nowMs: Date.parse('2026-07-19T14:30:20.000Z'),
      }),
    );

    expect(markup).toContain('Options structure');
    expect(markup).toContain('Root SPY · Settlement PM');
    expect(markup).toContain('Quote 14:30:08 UTC (age 12s)');
    expect(markup).toContain('Greeks 14:30:06 UTC (age 14s)');
    expect(markup).toContain('Two crossed quotes excluded');
    expect(markup).toContain(
      'Structure gamma C $900 · P $500 · gross $1K · delta notional C $2.0M · P -$1.5M',
    );
    expect(markup).toContain('retained last snapshot');
    expect(markup).toContain('aria-describedby="options-analytics-summary-');
    expect(markup).toContain('class="sr-only"');
    expect(markup).not.toContain('aria-live');
    expect(markup).not.toContain('dealer proxy');
  });

  it('keeps marked OI and liquidity visible without gamma and labels put/call directions', async () => {
    const module = await loadOverlayModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const markup = renderToStaticMarkup(
      createElement(module.OptionsAnalyticsOverlay, {
        chart: {} as never,
        series: {} as never,
        snapshot: makeOptionsAnalyticsSnapshot(),
        settings: {
          enabled: true,
          showImpliedRange: false,
          showGammaProfile: false,
          showMarkedOi: true,
          showLiquidity: true,
          showDealerProxy: false,
          refreshSeconds: 45,
          profileStrikeCount: 12,
          showDiagnostics: true,
        },
        candles: [],
        retained: false,
        nowMs: Date.parse('2026-07-19T14:30:20.000Z'),
      }),
    );

    expect(markup).toContain('aria-label="Put profile"');
    expect(markup).toContain('aria-label="Call profile"');
    expect(markup).toContain('Marked OI value: call and put composition');
    expect(markup).toContain(
      'Liquidity: bid/ask quote sizes, OI, volume, relative spread, and per-contract round trip',
    );
  });

  it('builds fact-first per-leg hover lines with dealer proxy kept separate', async () => {
    const module = await loadOverlayModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const model = buildOptionsAnalyticsPresentation(makeOptionsAnalyticsSnapshot(), {
      enabled: true,
      showImpliedRange: true,
      showGammaProfile: true,
      showMarkedOi: false,
      showLiquidity: false,
      showDealerProxy: true,
      refreshSeconds: 45,
      profileStrikeCount: 12,
      showDiagnostics: true,
    });

    const lines = optionsAnalyticsHoverLines(model.strikes[0]!);

    expect(lines).toContain('Call IV 21.0% · delta 0.700 · delta notional $3.5M');
    expect(lines).toContain('Put IV 22.0% · delta -0.300 · delta notional -$1.2M');
    expect(lines).toContain('Dealer proxy exposure $300');
  });

  it('renders only the warning cap in the HUD and keeps later warnings in the summary', async () => {
    const module = await loadOverlayModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const fixture = makeOptionsAnalyticsSnapshot();
    const warnings = Array.from({ length: 8 }, (_, index) => `Provider warning ${index + 1}`);
    const markup = renderToStaticMarkup(
      createElement(module.OptionsAnalyticsOverlay, {
        chart: {} as never,
        series: {} as never,
        snapshot: { ...fixture, quality: { ...fixture.quality, warnings } },
        settings: {
          enabled: true,
          showImpliedRange: true,
          showGammaProfile: true,
          showMarkedOi: false,
          showLiquidity: false,
          showDealerProxy: false,
          refreshSeconds: 45,
          profileStrikeCount: 12,
          showDiagnostics: true,
        },
        candles: [],
        retained: false,
      }),
    );

    expect(markup).toContain('<div>5 more warnings</div>');
    expect(markup).not.toContain('<div>Warning: Provider warning 4</div>');
    expect(markup).toContain('Warning: Provider warning 8');
  });
});
