import type { OptionsAnalyticsFeedMode, OptionsAnalyticsSnapshot } from '@0dtetrader/shared-types';
import {
  blackForwardKernel,
  computeOptionsAnalyticsSnapshot,
  findRootsOnGrid,
  impliedForwardFromPairs,
  solveImpliedVolatility,
} from './options-analytics.engine';

type OptionType = 'call' | 'put';

interface EngineContract {
  symbol: string;
  strike: number;
  optionType: OptionType;
  openInterest: number;
  volume: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  multiplier: number;
  quoteAsOf: string;
  providerGreeksAsOf: string | null;
  last: number | null;
  lastTradeAsOf: string | null;
  providerDelta: number | null;
  providerGamma: number | null;
  providerImpliedVolatility: number | null;
  oiEffectiveDate: string;
  rootSymbol: string;
}

interface EngineInput {
  symbol: string;
  rootSymbol: string;
  settlementStyle: 'am' | 'pm';
  expiration: string;
  observedAt: Date;
  settlementAt: Date;
  spot: number;
  riskFreeRate: number;
  feedMode: OptionsAnalyticsFeedMode;
  contractsTotal: number;
  contracts: EngineContract[];
  warnings?: string[];
}

const engine = {
  blackForwardKernel,
  solveImpliedVolatility,
  impliedForwardFromPairs,
  findRootsOnGrid,
  computeOptionsAnalyticsSnapshot: (input: EngineInput): OptionsAnalyticsSnapshot =>
    computeOptionsAnalyticsSnapshot(input),
};

const OBSERVED_AT = new Date('2026-07-20T14:00:00.000Z');
const SETTLEMENT_AT = new Date('2026-08-19T14:00:00.000Z');
const TIME_YEARS = 30 / 365;
const RISK_FREE_RATE = 0.04;
const DISCOUNT_FACTOR = Math.exp(-RISK_FREE_RATE * TIME_YEARS);

function quotedContract(
  optionType: OptionType,
  strike: number,
  openInterest: number,
  volatility: number,
  overrides: Partial<EngineContract> = {},
): EngineContract {
  const price = engine.blackForwardKernel(
    optionType,
    100,
    100,
    strike,
    TIME_YEARS,
    volatility,
    DISCOUNT_FACTOR,
  ).price;
  return {
    symbol: `TEST-${strike}-${optionType}`,
    strike,
    optionType,
    openInterest,
    volume: 25,
    bid: Math.max(0, price - 0.01),
    ask: price + 0.01,
    bidSize: 10,
    askSize: 12,
    multiplier: 100,
    quoteAsOf: '2026-07-20T13:59:55.000Z',
    providerGreeksAsOf: '2026-07-20T13:58:00.000Z',
    last: 2.1,
    lastTradeAsOf: '2026-07-20T13:59:54.000Z',
    providerDelta: 0.5,
    providerGamma: 0.02,
    providerImpliedVolatility: 0.2,
    oiEffectiveDate: '2026-07-17',
    rootSymbol: 'TEST',
    ...overrides,
  };
}

function completeInput(contracts: EngineContract[]): EngineInput {
  return {
    symbol: 'TEST',
    rootSymbol: 'TEST',
    settlementStyle: 'pm',
    expiration: '2026-08-19',
    observedAt: OBSERVED_AT,
    settlementAt: SETTLEMENT_AT,
    spot: 100,
    riskFreeRate: RISK_FREE_RATE,
    feedMode: 'realtime',
    contractsTotal: contracts.length,
    contracts,
  };
}

function expectAllNumbersFinite(value: unknown): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value)).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) expectAllNumbersFinite(item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) expectAllNumbersFinite(item);
  }
}

describe('options analytics pricing kernel', () => {
  it('matches a Black forward ATM golden vector and put-call parity', () => {
    const call = engine.blackForwardKernel('call', 100, 100, 100, 0.25, 0.2, 1);
    const put = engine.blackForwardKernel('put', 100, 100, 100, 0.25, 0.2, 1);

    expect(call.price).toBeCloseTo(3.98776, 4);
    expect(put.price).toBeCloseTo(3.98776, 4);
    expect(call.delta).toBeCloseTo(0.51994, 4);
    expect(put.delta).toBeCloseTo(-0.48006, 4);
    expect(call.gamma).toBeCloseTo(0.03984, 4);
    expect(call.price - put.price).toBeCloseTo(0, 10);
  });

  it('matches central finite-difference delta and gamma within numerical tolerance', () => {
    const spot = 100;
    const forwardRatio = 1.01;
    const strike = 102;
    const timeYears = 45 / 365;
    const volatility = 0.31;
    const discount = 0.995;
    const step = 0.25;
    const priceAt = (candidateSpot: number): number =>
      engine.blackForwardKernel(
        'call',
        candidateSpot,
        candidateSpot * forwardRatio,
        strike,
        timeYears,
        volatility,
        discount,
      ).price;
    const analytic = engine.blackForwardKernel(
      'call',
      spot,
      spot * forwardRatio,
      strike,
      timeYears,
      volatility,
      discount,
    );
    const finiteDelta = (priceAt(spot + step) - priceAt(spot - step)) / (2 * step);
    const finiteGamma =
      (priceAt(spot + step) - 2 * priceAt(spot) + priceAt(spot - step)) / (step * step);

    // These tolerances are intentionally tighter than displayed analytics precision.
    expect(Math.abs(analytic.delta - finiteDelta)).toBeLessThan(5e-5);
    expect(Math.abs(analytic.gamma - finiteGamma)).toBeLessThan(5e-5);
  });

  it('recovers local IV with bisection and never invents IV for an invalid price', () => {
    const target = engine.blackForwardKernel('call', 100, 100, 105, TIME_YEARS, 0.37, 1).price;

    expect(engine.solveImpliedVolatility('call', target, 100, 100, 105, TIME_YEARS, 1)).toBeCloseTo(
      0.37,
      5,
    );
    expect(engine.solveImpliedVolatility('call', -1, 100, 100, 105, TIME_YEARS, 1)).toBeNull();
  });

  it('uses the median synchronized put-call parity forward', () => {
    const pairs = [
      { strike: 95, callMid: 7, putMid: 2, forward: 100 },
      { strike: 100, callMid: 3, putMid: 2, forward: 101 },
      { strike: 105, callMid: 2, putMid: 6, forward: 101 },
    ].map(({ strike, callMid, putMid }) => ({
      strike,
      callMid,
      putMid,
      callQuoteAsOf: '2026-07-20T14:00:00.000Z',
      putQuoteAsOf: '2026-07-20T14:00:30.000Z',
    }));
    pairs.push({
      strike: 110,
      callMid: 1,
      putMid: 1,
      callQuoteAsOf: '2026-07-20T14:00:00.000Z',
      putQuoteAsOf: '2026-07-20T14:02:00.000Z',
    });

    expect(engine.impliedForwardFromPairs(pairs, 1)).toBe(101);
  });

  it('requires a finite, realistic configured risk-free rate', () => {
    const contracts = [quotedContract('call', 100, 10, 0.2), quotedContract('put', 100, 10, 0.2)];
    const input = completeInput(contracts);
    input.riskFreeRate = Number.NaN;

    expect(() => engine.computeOptionsAnalyticsSnapshot(input)).toThrow(/risk.free.rate/i);
  });

  it('supports a finite negative rate consistently through pricing and IV inversion', () => {
    const rate = -0.01;
    const discount = Math.exp(-rate * TIME_YEARS);
    const target = engine.blackForwardKernel(
      'put',
      100,
      99.9,
      100,
      TIME_YEARS,
      0.27,
      discount,
    ).price;

    expect(
      engine.solveImpliedVolatility('put', target, 100, 99.9, 100, TIME_YEARS, discount),
    ).toBeCloseTo(0.27, 5);

    const input = completeInput([
      quotedContract('call', 100, 10, 0.2),
      quotedContract('put', 100, 10, 0.2),
    ]);
    input.riskFreeRate = rate;
    expect(() => engine.computeOptionsAnalyticsSnapshot(input)).not.toThrow();
  });

  it('discloses that the configured annual risk-free rate is not a live curve', () => {
    const contracts = [quotedContract('call', 100, 10, 0.2), quotedContract('put', 100, 10, 0.2)];
    const snapshot = engine.computeOptionsAnalyticsSnapshot(completeInput(contracts));

    expect(snapshot.quality.warnings.join(' ')).toMatch(
      /configured annual risk.free rate 4\.0000%/i,
    );
    expect(snapshot.quality.warnings.join(' ')).toMatch(/not a live timestamped yield curve/i);
    expect(snapshot.quality.status).toBe('complete');
  });
});

describe('options analytics aggregation', () => {
  it('uses the 1% gamma unit and keeps unsigned facts separate from the proxy scenario', () => {
    const contracts = [quotedContract('call', 100, 10, 0.2), quotedContract('put', 100, 5, 0.2)];
    const snapshot = engine.computeOptionsAnalyticsSnapshot(completeInput(contracts));
    const strike = snapshot.strikes[0];

    expect(strike.call).not.toBeNull();
    expect(strike.put).not.toBeNull();
    expect(strike.call!.gammaExposure).toBeCloseTo(
      strike.call!.gamma! * 10 * 100 * 100 * 100 * 0.01,
      8,
    );
    const { callGammaExposure, putGammaExposure, callDeltaNotional, putDeltaNotional } =
      snapshot.structure;
    if (
      callGammaExposure === null ||
      putGammaExposure === null ||
      callDeltaNotional === null ||
      putDeltaNotional === null
    ) {
      throw new Error('Expected the golden aggregation fixture to model both option sides');
    }
    expect(callGammaExposure).toBeGreaterThan(0);
    expect(putGammaExposure).toBeGreaterThan(0);
    expect(snapshot.structure.grossGammaExposure).toBeCloseTo(
      callGammaExposure + putGammaExposure,
      8,
    );
    expect(snapshot.scenarios.callPutDealerProxy!.gammaExposure).toBeCloseTo(
      callGammaExposure - putGammaExposure,
      8,
    );
    expect(snapshot.scenarios.callPutDealerProxy!.deltaNotional).toBeCloseTo(
      callDeltaNotional + putDeltaNotional,
      8,
    );
    expect(snapshot.strikes[0]).not.toHaveProperty('callPutDealerProxyExposure');
    expect(snapshot.scenarios.callPutDealerProxy).toHaveProperty('strikeGammaExposures', [
      {
        strike: snapshot.strikes[0].strike,
        gammaExposure:
          snapshot.strikes[0].call!.gammaExposure! - snapshot.strikes[0].put!.gammaExposure!,
      },
    ]);
    expect(snapshot.exposureUnit).toBe('$ delta change per 1% underlying move');
  });

  it('scales gamma exposure and delta notional linearly for a non-100 multiplier', () => {
    const full = engine.computeOptionsAnalyticsSnapshot(
      completeInput([
        quotedContract('call', 100, 10, 0.2, { multiplier: 100 }),
        quotedContract('put', 100, 10, 0.2, { multiplier: 100 }),
      ]),
    );
    const half = engine.computeOptionsAnalyticsSnapshot(
      completeInput([
        quotedContract('call', 100, 10, 0.2, { multiplier: 50 }),
        quotedContract('put', 100, 10, 0.2, { multiplier: 50 }),
      ]),
    );

    expect(half.strikes[0].call!.gammaExposure).toBeCloseTo(
      full.strikes[0].call!.gammaExposure! * 0.5,
      10,
    );
    expect(half.strikes[0].call!.deltaNotional).toBeCloseTo(
      full.strikes[0].call!.deltaNotional! * 0.5,
      10,
    );
  });

  it('never uses provider comparison Greeks or IV in local analytics', () => {
    const localContracts = [
      quotedContract('call', 100, 10, 0.2),
      quotedContract('put', 100, 10, 0.2),
    ];
    const changedDiagnostics = localContracts.map((contract) => ({
      ...contract,
      providerDelta: contract.optionType === 'call' ? 0.99 : -0.99,
      providerGamma: 99,
      providerImpliedVolatility: 4.5,
    }));

    const baseline = engine.computeOptionsAnalyticsSnapshot(completeInput(localContracts));
    const changed = engine.computeOptionsAnalyticsSnapshot(completeInput(changedDiagnostics));

    expect(changed.strikes).toEqual(baseline.strikes);
    expect(changed.structure).toEqual(baseline.structure);
    expect(changed.scenarios).toEqual(baseline.scenarios);
  });

  it('calculates independent walls, OI concentration, implied range, marked OI and liquidity', () => {
    const contracts = [
      quotedContract('call', 95, 500, 0.22),
      quotedContract('put', 95, 20, 0.22),
      quotedContract('call', 100, 100, 0.2),
      quotedContract('put', 100, 700, 0.2),
      quotedContract('call', 105, 50, 0.24),
      quotedContract('put', 105, 50, 0.24),
    ];
    const snapshot = engine.computeOptionsAnalyticsSnapshot(completeInput(contracts));

    expect(snapshot.structure.callWall).toBe(95);
    expect(snapshot.structure.putWall).toBe(100);
    expect(snapshot.structure.maxOpenInterestStrike).toBe(100);
    expect(snapshot.structure.grossGammaConcentration).toBeGreaterThan(0);
    expect(snapshot.structure.grossGammaConcentration).toBeLessThanOrEqual(1);
    expect(snapshot.impliedRange).toMatchObject({
      confidence: 0.68,
      label: 'model-implied 68% range',
    });
    const totalVariance = snapshot.impliedRange!.atmIv ** 2 * TIME_YEARS;
    expect(snapshot.impliedRange!.lower).toBeCloseTo(
      snapshot.scope.forward * Math.exp(-totalVariance / 2 - Math.sqrt(totalVariance)),
      10,
    );
    expect(snapshot.impliedRange!.upper).toBeCloseTo(
      snapshot.scope.forward * Math.exp(-totalVariance / 2 + Math.sqrt(totalVariance)),
      10,
    );
    expect(snapshot.strikes[0].call!.markedOiValue).toBeGreaterThan(0);
    expect(snapshot.strikes[0].call!.relativeSpread).toBeGreaterThan(0);
    expect(snapshot.strikes[0].call!.roundTripCost).toBeCloseTo(2, 8);
    expect(snapshot.quality.greeksAsOf).toBe('2026-07-20T13:59:55.000Z');
    expectAllNumbersFinite(snapshot);
  });

  it('keeps valid OI and liquidity when local IV cannot be solved without using a fallback', () => {
    const contracts = [
      quotedContract('call', 100, 10, 0.2),
      quotedContract('put', 100, 10, 0.2),
      quotedContract('call', 80, 10, 0.5, { bid: 0.01, ask: 0.02 }),
    ];
    const snapshot = engine.computeOptionsAnalyticsSnapshot({
      ...completeInput(contracts),
      contractsTotal: 3,
    });

    expect(snapshot.quality.coverage).toEqual({
      contractsTotal: 3,
      contractsIncluded: 2,
      ratio: 2 / 3,
    });
    expect(snapshot.quality.status).toBe('partial');
    expect(snapshot.quality.warnings.join(' ')).toMatch(/implied volatility/i);
    expect(snapshot.strikes.map((strike) => strike.strike)).toEqual([80, 100]);
    const observedOnlyLeg = snapshot.strikes[0].call!;
    expect(observedOnlyLeg).toMatchObject({
      openInterest: 10,
      volume: 25,
      impliedVolatility: null,
      delta: null,
      gamma: null,
      gammaExposure: null,
      deltaNotional: null,
    });
    expect(observedOnlyLeg.markedOiValue).toBeGreaterThan(0);
    expect(observedOnlyLeg.relativeSpread).toBeGreaterThanOrEqual(0);
    expect(observedOnlyLeg.roundTripCost).toBeGreaterThan(0);
    expect(snapshot.strikes[0].grossGammaExposure).toBeNull();
    expect(snapshot.structure.maxOpenInterestStrike).toBe(100);
  });

  it('returns observed layers with nullable modeled structure when no local IV can be solved', () => {
    const contracts = [
      quotedContract('call', 100, 40, 0.2, { bid: 90, ask: 91 }),
      quotedContract('put', 100, 60, 0.2, { bid: 90, ask: 91 }),
    ];

    const snapshot = engine.computeOptionsAnalyticsSnapshot(completeInput(contracts));

    expect(snapshot.quality).toMatchObject({
      greeksAsOf: null,
      coverage: { contractsTotal: 2, contractsIncluded: 0, ratio: 0 },
      status: 'partial',
    });
    expect(snapshot.structure).toEqual({
      callGammaExposure: null,
      putGammaExposure: null,
      grossGammaExposure: null,
      callDeltaNotional: null,
      putDeltaNotional: null,
      callWall: null,
      putWall: null,
      grossGammaConcentration: null,
      maxOpenInterestStrike: 100,
    });
    expect(snapshot.scenarios.callPutDealerProxy).toBeNull();
    expect(snapshot.impliedRange).toBeNull();
    expect(snapshot.strikes).toHaveLength(1);
    expect(snapshot.strikes[0]).toMatchObject({
      strike: 100,
      grossGammaExposure: null,
      totalOpenInterest: 100,
      call: { openInterest: 40, impliedVolatility: null },
      put: { openInterest: 60, impliedVolatility: null },
    });
    expect(snapshot.strikes[0].call?.markedOiValue).toBeGreaterThan(0);
    expect(snapshot.strikes[0].put?.relativeSpread).toBeGreaterThan(0);
    expect(snapshot.quality.warnings.join(' ')).toMatch(
      /observed OI and liquidity remain available/i,
    );
  });

  it('rejects a zero-bid leg even when its midpoint could produce an IV', () => {
    const contracts = [
      quotedContract('call', 100, 10, 0.2),
      quotedContract('put', 100, 10, 0.2),
      quotedContract('call', 105, 10, 0.3, { bid: 0, ask: 2 }),
    ];
    const snapshot = engine.computeOptionsAnalyticsSnapshot(completeInput(contracts));

    expect(snapshot.quality.coverage.contractsIncluded).toBe(2);
    expect(snapshot.strikes.map((strike) => strike.strike)).toEqual([100]);
  });

  it('retains observed fields for every leg whose own quote midpoint cannot invert to IV', () => {
    const contracts = [
      quotedContract('call', 95, 10, 0.2),
      quotedContract('put', 95, 10, 0.2),
      quotedContract('call', 105, 10, 0.3),
      quotedContract('put', 105, 10, 0.3),
      quotedContract('call', 100, 10, 0.2, { bid: 90, ask: 91 }),
      quotedContract('call', 80, 10, 0.2, { bid: 90, ask: 91 }),
    ];
    const snapshot = engine.computeOptionsAnalyticsSnapshot(completeInput(contracts));
    expect(snapshot.strikes.find((strike) => strike.strike === 100)?.call).toMatchObject({
      impliedVolatility: null,
      openInterest: 10,
    });
    expect(snapshot.strikes.find((strike) => strike.strike === 80)?.call).toMatchObject({
      impliedVolatility: null,
      openInterest: 10,
    });
    expect(snapshot.quality.warnings.join(' ')).toMatch(/local Greeks unavailable/i);
  });

  it('bounds repeated unpriceable-contract warnings with samples and a count', () => {
    const invalid = Array.from({ length: 100 }, (_, index) =>
      quotedContract('call', 200 + index, 10, 0.2, {
        symbol: `UNPRICEABLE-${index}`,
        bid: 150,
        ask: 151,
      }),
    );
    const contracts = [
      quotedContract('call', 100, 10, 0.2),
      quotedContract('put', 100, 10, 0.2),
      ...invalid,
    ];

    const snapshot = engine.computeOptionsAnalyticsSnapshot(completeInput(contracts));

    expect(snapshot.quality.coverage.contractsIncluded).toBe(2);
    expect(snapshot.quality.warnings).toHaveLength(3);
    expect(snapshot.quality.warnings.join(' ')).toMatch(
      /Local Greeks unavailable for 100 contracts/,
    );
    expect(snapshot.quality.warnings.join(' ')).toContain('UNPRICEABLE-0');
    expect(snapshot.quality.warnings.join(' ')).not.toContain('UNPRICEABLE-99');
  });

  it('deduplicates a strike/type before coverage, aggregation, and scenario repricing', () => {
    const contracts = [
      quotedContract('call', 100, 10, 0.2, {
        symbol: 'SELECTED',
        bid: 2,
        ask: 2.02,
      }),
      quotedContract('call', 100, 10_000, 0.2, {
        symbol: 'DUPLICATE',
        bid: 1,
        ask: 2,
      }),
      quotedContract('put', 100, 5, 0.2),
    ];
    const snapshot = engine.computeOptionsAnalyticsSnapshot(completeInput(contracts));

    expect(snapshot.strikes[0].call!.openInterest).toBe(10);
    expect(snapshot.quality.coverage).toEqual({
      contractsTotal: 3,
      contractsIncluded: 2,
      ratio: 2 / 3,
    });
    expect(snapshot.quality.warnings.join(' ')).toMatch(/duplicate.*ignored/i);
  });

  it('rejects mixed option roots before any analytics are calculated', () => {
    const contracts = [
      quotedContract('call', 100, 10, 0.2, { rootSymbol: 'SPXW' }),
      quotedContract('put', 100, 10, 0.2, { rootSymbol: 'SPX' }),
    ];
    const input = completeInput(contracts);
    input.symbol = 'SPX';
    input.rootSymbol = 'SPXW';

    expect(() => engine.computeOptionsAnalyticsSnapshot(input)).toThrow(/mixed|root/i);
  });

  it('rejects a non-SPX root that does not match the underlying symbol', () => {
    const contracts = [
      quotedContract('call', 100, 10, 0.2, { rootSymbol: 'QQQ' }),
      quotedContract('put', 100, 10, 0.2, { rootSymbol: 'QQQ' }),
    ];
    const input = completeInput(contracts);
    input.symbol = 'SPY';
    input.rootSymbol = 'QQQ';

    expect(() => engine.computeOptionsAnalyticsSnapshot(input)).toThrow(/does not belong|root/i);
  });

  it('rejects an SPXW product labeled with AM settlement', () => {
    const contracts = [
      quotedContract('call', 100, 10, 0.2, { rootSymbol: 'SPXW' }),
      quotedContract('put', 100, 10, 0.2, { rootSymbol: 'SPXW' }),
    ];
    const input = completeInput(contracts);
    input.symbol = 'SPX';
    input.rootSymbol = 'SPXW';
    input.settlementStyle = 'am';

    expect(() => engine.computeOptionsAnalyticsSnapshot(input)).toThrow(/settlement style/i);
  });

  it('rejects a snapshot at or after settlement so expired contracts have no modeled life', () => {
    const contracts = [quotedContract('call', 100, 10, 0.2), quotedContract('put', 100, 10, 0.2)];
    const input = completeInput(contracts);
    input.observedAt = input.settlementAt;

    expect(() => engine.computeOptionsAnalyticsSnapshot(input)).toThrow(/expired|settlement/i);
  });
});

describe('dense-grid gamma roots', () => {
  it('returns no fabricated root when the signed proxy is identically zero', () => {
    expect(engine.findRootsOnGrid(() => 0, 80, 120, 100, 80)).toEqual({
      roots: [],
      primary: null,
    });
  });

  it('returns exact and multiple roots and chooses the one nearest spot', () => {
    const result = engine.findRootsOnGrid(
      (spot) => (spot - 90) * (spot - 100) * (spot - 110),
      80,
      120,
      102,
      80,
    );

    expect(result.roots).toEqual([90, 100, 110]);
    expect(result.primary).toBe(100);
  });

  it('interpolates a sign-change root between grid points', () => {
    const result = engine.findRootsOnGrid((spot) => spot - 100.25, 99, 102, 100, 6);

    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]).toBeCloseTo(100.25, 8);
  });

  it('bisects nonlinear sign changes to a root interval no wider than one cent', () => {
    const expected = 100.123;
    const result = engine.findRootsOnGrid((spot) => Math.exp(spot - expected) - 1, 99, 102, 100, 6);

    expect(Math.abs(result.roots[0] - expected)).toBeLessThanOrEqual(0.01);
  });
});
