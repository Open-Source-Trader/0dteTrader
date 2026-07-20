import { describe, expect, it } from 'vitest';
import { makeOptionsAnalyticsSnapshot } from './optionsAnalyticsTestFixture';

async function loadPresentationModule() {
  return import('./optionsAnalyticsPresentation').catch(() => null);
}

const settings = {
  enabled: true,
  showImpliedRange: true,
  showGammaProfile: true,
  showMarkedOi: false,
  showLiquidity: false,
  showDealerProxy: false,
  refreshSeconds: 45,
  profileStrikeCount: 12,
};

describe('options analytics presentation', () => {
  it('labels unavailable modeled structure instead of displaying fabricated zeroes', async () => {
    const module = await loadPresentationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const fixture = makeOptionsAnalyticsSnapshot();
    const model = module.buildOptionsAnalyticsPresentation(
      {
        ...fixture,
        structure: {
          ...fixture.structure,
          callGammaExposure: null,
          putGammaExposure: null,
          grossGammaExposure: null,
          callDeltaNotional: null,
          putDeltaNotional: null,
        },
      },
      settings,
    );

    expect(model.structureLine).toContain('gamma C unavailable');
    expect(model.structureLine).toContain('gross unavailable');
    expect(model.accessibleSummary).not.toContain('Structure gamma C $0');
  });

  it('normalizes selected widths against every visible candidate', async () => {
    const module = await loadPresentationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const model = module.buildOptionsAnalyticsPresentation(
      makeOptionsAnalyticsSnapshot(),
      settings,
      Date.parse('2026-07-19T14:30:20.000Z'),
    );

    const selected = { ...model.allStrikes[0], putGammaExposure: 0 };
    expect(module.scaleOptionsAnalyticsStrikes([selected], model.allStrikes)[0]).toMatchObject({
      callScale: 0.5,
      putScale: 0,
    });
  });

  it('uses stable square-root scaling with calls right and puts left', async () => {
    const module = await loadPresentationModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const model = module.buildOptionsAnalyticsPresentation(
      makeOptionsAnalyticsSnapshot(),
      settings,
      Date.parse('2026-07-19T14:30:20.000Z'),
    );

    expect(model.strikes[0]).toMatchObject({
      strike: 495,
      callScale: 0.5,
      callDirection: 'right',
      putScale: 1,
      putDirection: 'left',
    });
    expect(model.strikes[1]).toMatchObject({ strike: 505, callScale: 1, putScale: 0 });
  });

  it('keeps a retained strike scale stable as viewport visibility changes', async () => {
    const module = await loadPresentationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const fixture = makeOptionsAnalyticsSnapshot();
    const secondStrike = fixture.strikes[1];
    const model = module.buildOptionsAnalyticsPresentation(
      {
        ...fixture,
        strikes: [
          fixture.strikes[0],
          {
            ...secondStrike,
            call: { ...secondStrike.call!, gammaExposure: 1_600 },
          },
        ],
      },
      settings,
    );

    const whileBothVisible = module.selectOptionsAnalyticsProfileStrikes(
      model.allStrikes,
      settings.profileStrikeCount,
      () => true,
    );
    const whileFirstOnly = module.selectOptionsAnalyticsProfileStrikes(
      model.allStrikes,
      settings.profileStrikeCount,
      (strike) => strike.strike === 495,
    );
    const firstBeforePan = whileBothVisible.find((strike) => strike.strike === 495);
    const firstAfterPan = whileFirstOnly.find((strike) => strike.strike === 495);

    expect(firstBeforePan).toMatchObject({ callScale: 0.25, putScale: 0.5 });
    expect(firstAfterPan).toMatchObject({ callScale: 0.25, putScale: 0.5 });
  });

  it('keeps marked-OI scale stable as viewport visibility changes', async () => {
    const module = await loadPresentationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const model = module.buildOptionsAnalyticsPresentation(makeOptionsAnalyticsSnapshot(), {
      ...settings,
      showMarkedOi: true,
    });

    const whileBothVisible = module.selectOptionsAnalyticsProfileStrikes(
      model.allStrikes,
      settings.profileStrikeCount,
      () => true,
    );
    const whileFirstOnly = module.selectOptionsAnalyticsProfileStrikes(
      model.allStrikes,
      settings.profileStrikeCount,
      (strike) => strike.strike === 495,
    );
    const firstBeforePan = whileBothVisible.find((strike) => strike.strike === 495);
    const firstAfterPan = whileFirstOnly.find((strike) => strike.strike === 495);

    expect(firstBeforePan?.callMarkedOiScale).toBeCloseTo(Math.sqrt(12_000 / 20_000));
    expect(firstBeforePan?.putMarkedOiScale).toBeCloseTo(Math.sqrt(8_000 / 20_000));
    expect(firstAfterPan?.callMarkedOiScale).toBe(firstBeforePan?.callMarkedOiScale);
    expect(firstAfterPan?.putMarkedOiScale).toBe(firstBeforePan?.putMarkedOiScale);
  });

  it('retains a low-gamma high-OI strike when gamma and marked OI are enabled', async () => {
    const module = await loadPresentationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const fixture = makeOptionsAnalyticsSnapshot();
    const firstStrike = fixture.strikes[0];
    const secondStrike = fixture.strikes[1];
    const model = module.buildOptionsAnalyticsPresentation(
      {
        ...fixture,
        strikes: [
          {
            ...firstStrike,
            call: { ...firstStrike.call!, gammaExposure: 1, markedOiValue: 1_000_000 },
            put: null,
            grossGammaExposure: 1,
          },
          {
            ...secondStrike,
            call: { ...secondStrike.call!, gammaExposure: 5_000, markedOiValue: 10 },
            grossGammaExposure: 5_000,
          },
          {
            ...secondStrike,
            strike: 515,
            call: { ...secondStrike.call!, gammaExposure: 10_000, markedOiValue: 10 },
            grossGammaExposure: 10_000,
          },
        ],
      },
      { ...settings, showMarkedOi: true, profileStrikeCount: 2 },
    );

    expect(model.strikes.map((strike) => strike.strike)).toEqual([495, 515]);
  });

  it('exposes required quality, freshness, range, and wall provenance', async () => {
    const module = await loadPresentationModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const model = module.buildOptionsAnalyticsPresentation(
      makeOptionsAnalyticsSnapshot(),
      settings,
      Date.parse('2026-07-19T14:30:20.000Z'),
    );

    expect(model.qualityLines.join(' ')).toContain('2026-07-19');
    expect(model.qualityLines.join(' ')).toContain('Root SPY · Settlement PM');
    expect(model.qualityLines.join(' ')).toContain('$ delta change per 1% underlying move');
    expect(model.qualityLines.join(' ')).toContain('Observed 14:30:10 UTC (age 10s)');
    expect(model.qualityLines.join(' ')).toContain('Quote 14:30:08 UTC (age 12s)');
    expect(model.qualityLines.join(' ')).toContain('Greeks 14:30:06 UTC (age 14s)');
    expect(model.qualityLines.join(' ')).toContain('realtime');
    expect(model.qualityLines.join(' ')).toContain('8/10 (80%)');
    expect(model.qualityLines.join(' ')).toContain('partial');
    expect(model.qualityLines.join(' ')).toContain('options-analytics-v1');
    expect(model.qualityLines.join(' ')).toContain('fresh');
    expect(model.qualityLines.join(' ')).toContain('Two crossed quotes excluded');
    expect(model.accessibleSummary).toContain('model-implied 68% range 493.00 to 507.00');
    expect(model.accessibleSummary).toContain('Root SPY · Settlement PM');
    expect(model.structureLine).toBe(
      'Structure gamma C $900 · P $500 · gross $1K · delta notional C $2.0M · P -$1.5M',
    );
    expect(model.accessibleSummary).toContain(model.structureLine);
    expect(model.accessibleSummary).toContain('call wall 505.00');
    expect(model.accessibleSummary).toContain('put wall 495.00');
    expect(model.strikes[0]).toMatchObject({
      callImpliedVolatility: 0.21,
      putImpliedVolatility: 0.22,
      callDelta: 0.7,
      putDelta: -0.3,
      callDeltaNotional: 3_500_000,
      putDeltaNotional: -1_200_000,
    });
  });

  it('makes an empty warning set explicit', async () => {
    const module = await loadPresentationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const fixture = makeOptionsAnalyticsSnapshot();
    const model = module.buildOptionsAnalyticsPresentation(
      { ...fixture, quality: { ...fixture.quality, warnings: [] } },
      settings,
      Date.parse('2026-07-19T14:30:20.000Z'),
    );

    expect(model.qualityLines).toContain('Warnings none');
  });

  it('caps visible warnings while retaining the complete accessible warning set', async () => {
    const module = await loadPresentationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const fixture = makeOptionsAnalyticsSnapshot();
    const warnings = Array.from({ length: 8 }, (_, index) => `Provider warning ${index + 1}`);
    const model = module.buildOptionsAnalyticsPresentation(
      { ...fixture, quality: { ...fixture.quality, warnings } },
      settings,
    );

    expect(model.visibleQualityLines).toContain('Warning: Provider warning 1');
    expect(model.visibleQualityLines).toContain('Warning: Provider warning 3');
    expect(model.visibleQualityLines).not.toContain('Warning: Provider warning 4');
    expect(model.visibleQualityLines).toContain('5 more warnings');
    expect(model.qualityLines).toContain('Warning: Provider warning 8');
    expect(model.accessibleSummary).toContain('Warning: Provider warning 8');
  });

  it('keeps marked OI, liquidity, and dealer proxy details opt-in', async () => {
    const module = await loadPresentationModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const defaultModel = module.buildOptionsAnalyticsPresentation(
      makeOptionsAnalyticsSnapshot(),
      settings,
      Date.parse('2026-07-19T14:30:20.000Z'),
    );
    expect(defaultModel.strikes[0]?.markedOiValue).toBeNull();
    expect(defaultModel.strikes[0]?.liquidity).toBeNull();
    expect(defaultModel.dealerProxy).toBeNull();
    expect(defaultModel.maxOpenInterestStrike).toBeNull();
    expect(defaultModel.accessibleSummary).not.toContain('dealer proxy');

    const optInModel = module.buildOptionsAnalyticsPresentation(
      makeOptionsAnalyticsSnapshot(),
      {
        ...settings,
        showGammaProfile: false,
        showMarkedOi: true,
        showLiquidity: true,
        showDealerProxy: true,
      },
      Date.parse('2026-07-19T14:30:20.000Z'),
    );
    expect(optInModel.showGammaProfile).toBe(false);
    expect(optInModel.showMarkedOi).toBe(true);
    expect(optInModel.showLiquidity).toBe(true);
    expect(optInModel.strikes[0]?.markedOiValue).toBe(20_000);
    expect(optInModel.strikes[0]).toMatchObject({
      callMarkedOiValue: 12_000,
      putMarkedOiValue: 8_000,
    });
    expect(optInModel.strikes[0]?.liquidity).toEqual({
      callBidSize: 20,
      callAskSize: 18,
      putBidSize: 15,
      putAskSize: 14,
      callOpenInterest: 100,
      putOpenInterest: 80,
      callVolume: 12,
      putVolume: 10,
      callRelativeSpread: 0.08,
      putRelativeSpread: 0.12,
      callRoundTripCost: 800,
      putRoundTripCost: 600,
    });
    expect(optInModel.dealerProxy?.assumption).toContain('Calls short');
    expect(optInModel.maxOpenInterestStrike).toBe(500);
    expect(optInModel.accessibleSummary).toContain('max OI node 500.00');
    expect(optInModel.accessibleSummary).toContain('dealer gamma flip proxy roots 497.50, 502.50');
    expect(optInModel.accessibleSummary).toContain('dealer proxy gamma exposure 400.00');
    expect(optInModel.accessibleSummary).toContain('dealer proxy delta notional -100000.00');
  });
});
