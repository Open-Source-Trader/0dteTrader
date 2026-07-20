import { describe, expect, it } from 'vitest';

async function loadGeometryModule() {
  return import('./optionsAnalyticsGeometry').catch(() => null);
}

describe('options analytics rail geometry', () => {
  it('clamps the rail to 28% of the pane between 56 and 112 pixels', async () => {
    const module = await loadGeometryModule();
    expect(module).not.toBeNull();
    if (!module) return;

    expect(module.optionsAnalyticsRailWidth(120)).toBe(56);
    expect(module.optionsAnalyticsRailWidth(300)).toBeCloseTo(84);
    expect(module.optionsAnalyticsRailWidth(600)).toBe(112);
  });

  it('filters by viewport before applying the strike cap', async () => {
    const module = await loadGeometryModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const candidates = [
      { strike: 490, grossGammaExposure: 1_000 },
      { strike: 495, grossGammaExposure: 100 },
      { strike: 500, grossGammaExposure: 400 },
      { strike: 505, grossGammaExposure: 200 },
    ];

    expect(
      module
        .selectVisibleOptionsAnalyticsStrikes(
          candidates,
          2,
          (candidate: { strike: number }) => candidate.strike >= 495,
        )
        .map((candidate: { strike: number }) => candidate.strike),
    ).toEqual([500, 505]);
  });

  it('supports layer-specific ranking when gamma is hidden', async () => {
    const module = await loadGeometryModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const candidates = [
      { strike: 495, grossGammaExposure: 1_000, markedOiValue: null },
      { strike: 500, grossGammaExposure: 100, markedOiValue: 40_000 },
    ];

    expect(
      module.selectVisibleOptionsAnalyticsStrikes(
        candidates,
        1,
        () => true,
        (candidate: { markedOiValue: number | null }) => candidate.markedOiValue ?? 0,
      )[0]?.strike,
    ).toBe(500);
  });

  it('breaks equal-score selection ties by lower strike', async () => {
    const module = await loadGeometryModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const selected = module.selectVisibleOptionsAnalyticsStrikes(
      [
        { strike: 110, grossGammaExposure: 1 },
        { strike: 100, grossGammaExposure: 1 },
      ],
      1,
      () => true,
    );

    expect(selected.map((candidate) => candidate.strike)).toEqual([100]);
  });
});
