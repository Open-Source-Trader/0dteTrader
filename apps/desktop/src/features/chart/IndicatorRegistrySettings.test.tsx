import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { IndicatorRegistrySettings } from './IndicatorRegistrySettings';
import {
  DEFAULT_CHART_DISPLAY,
  DEFAULT_INDICATOR_SETTINGS_STATE,
  INDICATOR_REGISTRY,
} from './indicatorRegistry';

describe('IndicatorRegistrySettings', () => {
  it('enumerates every canonical descriptor and its parameters', () => {
    const markup = renderToStaticMarkup(
      createElement(IndicatorRegistrySettings, {
        settings: DEFAULT_INDICATOR_SETTINGS_STATE,
        chartDisplay: DEFAULT_CHART_DISPLAY,
        onChange: vi.fn(),
        onChangeChartDisplay: vi.fn(),
      }),
    );

    for (const descriptor of INDICATOR_REGISTRY.indicators) {
      expect(markup).toContain(descriptor.displayName);
      for (const parameter of Object.values(descriptor.parameters)) {
        expect(markup).toContain(parameter.label);
      }
    }
    expect(markup).toContain('Volume');
    expect(markup).toContain('No L2 data');
    expect(markup).toContain(`Subpanes (max ${INDICATOR_REGISTRY.maxSubPanes})`);
  });

  it('gives every indicator and volume toggle an accessible name', () => {
    const markup = renderToStaticMarkup(
      createElement(IndicatorRegistrySettings, {
        settings: DEFAULT_INDICATOR_SETTINGS_STATE,
        chartDisplay: DEFAULT_CHART_DISPLAY,
        onChange: vi.fn(),
        onChangeChartDisplay: vi.fn(),
      }),
    );
    const switches = markup.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];

    expect(switches).toHaveLength(INDICATOR_REGISTRY.indicators.length + 1);
    expect(switches.every((toggle) => toggle.includes('aria-label='))).toBe(true);
    expect(markup).toContain('aria-label="Volume"');
    for (const descriptor of INDICATOR_REGISTRY.indicators) {
      expect(markup).toContain(`aria-label="${descriptor.displayName} enabled"`);
    }
  });

  it('does not render any legacy flat settings labels or controls', () => {
    const markup = renderToStaticMarkup(
      createElement(IndicatorRegistrySettings, {
        settings: DEFAULT_INDICATOR_SETTINGS_STATE,
        chartDisplay: DEFAULT_CHART_DISPLAY,
        onChange: vi.fn(),
        onChangeChartDisplay: vi.fn(),
      }),
    );

    expect(markup).not.toContain('vwapEnabled');
    expect(markup).not.toContain('macdFastPeriod');
    expect(markup).not.toContain('settings.smaEnabled');
  });

  it('shows the exact canonical pane-limit message when two subpanes are enabled', () => {
    const settings = structuredClone(DEFAULT_INDICATOR_SETTINGS_STATE);
    settings.indicators.rsi.enabled = true;
    settings.indicators.macd.enabled = true;
    const markup = renderToStaticMarkup(
      createElement(IndicatorRegistrySettings, {
        settings,
        chartDisplay: DEFAULT_CHART_DISPLAY,
        onChange: vi.fn(),
        onChangeChartDisplay: vi.fn(),
      }),
    );

    expect(markup).toContain(INDICATOR_REGISTRY.paneLimitMessage);
  });
});
