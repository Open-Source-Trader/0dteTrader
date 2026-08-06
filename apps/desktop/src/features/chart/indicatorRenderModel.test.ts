import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IndicatorGeometry } from '@0dtetrader/shared-types';
import { indicatorStyleColor } from './chartColors';
import { INDICATOR_REGISTRY } from './indicatorRegistry';
import { buildIndicatorRenderModel } from './indicatorRenderModel';

const cases: Array<[id: string, geometry: IndicatorGeometry, expected: string]> = [
  ['sma', { kind: 'line', series: { value: [1, 2] } }, 'overlay'],
  [
    'macd',
    { kind: 'multi_line', series: { macd: [1, 2], signal: [1, 2], histogram: [0, 0] } },
    'histogram',
  ],
  ['bollinger', { kind: 'band', series: { upper: [2, 3], middle: [1, 2], lower: [0, 1] } }, 'fill'],
  [
    'ichimoku',
    {
      kind: 'cloud',
      series: {
        conversion: [1, 2],
        base: [1, 2],
        spanA: [1, 2],
        spanB: [0, 1],
        lagging: [1, 2],
      },
    },
    'fill',
  ],
  ['top_book_imbalance', { kind: 'histogram', series: { value: [1, -1] } }, 'histogram'],
  [
    'supertrend',
    { kind: 'segmented_line', series: { bullish: [1, null], bearish: [null, 2] } },
    'segmented',
  ],
  [
    'vpvr',
    { kind: 'price_profile', rows: [{ low: 1, high: 2, volume: 10, inValueArea: true }] },
    'profile',
  ],
];

describe('generic indicator render model', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(cases)(
    'maps %s geometry without indicator-specific renderer branches',
    (id, geometry, expected) => {
      const descriptor = INDICATOR_REGISTRY.indicators.find((candidate) => candidate.id === id)!;
      const model = buildIndicatorRenderModel(descriptor, geometry);

      if (expected === 'overlay') expect(model.overlays).toHaveLength(1);
      if (expected === 'histogram') {
        expect(
          [...model.overlays, ...model.paneSeries].some(({ kind }) => kind === 'histogram'),
        ).toBe(true);
      }
      if (expected === 'fill') expect(model.fills).not.toHaveLength(0);
      if (expected === 'segmented') expect(model.overlays.every(({ gaps }) => gaps)).toBe(true);
      if (expected === 'profile') {
        expect(geometry.kind).toBe('price_profile');
        if (geometry.kind === 'price_profile') {
          expect(
            model.profileRows.map(({ low, high, volume, inValueArea }) => ({
              low,
              high,
              volume,
              inValueArea,
            })),
          ).toEqual(geometry.rows);
        }
      }
    },
  );

  it('rejects a descriptor/geometry kind mismatch', () => {
    const descriptor = INDICATOR_REGISTRY.indicators.find(({ id }) => id === 'sma')!;
    expect(() =>
      buildIndicatorRenderModel(descriptor, { kind: 'histogram', series: { value: [1] } }),
    ).toThrow('geometry kind');
  });

  it('resolves canonical series semantics through theme tokens', () => {
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) => (name === '--indicator-stochastic-k' ? '#f5c542' : ''),
    }));

    expect(indicatorStyleColor('indicator.stochastic.k')).toBe('#f5c542');
  });

  it.each([
    ['macd', '#9aa9bc'],
    ['top_book_imbalance', '#40cbe0'],
    ['tick_pressure', '#ffc53d'],
  ] as const)('resolves %s histogram colors from canonical semantic metadata', (id, color) => {
    const descriptor = INDICATOR_REGISTRY.indicators.find((candidate) => candidate.id === id)!;
    const geometry: IndicatorGeometry =
      id === 'macd'
        ? {
            kind: 'multi_line',
            series: { macd: [1], signal: [0.5], histogram: [-0.5] },
          }
        : { kind: 'histogram', series: { value: [-0.5] } };

    const histogram = buildIndicatorRenderModel(descriptor, geometry).paneSeries.find(
      ({ kind }) => kind === 'histogram',
    );

    expect(histogram).toMatchObject({ positiveColor: color, negativeColor: color });
  });

  it('keeps related multiline series visually distinguishable', () => {
    const descriptor = INDICATOR_REGISTRY.indicators.find(({ id }) => id === 'stochastic')!;
    const model = buildIndicatorRenderModel(descriptor, {
      kind: 'multi_line',
      series: { k: [10, 20], d: [20, 30] },
    });

    expect(model.paneSeries[0]?.color).not.toBe(model.paneSeries[1]?.color);
  });

  it('resolves band and cloud fills from canonical boundary style tokens', () => {
    const bollinger = INDICATOR_REGISTRY.indicators.find(({ id }) => id === 'bollinger')!;
    const band = buildIndicatorRenderModel(bollinger, {
      kind: 'band',
      series: { upper: [12], middle: [10], lower: [8] },
    });
    expect(band.fills[0]).toMatchObject({ color: '#40cbe0', opacity: 0.08 });
    expect(band.fills[0]).not.toHaveProperty('styleToken');

    const ichimoku = INDICATOR_REGISTRY.indicators.find(({ id }) => id === 'ichimoku')!;
    const cloud = buildIndicatorRenderModel(ichimoku, {
      kind: 'cloud',
      series: { conversion: [1], base: [1], spanA: [2], spanB: [0], lagging: [1] },
    });
    expect(cloud.fills[0]).toMatchObject({ color: '#22e06a', opacity: 0.1 });
    expect(cloud.fills[0]).not.toHaveProperty('styleToken');
  });

  it('attaches canonical VPVR row and value-area colors to profile geometry', () => {
    const descriptor = INDICATOR_REGISTRY.indicators.find(({ id }) => id === 'vpvr')!;
    const model = buildIndicatorRenderModel(descriptor, {
      kind: 'price_profile',
      rows: [
        { low: 1, high: 2, volume: 10, inValueArea: false },
        { low: 2, high: 3, volume: 20, inValueArea: true },
      ],
    });

    expect(model.profileRows).toEqual([
      { low: 1, high: 2, volume: 10, inValueArea: false, color: '#8cb4eb', opacity: 0.22 },
      { low: 2, high: 3, volume: 20, inValueArea: true, color: '#3b9eff', opacity: 0.42 },
    ]);
  });
});
