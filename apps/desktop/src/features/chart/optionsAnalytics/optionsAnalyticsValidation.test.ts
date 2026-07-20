import { describe, expect, it } from 'vitest';
import canonicalOptionsAnalyticsJson from '../../../../../../packages/shared-types/fixtures/options-analytics-v1.json?raw';
import { makeOptionsAnalyticsSnapshot } from './optionsAnalyticsTestFixture';

async function loadValidationModule() {
  return import('./optionsAnalyticsValidation').catch(() => null);
}

describe('options analytics runtime validation', () => {
  it('accepts the shared canonical options analytics JSON fixture', async () => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const validated = module.validateOptionsAnalyticsSnapshot(
      JSON.parse(canonicalOptionsAnalyticsJson),
      'SPX',
      '2026-07-20',
    );

    expect(validated.scope).toMatchObject({ rootSymbol: 'SPXW', settlementStyle: 'pm' });
  });

  it('accepts the supported finite exact-key snapshot', async () => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const validated = module.validateOptionsAnalyticsSnapshot(
      makeOptionsAnalyticsSnapshot(),
      'SPY',
      '2026-07-19',
    );

    expect(validated.scope.symbol).toBe('SPY');
    expect(validated.scope).toMatchObject({ rootSymbol: 'SPY', settlementStyle: 'pm' });
  });

  it('accepts observed-only strikes when every modeled structure layer is unavailable', async () => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const observedOnly = {
      ...snapshot,
      quality: {
        ...snapshot.quality,
        greeksAsOf: null,
        coverage: { contractsTotal: 2, contractsIncluded: 0, ratio: 0 },
        status: 'partial',
      },
      structure: {
        callGammaExposure: null,
        putGammaExposure: null,
        grossGammaExposure: null,
        callDeltaNotional: null,
        putDeltaNotional: null,
        callWall: null,
        putWall: null,
        grossGammaConcentration: null,
        maxOpenInterestStrike: snapshot.structure.maxOpenInterestStrike,
      },
      scenarios: { callPutDealerProxy: null },
      impliedRange: null,
    };

    expect(() =>
      module.validateOptionsAnalyticsSnapshot(observedOnly, 'SPY', '2026-07-19'),
    ).not.toThrow();
  });

  it.each([
    ['missing root symbol', { rootSymbol: undefined }],
    ['blank root symbol', { rootSymbol: '   ' }],
    ['missing settlement style', { settlementStyle: undefined }],
    ['uppercase settlement style', { settlementStyle: 'PM' }],
    ['unsupported settlement style', { settlementStyle: 'weekly' }],
  ])('rejects %s provenance', async (_label, scopeOverride) => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const malformed = {
      ...snapshot,
      scope: { ...snapshot.scope, ...scopeOverride },
    };

    expect(() => module.validateOptionsAnalyticsSnapshot(malformed, 'SPY', '2026-07-19')).toThrow(
      /Invalid options analytics snapshot/,
    );
  });

  it.each([
    ['foreign ETF root', 'SPY', { rootSymbol: 'QQQ', settlementStyle: 'pm' }],
    ['AM-settled ETF root', 'SPY', { rootSymbol: 'SPY', settlementStyle: 'am' }],
    ['unrelated SPX root', 'SPX', { symbol: 'SPX', rootSymbol: 'QQQ', settlementStyle: 'pm' }],
    ['PM-settled SPX root', 'SPX', { symbol: 'SPX', rootSymbol: 'SPX', settlementStyle: 'pm' }],
    ['AM-settled SPXW root', 'SPX', { symbol: 'SPX', rootSymbol: 'SPXW', settlementStyle: 'am' }],
  ])('rejects %s combination', async (_label, expectedSymbol, scopeOverride) => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const malformed = {
      ...snapshot,
      scope: { ...snapshot.scope, ...scopeOverride },
    };

    expect(() =>
      module.validateOptionsAnalyticsSnapshot(malformed, expectedSymbol, '2026-07-19'),
    ).toThrow(/Invalid options analytics snapshot/);
  });

  it('accepts the SPX AM-settled root combination', async () => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const spxAmSnapshot = {
      ...snapshot,
      scope: {
        ...snapshot.scope,
        symbol: 'SPX',
        rootSymbol: 'SPX',
        settlementStyle: 'am',
      },
    };

    expect(() =>
      module.validateOptionsAnalyticsSnapshot(spxAmSnapshot, 'SPX', '2026-07-19'),
    ).not.toThrow();
  });

  it.each([
    ['non-positive spot', { scope: { ...makeOptionsAnalyticsSnapshot().scope, spot: 0 } }],
    [
      'coverage outside zero to one',
      {
        quality: {
          ...makeOptionsAnalyticsSnapshot().quality,
          coverage: { contractsTotal: 10, contractsIncluded: 8, ratio: 1.1 },
        },
      },
    ],
    ['unsupported exposure unit', { exposureUnit: '$ delta change' }],
    [
      'date-only observation timestamp',
      { scope: { ...makeOptionsAnalyticsSnapshot().scope, observedAt: '2026-07-19' } },
    ],
    [
      'observation at settlement',
      {
        scope: {
          ...makeOptionsAnalyticsSnapshot().scope,
          observedAt: makeOptionsAnalyticsSnapshot().scope.settlementAt,
        },
      },
    ],
    [
      'duplicate or unordered strikes',
      {
        strikes: [
          makeOptionsAnalyticsSnapshot().strikes[1],
          makeOptionsAnalyticsSnapshot().strikes[0],
        ],
      },
    ],
  ])('rejects %s', async (_label, override) => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const malformed = { ...makeOptionsAnalyticsSnapshot(), ...override };

    expect(() => module.validateOptionsAnalyticsSnapshot(malformed, 'SPY', '2026-07-19')).toThrow(
      /Invalid options analytics snapshot/,
    );
  });

  it('rejects a response for a different symbol or exact expiration', async () => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();

    expect(() => module.validateOptionsAnalyticsSnapshot(snapshot, 'QQQ', '2026-07-19')).toThrow(
      /Invalid options analytics snapshot/,
    );
    expect(() => module.validateOptionsAnalyticsSnapshot(snapshot, 'SPY', '2026-07-20')).toThrow(
      /Invalid options analytics snapshot/,
    );
  });

  it('accepts range lower bounds clamped to zero', async () => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const withClampedRange = {
      ...snapshot,
      impliedRange: {
        ...snapshot.impliedRange!,
        lower: 0,
        straddleLower: 0,
      },
    };

    expect(() =>
      module.validateOptionsAnalyticsSnapshot(withClampedRange, 'SPY', '2026-07-19'),
    ).not.toThrow();
  });

  it('rejects a non-positive ATM implied volatility', async () => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const withZeroAtmIv = {
      ...snapshot,
      impliedRange: { ...snapshot.impliedRange!, atmIv: 0 },
    };

    expect(() =>
      module.validateOptionsAnalyticsSnapshot(withZeroAtmIv, 'SPY', '2026-07-19'),
    ).toThrow(/Invalid options analytics snapshot/);
  });

  it.each(['callGammaExposure', 'putGammaExposure'] as const)(
    'rejects a negative structure %s',
    async (field) => {
      const module = await loadValidationModule();
      expect(module).not.toBeNull();
      if (!module) return;
      const snapshot = makeOptionsAnalyticsSnapshot();
      const malformed = {
        ...snapshot,
        structure: { ...snapshot.structure, [field]: -1 },
      };

      expect(() => module.validateOptionsAnalyticsSnapshot(malformed, 'SPY', '2026-07-19')).toThrow(
        /Invalid options analytics snapshot/,
      );
    },
  );

  it('rejects a negative leg gamma exposure', async () => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const firstStrike = snapshot.strikes[0];
    const malformed = {
      ...snapshot,
      strikes: [
        { ...firstStrike, call: { ...firstStrike.call!, gammaExposure: -1 } },
        ...snapshot.strikes.slice(1),
      ],
    };

    expect(() => module.validateOptionsAnalyticsSnapshot(malformed, 'SPY', '2026-07-19')).toThrow(
      /Invalid options analytics snapshot/,
    );
  });

  it('rejects gross gamma concentration outside zero through one', async () => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const malformed = {
      ...snapshot,
      structure: { ...snapshot.structure, grossGammaConcentration: 1.01 },
    };

    expect(() => module.validateOptionsAnalyticsSnapshot(malformed, 'SPY', '2026-07-19')).toThrow(
      /Invalid options analytics snapshot/,
    );
  });

  it('rejects a non-positive leg implied volatility', async () => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const firstStrike = snapshot.strikes[0];
    const malformed = {
      ...snapshot,
      strikes: [
        { ...firstStrike, call: { ...firstStrike.call!, impliedVolatility: 0 } },
        ...snapshot.strikes.slice(1),
      ],
    };

    expect(() => module.validateOptionsAnalyticsSnapshot(malformed, 'SPY', '2026-07-19')).toThrow(
      /Invalid options analytics snapshot/,
    );
  });

  it('rejects a partially nulled local model while accepting an observed-only leg', async () => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const firstStrike = snapshot.strikes[0];
    const observedOnly = {
      ...firstStrike.call!,
      impliedVolatility: null,
      delta: null,
      gamma: null,
      gammaExposure: null,
      deltaNotional: null,
    };
    const validObservedOnly = {
      ...snapshot,
      strikes: [{ ...firstStrike, call: observedOnly }, ...snapshot.strikes.slice(1)],
    };
    expect(() =>
      module.validateOptionsAnalyticsSnapshot(validObservedOnly, 'SPY', '2026-07-19'),
    ).not.toThrow();

    const malformed = {
      ...validObservedOnly,
      strikes: [
        { ...firstStrike, call: { ...observedOnly, delta: 0.5 } },
        ...snapshot.strikes.slice(1),
      ],
    };
    expect(() => module.validateOptionsAnalyticsSnapshot(malformed, 'SPY', '2026-07-19')).toThrow(
      /Invalid options analytics snapshot/,
    );
  });

  it.each([-1.01, 1.01])(
    'rejects a leg delta outside the closed unit interval: %s',
    async (delta) => {
      const module = await loadValidationModule();
      expect(module).not.toBeNull();
      if (!module) return;
      const snapshot = makeOptionsAnalyticsSnapshot();
      const firstStrike = snapshot.strikes[0];
      const malformed = {
        ...snapshot,
        strikes: [
          { ...firstStrike, call: { ...firstStrike.call!, delta } },
          ...snapshot.strikes.slice(1),
        ],
      };

      expect(() => module.validateOptionsAnalyticsSnapshot(malformed, 'SPY', '2026-07-19')).toThrow(
        /Invalid options analytics snapshot/,
      );
    },
  );

  it.each(['callWall', 'putWall', 'maxOpenInterestStrike'] as const)(
    'rejects a non-positive non-null structure %s',
    async (field) => {
      const module = await loadValidationModule();
      expect(module).not.toBeNull();
      if (!module) return;
      const snapshot = makeOptionsAnalyticsSnapshot();
      const malformed = {
        ...snapshot,
        structure: { ...snapshot.structure, [field]: 0 },
      };

      expect(() => module.validateOptionsAnalyticsSnapshot(malformed, 'SPY', '2026-07-19')).toThrow(
        /Invalid options analytics snapshot/,
      );
    },
  );

  it.each([
    ['a non-positive root', [0, 502.5]],
    ['descending roots', [502.5, 497.5]],
    ['duplicate roots', [497.5, 497.5]],
  ])('rejects proxy gammaRoots with %s', async (_label, gammaRoots) => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const proxy = snapshot.scenarios.callPutDealerProxy!;
    const malformed = {
      ...snapshot,
      scenarios: {
        callPutDealerProxy: { ...proxy, gammaRoots, primaryGammaRoot: null },
      },
    };

    expect(() => module.validateOptionsAnalyticsSnapshot(malformed, 'SPY', '2026-07-19')).toThrow(
      /Invalid options analytics snapshot/,
    );
  });

  it('rejects a non-null primary gamma root outside gammaRoots', async () => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const proxy = snapshot.scenarios.callPutDealerProxy!;
    const malformed = {
      ...snapshot,
      scenarios: {
        callPutDealerProxy: { ...proxy, primaryGammaRoot: 500 },
      },
    };

    expect(() => module.validateOptionsAnalyticsSnapshot(malformed, 'SPY', '2026-07-19')).toThrow(
      /Invalid options analytics snapshot/,
    );
  });

  it.each(['07/18/2026', '2026-13-40'])('rejects invalid OI effective date %s', async (date) => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const malformed = {
      ...snapshot,
      quality: { ...snapshot.quality, oiEffectiveDate: date },
    };

    expect(() => module.validateOptionsAnalyticsSnapshot(malformed, 'SPY', '2026-07-19')).toThrow(
      /Invalid options analytics snapshot/,
    );
  });

  it('rejects a coverage ratio that disagrees with the contract counts', async () => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const malformed = {
      ...snapshot,
      quality: {
        ...snapshot.quality,
        coverage: { contractsTotal: 10, contractsIncluded: 8, ratio: 0.79 },
      },
    };

    expect(() => module.validateOptionsAnalyticsSnapshot(malformed, 'SPY', '2026-07-19')).toThrow(
      /Invalid options analytics snapshot/,
    );
  });

  it('accepts zero coverage for an empty contract set', async () => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const emptyCoverage = {
      ...snapshot,
      quality: {
        ...snapshot.quality,
        coverage: { contractsTotal: 0, contractsIncluded: 0, ratio: 0 },
      },
    };

    expect(() =>
      module.validateOptionsAnalyticsSnapshot(emptyCoverage, 'SPY', '2026-07-19'),
    ).not.toThrow();
  });

  it('accepts coverage ratio rounding within numeric tolerance', async () => {
    const module = await loadValidationModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot();
    const roundedCoverage = {
      ...snapshot,
      quality: {
        ...snapshot.quality,
        coverage: { contractsTotal: 10, contractsIncluded: 8, ratio: 0.8000005 },
      },
    };

    expect(() =>
      module.validateOptionsAnalyticsSnapshot(roundedCoverage, 'SPY', '2026-07-19'),
    ).not.toThrow();
  });
});
