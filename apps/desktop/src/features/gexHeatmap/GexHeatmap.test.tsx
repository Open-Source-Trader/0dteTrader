import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GexHeatmap } from './GexHeatmap';
import type { GexHeatmapColumn, GexHeatmapEntry } from './types';

const columns: readonly GexHeatmapColumn[] = [
  { key: '2026-08-21', label: '2026-08-21' },
  { key: '2026-09-18', label: '2026-09-18' },
  { key: '2026-10-16', label: '2026-10-16' },
];

const sampleEntries: readonly GexHeatmapEntry[] = [
  {
    strike: 750,
    cells: [
      { columnKey: '2026-08-21', netGex: 50_500_000 },
      { columnKey: '2026-09-18', netGex: -8_400_000 },
      { columnKey: '2026-10-16', netGex: 42_100_000 },
    ],
  },
  {
    strike: 770,
    cells: [
      { columnKey: '2026-08-21', netGex: 54_700_000 },
      { columnKey: '2026-09-18', netGex: -100_000 },
      { columnKey: '2026-10-16', netGex: 54_600_000 },
    ],
  },
];

function render(entries: readonly GexHeatmapEntry[] = sampleEntries) {
  return renderToStaticMarkup(
    createElement(GexHeatmap, {
      symbol: 'SPY',
      spotPrice: 771.7,
      columns,
      entries,
    }),
  );
}

describe('GexHeatmap', () => {
  it('renders every column as a heading', () => {
    const html = render();
    for (const column of columns) {
      expect(html).toContain(column.label);
    }
  });

  it('works for a non-SPY symbol without hard-coded assumptions', () => {
    const html = renderToStaticMarkup(
      createElement(GexHeatmap, {
        symbol: 'TSLA',
        spotPrice: 245.3,
        columns: [{ key: '2026-09-19', label: '2026-09-19' }],
        entries: [{ strike: 240, cells: [{ columnKey: '2026-09-19', netGex: 10_000_000 }] }],
      }),
    );
    expect(html).toContain('TSLA GEX heatmap');
    expect(html).not.toContain('SPY');
  });

  it('renders formatted exposure values', () => {
    const html = render();
    expect(html).toContain('+$54,700,000');
    expect(html).toContain('-$8,400,000');
  });

  it('renders a dash for a missing cell', () => {
    const html = render([{ strike: 780, cells: [] }]);
    expect(html).toContain('-');
  });

  it('highlights the row closest to spot', () => {
    const html = render();
    expect(html).toContain('gex-heatmap__row--spot');
  });
});
