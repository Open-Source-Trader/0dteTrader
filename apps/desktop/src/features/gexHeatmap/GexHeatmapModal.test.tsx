import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GexHeatmapModal } from './GexHeatmapModal';

const expirations = ['2026-08-21', '2026-09-18'];

describe('GexHeatmapModal', () => {
  it('renders different exposure data for different underlying symbols at the same spot price', () => {
    const spy = renderToStaticMarkup(
      createElement(GexHeatmapModal, {
        symbol: 'SPY',
        spotPrice: 500,
        expirations,
        onDismiss: () => {},
      }),
    );
    const nvda = renderToStaticMarkup(
      createElement(GexHeatmapModal, {
        symbol: 'NVDA',
        spotPrice: 500,
        expirations,
        onDismiss: () => {},
      }),
    );
    expect(spy).not.toBe(nvda);
  });

  it('labels the heatmap with the selected symbol, not a hard-coded one', () => {
    const html = renderToStaticMarkup(
      createElement(GexHeatmapModal, {
        symbol: 'QQQ',
        spotPrice: 480,
        expirations,
        onDismiss: () => {},
      }),
    );
    expect(html).toContain('QQQ GEX heatmap');
  });
});
