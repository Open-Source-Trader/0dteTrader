import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { IndicatorSettingsView } from './IndicatorSettingsView';
import { DEFAULT_INDICATOR_SETTINGS } from './indicatorSettings';

describe('IndicatorSettingsView options structure controls', () => {
  it('shows the approved layers and contains no obsolete analytics labels', () => {
    const markup = renderToStaticMarkup(
      createElement(IndicatorSettingsView, {
        settings: DEFAULT_INDICATOR_SETTINGS,
        onChange: vi.fn(),
        onDismiss: vi.fn(),
        twcEnabled: false,
        onToggleTwc: vi.fn(),
        onOpenTwcSettings: vi.fn(),
        optionsAnalytics: {
          enabled: true,
          showImpliedRange: true,
          showGammaProfile: true,
          showMarkedOi: false,
          showLiquidity: false,
          showDealerProxy: false,
          refreshSeconds: 45,
          profileStrikeCount: 12,
          showDiagnostics: false,
        },
        onChangeOptionsAnalytics: vi.fn(),
      }),
    );

    expect(markup).toContain('Options Structure');
    expect(markup).toContain('Implied 68% Range');
    expect(markup).toContain('Gamma Profile');
    expect(markup).toContain('Marked OI Value');
    expect(markup).toContain('Liquidity (Spread / Round Trip)');
    expect(markup).toContain('Dealer Gamma Flip Proxy');
    expect(markup).toContain('Profile Strikes: 12');
  });
});
