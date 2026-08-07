import { describe, expect, it } from 'vitest';
import type { IndicatorGeometry, IndicatorId } from '@0dtetrader/shared-types';
import fixtures from '../../../../../packages/shared-types/fixtures/indicator-parity-v1.json';
import { computeIndicatorGeometry, type TimedCandleInput } from './indicatorEngine';
import { INDICATOR_REGISTRY } from './indicatorRegistry';

interface FixtureCase {
  id: string;
  indicatorId: IndicatorId;
  candleSetId: string;
  parameters: Record<string, number>;
  expected: IndicatorGeometry;
}

function expectNumbersClose(actual: unknown, expected: unknown, tolerance: number): void {
  if (typeof expected === 'number') {
    expect(typeof actual).toBe('number');
    expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tolerance);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    expect(actual).toHaveLength(expected.length);
    expected.forEach((value, index) =>
      expectNumbersClose((actual as unknown[])[index], value, tolerance),
    );
    return;
  }
  if (expected && typeof expected === 'object') {
    expect(actual && typeof actual === 'object').toBe(true);
    expect(Object.keys(actual as object)).toEqual(Object.keys(expected));
    for (const [key, value] of Object.entries(expected)) {
      expectNumbersClose((actual as Record<string, unknown>)[key], value, tolerance);
    }
    return;
  }
  expect(actual).toBe(expected);
}

describe('descriptor-driven candle indicator parity', () => {
  it.each(fixtures.indicatorCases as unknown as FixtureCase[])('$id', (fixture) => {
    const descriptor = INDICATOR_REGISTRY.indicators.find(({ id }) => id === fixture.indicatorId);
    const candles = fixtures.candleSets[
      fixture.candleSetId as keyof typeof fixtures.candleSets
    ] as TimedCandleInput[];

    expect(descriptor).toBeDefined();
    const actual = computeIndicatorGeometry(descriptor!, candles, fixture.parameters);
    expectNumbersClose(actual, fixture.expected, fixtures.tolerance);
  });

  it('rejects invalid candle input instead of returning partial geometry', () => {
    const descriptor = INDICATOR_REGISTRY.indicators.find(({ id }) => id === 'sma')!;
    const candles = structuredClone(fixtures.candleSets.rising) as TimedCandleInput[];
    candles[1].timestamp = candles[0].timestamp;

    expect(() => computeIndicatorGeometry(descriptor, candles, { period: 2 })).toThrow(
      'strictly increasing',
    );
  });

  it('does not fabricate geometry for registry-addressable L2 indicators', () => {
    const descriptor = INDICATOR_REGISTRY.indicators.find(({ id }) => id === 'spread')!;
    expect(() => computeIndicatorGeometry(descriptor, [], {})).toThrow('No L2 data');
  });
});
