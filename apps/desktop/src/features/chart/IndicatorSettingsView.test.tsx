import { DEFAULT_CHART_TRADING_SETTINGS } from './chartTradingSettings';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Stepper } from '../../design/components/Stepper';
import { IndicatorSettingsBody, IndicatorSettingsView } from './IndicatorSettingsView';
import { DEFAULT_CHART_DISPLAY, DEFAULT_INDICATOR_SETTINGS_STATE } from './indicatorRegistry';
import { DEFAULT_OPTIONS_ANALYTICS_SETTINGS } from './optionsAnalytics/optionsAnalyticsSettings';
import { DEFAULT_TWC_SETTINGS } from './twc/twcSettings';

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (!isValidElement<{ children?: ReactNode }>(node)) return '';
  return textContent(node.props.children);
}

function findButton(node: ReactNode, label: string): ReactElement<{ onClick?: () => void }> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findButton(child, label);
      if (match) return match;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return null;
  if (node.type === 'button' && textContent(node.props.children) === label) return node;
  return findButton(node.props.children, label);
}

function findElementByType<Props extends object>(
  node: ReactNode,
  type: ReactElement['type'],
  predicate: (props: Props) => boolean,
): ReactElement<Props> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElementByType(child, type, predicate);
      if (match) return match;
    }
    return null;
  }
  if (!isValidElement<Props & { children?: ReactNode }>(node)) return null;
  if (node.type === type && predicate(node.props)) return node;
  return findElementByType(node.props.children, type, predicate);
}

describe('IndicatorSettingsView options structure controls', () => {
  it('shows the approved layers and contains no obsolete analytics labels', () => {
    const markup = renderToStaticMarkup(
      createElement(IndicatorSettingsView, {
        settings: DEFAULT_INDICATOR_SETTINGS_STATE,
        chartDisplay: DEFAULT_CHART_DISPLAY,
        onChange: vi.fn(),
        onChangeChartDisplay: vi.fn(),
        onDismiss: vi.fn(),
        twcEnabled: false,
        onToggleTwc: vi.fn(),
        twcSettings: DEFAULT_TWC_SETTINGS,
        onChangeTwcSettings: vi.fn(),
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
        chartTrading: DEFAULT_CHART_TRADING_SETTINGS,
        onChangeChartTrading: vi.fn(),
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
    expect(markup).toContain('aria-label="Profile strikes decrement"');
    expect(markup).toContain('aria-label="Profile strikes increment"');
    expect(markup).toContain('Refresh: 45s');
    expect(markup).toContain('Diagnostics &amp; Quality Warnings');
    expect(markup).toContain('Bracket from Entry Line');
    expect(markup).toContain('Default Quantity: 1');
    expect(markup).toContain('Reset Indicators');
    expect(markup).toContain('Reset Options');
  });

  it('applies profile-strike edits and both reset actions immediately', () => {
    const onChange = vi.fn();
    const onChangeChartDisplay = vi.fn();
    const onChangeOptionsAnalytics = vi.fn();
    const body = IndicatorSettingsBody({
      settings: DEFAULT_INDICATOR_SETTINGS_STATE,
      chartDisplay: { volumeEnabled: false, volumeWeightedCandleWidth: false },
      onChange,
      onChangeChartDisplay,
      twcEnabled: false,
      onToggleTwc: vi.fn(),
      twcSettings: DEFAULT_TWC_SETTINGS,
      onChangeTwcSettings: vi.fn(),
      optionsAnalytics: DEFAULT_OPTIONS_ANALYTICS_SETTINGS,
      chartTrading: DEFAULT_CHART_TRADING_SETTINGS,
      onChangeChartTrading: vi.fn(),
      onChangeOptionsAnalytics,
    });

    const profileStepper = findElementByType<{
      ariaLabel?: string;
      onChange: (value: number) => void;
    }>(body, Stepper, (props) => props.ariaLabel === 'Profile strikes');
    const resetIndicators = findButton(body, 'Reset Indicators');
    const resetOptions = findButton(body, 'Reset Options');
    profileStepper?.props.onChange(13);
    resetIndicators?.props.onClick?.();
    resetOptions?.props.onClick?.();

    expect(onChangeOptionsAnalytics).toHaveBeenCalledWith({
      ...DEFAULT_OPTIONS_ANALYTICS_SETTINGS,
      profileStrikeCount: 13,
    });
    expect(onChange).toHaveBeenCalledWith(DEFAULT_INDICATOR_SETTINGS_STATE);
    expect(onChangeChartDisplay).toHaveBeenCalledWith(DEFAULT_CHART_DISPLAY);
    expect(onChangeOptionsAnalytics).toHaveBeenCalledWith(DEFAULT_OPTIONS_ANALYTICS_SETTINGS);
  });
});
