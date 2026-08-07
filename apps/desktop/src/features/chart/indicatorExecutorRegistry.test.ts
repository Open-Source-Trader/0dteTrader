import { describe, expect, it } from 'vitest';
import type { OrderBookIndicators } from '@0dtetrader/shared-types';
import {
  computeL2IndicatorGeometry,
  INDICATOR_EXECUTORS,
  L2_INDICATOR_EXECUTORS,
} from './indicatorEngine';
import { INDICATOR_REGISTRY } from './indicatorRegistry';

describe('indicator executor registry', () => {
  it('has exactly one executor for every canonical registry indicator', () => {
    const canonicalIds = INDICATOR_REGISTRY.indicators.map(({ id }) => id).sort();
    const executorIds = Object.keys(INDICATOR_EXECUTORS).sort();

    expect(executorIds).toEqual(canonicalIds);
    for (const id of canonicalIds) expect(INDICATOR_EXECUTORS[id]).toBeTypeOf('function');
  });

  it('has exactly one live executor for every canonical L2 indicator', () => {
    const canonicalIds = INDICATOR_REGISTRY.indicators
      .filter(({ requiresL2 }) => requiresL2)
      .map(({ id }) => id)
      .sort();

    expect(Object.keys(L2_INDICATOR_EXECUTORS).sort()).toEqual(canonicalIds);
  });

  it('maps every published L2 field through the exhaustive live catalog', () => {
    const indicators: OrderBookIndicators = {
      spreadAbs: 0.01,
      spreadBps: 1.5,
      spreadPercentile: 0.75,
      topBookImbalance: 0.1,
      tickPressure: 0.2,
      depthImbalance: 0.3,
      cumulativePressure: 0.4,
      touchDepletion: 0.5,
    };
    const expected = {
      spread: {
        kind: 'multi_line',
        series: { absolute: [null, 0.01], bps: [null, 1.5], percentile: [null, 0.75] },
      },
      top_book_imbalance: { kind: 'histogram', series: { value: [null, 0.1] } },
      tick_pressure: { kind: 'histogram', series: { value: [null, 0.2] } },
      depth_imbalance: { kind: 'histogram', series: { value: [null, 0.3] } },
      cumulative_pressure: { kind: 'histogram', series: { value: [null, 0.4] } },
      touch_depletion: { kind: 'histogram', series: { value: [null, 0.5] } },
    };

    for (const descriptor of INDICATOR_REGISTRY.indicators.filter(({ requiresL2 }) => requiresL2)) {
      expect(computeL2IndicatorGeometry(descriptor, indicators, 2)).toEqual(
        expected[descriptor.id as keyof typeof expected],
      );
    }
  });
});
