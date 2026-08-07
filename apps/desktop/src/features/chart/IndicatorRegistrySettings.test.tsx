// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndicatorRegistrySettings } from './IndicatorRegistrySettings';
import {
  DEFAULT_CHART_DISPLAY,
  DEFAULT_INDICATOR_SETTINGS_STATE,
  INDICATOR_REGISTRY,
} from './indicatorRegistry';

afterEach(cleanup);

describe('IndicatorRegistrySettings', () => {
  it('enumerates every canonical descriptor, and its parameters once expanded', () => {
    render(
      createElement(IndicatorRegistrySettings, {
        settings: DEFAULT_INDICATOR_SETTINGS_STATE,
        chartDisplay: DEFAULT_CHART_DISPLAY,
        onChange: vi.fn(),
        onChangeChartDisplay: vi.fn(),
      }),
    );

    for (const descriptor of INDICATOR_REGISTRY.indicators) {
      expect(screen.getByText(descriptor.displayName)).toBeInTheDocument();
      const parameterCount = Object.keys(descriptor.parameters).length;
      if (parameterCount === 0) continue;
      const disclosure = screen.getByRole('button', { name: `Expand ${descriptor.displayName}` });
      fireEvent.click(disclosure);
      for (const parameter of Object.values(descriptor.parameters)) {
        expect(screen.getAllByLabelText(parameter.label).length).toBeGreaterThan(0);
      }
    }
    expect(screen.getByText('Volume')).toBeInTheDocument();
    expect(screen.getAllByText('No L2 data').length).toBeGreaterThan(0);
    expect(
      screen.getByText(`Subpanes (max ${INDICATOR_REGISTRY.maxSubPanes})`),
    ).toBeInTheDocument();
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

    expect(switches).toHaveLength(INDICATOR_REGISTRY.indicators.length + 2);
    expect(switches.every((toggle) => toggle.includes('aria-label='))).toBe(true);
    expect(markup).toContain('aria-label="Volume"');
    expect(markup).toContain('aria-label="Volume-Weighted Width"');
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
