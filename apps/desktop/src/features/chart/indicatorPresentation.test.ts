import { describe, expect, it } from 'vitest';
import { INDICATOR_REGISTRY } from './indicatorRegistry';
import { indicatorPanePresentation } from './indicatorPresentation';

describe('indicatorPanePresentation', () => {
  it.each([
    ['rsi', [30, 70], [0, 100]],
    ['stochastic', [20, 80], [0, 100]],
    ['williams_r', [-80, -20], [-100, 0]],
  ] as const)('maps %s to its canonical guides and fixed range', (id, guideLines, yRange) => {
    const descriptor = INDICATOR_REGISTRY.indicators.find((candidate) => candidate.id === id);
    expect(descriptor).toBeDefined();
    expect(indicatorPanePresentation(descriptor!)).toEqual({ guideLines, yRange });
  });

  it('leaves unbounded panes on automatic scaling', () => {
    const descriptor = INDICATOR_REGISTRY.indicators.find(({ id }) => id === 'macd');
    expect(descriptor).toBeDefined();
    expect(indicatorPanePresentation(descriptor!)).toEqual({});
  });
});
