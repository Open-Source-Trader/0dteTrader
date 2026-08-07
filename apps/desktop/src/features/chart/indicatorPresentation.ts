import type { IndicatorDescriptor } from '@0dtetrader/shared-types';

export interface IndicatorPanePresentation {
  guideLines?: number[];
  yRange?: [number, number];
}

const BOUNDED_OSCILLATORS: Partial<
  Record<IndicatorDescriptor['id'], Required<IndicatorPanePresentation>>
> = {
  rsi: { guideLines: [30, 70], yRange: [0, 100] },
  stochastic: { guideLines: [20, 80], yRange: [0, 100] },
  williams_r: { guideLines: [-80, -20], yRange: [-100, 0] },
};

/** Renderer presentation keyed by the canonical descriptor, not UI row position. */
export function indicatorPanePresentation(
  descriptor: IndicatorDescriptor,
): IndicatorPanePresentation {
  const presentation = BOUNDED_OSCILLATORS[descriptor.id];
  return presentation
    ? { guideLines: [...presentation.guideLines], yRange: [...presentation.yRange] }
    : {};
}
