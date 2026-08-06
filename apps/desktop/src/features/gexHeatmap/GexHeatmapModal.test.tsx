import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GexHeatmapModal } from './GexHeatmapModal';

const expirations = ['2026-08-21', '2026-09-18'];

describe('GexHeatmapModal', () => {
  it('shows an unavailable state instead of fabricated exposure data', () => {
    const html = renderToStaticMarkup(
      createElement(GexHeatmapModal, {
        symbol: 'SPY',
        spotPrice: 500,
        bid: 499.95,
        ask: 500.05,
        expirations,
        onDismiss: () => {},
      }),
    );
    expect(html).toContain('GEX data unavailable');
    expect(html).not.toContain('SPY GEX heatmap');
  });

  it('renders the header with symbol, price, bid, and ask', () => {
    const html = renderToStaticMarkup(
      createElement(GexHeatmapModal, {
        symbol: 'QQQ',
        spotPrice: 480,
        bid: 479.9,
        ask: 480.1,
        expirations,
        onDismiss: () => {},
      }),
    );
    expect(html).toContain('gex-heatmap-modal__header');
    expect(html).toContain('QQQ');
    expect(html).toContain('479.90');
    expect(html).toContain('480.10');
  });

  it('shows a placeholder when bid/ask are unavailable', () => {
    const html = renderToStaticMarkup(
      createElement(GexHeatmapModal, {
        symbol: 'QQQ',
        spotPrice: 480,
        bid: null,
        ask: null,
        expirations,
        onDismiss: () => {},
      }),
    );
    expect(html).toContain('—');
  });
});
