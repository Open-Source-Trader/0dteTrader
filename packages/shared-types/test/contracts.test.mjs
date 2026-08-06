import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (relativePath) =>
  JSON.parse(await readFile(resolve(packageRoot, relativePath), 'utf8'));

const assertFiniteJsonNumbers = (value, path = 'root') => {
  if (typeof value === 'number') {
    assert.equal(Number.isFinite(value), true, `${path} must be finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteJsonNumbers(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertFiniteJsonNumbers(item, `${path}.${key}`);
    }
  }
};

const expectedIndicatorIds = [
  'sma',
  'ema',
  'rsi',
  'macd',
  'bollinger',
  'stochastic',
  'atr',
  'anchored_vwap',
  'supertrend',
  'keltner',
  'vpvr',
  'adx_dmi',
  'obv',
  'cci',
  'williams_r',
  'ichimoku',
  'spread',
  'top_book_imbalance',
  'tick_pressure',
  'depth_imbalance',
  'cumulative_pressure',
  'touch_depletion',
];

const expectedDefaults = {
  sma: [false, { period: 20 }],
  ema: [true, { period: 9 }],
  rsi: [false, { period: 14 }],
  macd: [false, { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }],
  bollinger: [false, { period: 20, multiplier: 2 }],
  stochastic: [false, { kPeriod: 14, kSmooth: 3, dPeriod: 3 }],
  atr: [false, { period: 14 }],
  anchored_vwap: [true, { anchorTimestamp: 0 }],
  supertrend: [false, { atrPeriod: 10, multiplier: 3 }],
  keltner: [false, { emaPeriod: 20, atrPeriod: 10, multiplier: 2 }],
  vpvr: [false, { rowCount: 24, valueAreaPercent: 70 }],
  adx_dmi: [false, { period: 14 }],
  obv: [false, {}],
  cci: [false, { period: 20 }],
  williams_r: [false, { period: 14 }],
  ichimoku: [false, { conversionPeriod: 9, basePeriod: 26, spanBPeriod: 52, displacement: 26 }],
  spread: [false, {}],
  top_book_imbalance: [false, {}],
  tick_pressure: [false, {}],
  depth_imbalance: [false, { levels: 5 }],
  cumulative_pressure: [false, { levels: 5 }],
  touch_depletion: [false, {}],
};

test('registry v1 contains the exact indicator ids and defaults', async () => {
  const registry = await readJson('indicator-registry.json');
  assert.equal(registry.version, 1);
  assert.equal(registry.maxSubPanes, 2);
  assert.equal(registry.paneLimitMessage, 'You can display up to 2 indicator panes.');
  assert.deepEqual(
    registry.indicators.map(({ id }) => id),
    expectedIndicatorIds,
  );
  assert.equal(
    registry.indicators.some(({ id }) => id === 'volume'),
    false,
  );

  for (const descriptor of registry.indicators) {
    const [enabled, parameters] = expectedDefaults[descriptor.id];
    assert.equal(descriptor.defaultSettings.enabled, enabled, descriptor.id);
    assert.deepEqual(descriptor.defaultSettings.parameters, parameters, descriptor.id);
  }
});

test('registry descriptors have typed bounded parameters and valid style references', async () => {
  const registry = await readJson('indicator-registry.json');
  const geometryKinds = new Set();

  for (const descriptor of registry.indicators) {
    assert.match(descriptor.displayName, /\S/);
    assert.ok(['overlay', 'subpane'].includes(descriptor.pane), descriptor.id);
    assert.equal(typeof descriptor.requiresL2, 'boolean', descriptor.id);
    assert.equal(typeof descriptor.parameters, 'object', descriptor.id);
    assert.equal(Array.isArray(descriptor.parameters), false, descriptor.id);
    assert.equal(typeof descriptor.styleTokens, 'object', descriptor.id);
    assert.equal(Array.isArray(descriptor.styleTokens), false, descriptor.id);
    geometryKinds.add(descriptor.geometry.kind);

    for (const [parameterId, parameter] of Object.entries(descriptor.parameters)) {
      assert.equal(parameter.id, parameterId, `${descriptor.id}.${parameterId}`);
      assert.ok(['integer', 'number', 'timestamp'].includes(parameter.kind));
      assert.equal(Number.isFinite(parameter.minimum), true);
      assert.equal(Number.isFinite(parameter.maximum), true);
      assert.ok(parameter.minimum <= parameter.default);
      assert.ok(parameter.default <= parameter.maximum);
      if (parameter.kind === 'integer') assert.equal(Number.isInteger(parameter.default), true);
    }

    for (const series of descriptor.geometry.series ?? []) {
      assert.ok(
        Object.values(descriptor.styleTokens).includes(series.styleToken),
        `${descriptor.id}.${series.id} references an undeclared style token`,
      );
    }
  }

  assert.deepEqual([...geometryKinds].sort(), [
    'band',
    'cloud',
    'histogram',
    'line',
    'multi_line',
    'price_profile',
    'segmented_line',
  ]);

  for (const id of [
    'spread',
    'top_book_imbalance',
    'tick_pressure',
    'depth_imbalance',
    'cumulative_pressure',
    'touch_depletion',
  ]) {
    const descriptor = registry.indicators.find((candidate) => candidate.id === id);
    assert.equal(descriptor.pane, 'subpane');
    assert.equal(descriptor.requiresL2, true);
  }

  for (const id of ['depth_imbalance', 'cumulative_pressure']) {
    const levels = registry.indicators.find((candidate) => candidate.id === id).parameters.levels;
    assert.deepEqual(
      {
        kind: levels.kind,
        minimum: levels.minimum,
        maximum: levels.maximum,
        default: levels.default,
      },
      { kind: 'integer', minimum: 1, maximum: 50, default: 5 },
    );
  }
  assert.deepEqual(registry.indicators.find(({ id }) => id === 'tick_pressure').parameters, {});
  assert.deepEqual(registry.indicators.find(({ id }) => id === 'macd').constraints, [
    {
      kind: 'less_than',
      left: 'fastPeriod',
      right: 'slowPeriod',
      message: 'Fast period must be less than slow period.',
    },
  ]);

  for (const descriptor of registry.indicators) {
    for (const [parameterId, parameter] of Object.entries(descriptor.parameters)) {
      if (parameterId === 'anchorTimestamp') {
        assert.deepEqual([parameter.minimum, parameter.maximum], [0, 8640000000000000]);
      } else if (parameterId === 'multiplier') {
        assert.deepEqual([parameter.minimum, parameter.maximum], [0.1, 20]);
      } else if (parameterId === 'rowCount') {
        assert.deepEqual([parameter.minimum, parameter.maximum], [4, 200]);
      } else if (parameterId === 'valueAreaPercent') {
        assert.deepEqual([parameter.minimum, parameter.maximum], [1, 100]);
      } else if (parameterId === 'levels') {
        assert.deepEqual([parameter.minimum, parameter.maximum], [1, 50]);
      } else {
        assert.deepEqual([parameter.minimum, parameter.maximum], [1, 500]);
      }
    }
  }
});

test('indicator parity fixture covers every chart indicator and exact edge-case families', async () => {
  const fixture = await readJson('fixtures/indicator-parity-v1.json');
  const registry = await readJson('indicator-registry.json');
  const expectedKindById = new Map(
    registry.indicators.slice(0, 16).map(({ id, geometry }) => [id, geometry.kind]),
  );
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.tolerance, 1e-6);
  assert.deepEqual(
    [...new Set(fixture.indicatorCases.map(({ indicatorId }) => indicatorId))].sort(),
    expectedIndicatorIds.slice(0, 16).sort(),
  );
  for (const fixtureCase of fixture.indicatorCases) {
    const candles = fixture.candleSets[fixtureCase.candleSetId];
    const descriptor = registry.indicators.find(({ id }) => id === fixtureCase.indicatorId);
    assert.ok(candles.length > 0, fixtureCase.id);
    assert.equal(
      candles.every(
        ({ timestamp }, index) => index === 0 || timestamp > candles[index - 1].timestamp,
      ),
      true,
      fixtureCase.id,
    );
    assert.equal(fixtureCase.expected.kind, expectedKindById.get(fixtureCase.indicatorId));
    assert.deepEqual(
      Object.keys(fixtureCase.parameters).sort(),
      Object.keys(descriptor.parameters).sort(),
      `${fixtureCase.id} parameter keys`,
    );
    for (const candle of candles) {
      assert.equal(
        [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite),
        true,
        fixtureCase.id,
      );
      assert.ok(candle.high >= Math.max(candle.open, candle.close, candle.low), fixtureCase.id);
      assert.ok(candle.low <= Math.min(candle.open, candle.close, candle.high), fixtureCase.id);
      assert.ok(candle.volume >= 0, fixtureCase.id);
    }
    if (fixtureCase.expected.kind === 'price_profile') {
      assert.ok(fixtureCase.expected.rows.length > 0, fixtureCase.id);
      for (const row of fixtureCase.expected.rows) {
        assert.equal([row.low, row.high, row.volume].every(Number.isFinite), true, fixtureCase.id);
        assert.ok(row.high >= row.low, fixtureCase.id);
        assert.ok(row.volume >= 0, fixtureCase.id);
        assert.equal(typeof row.inValueArea, 'boolean', fixtureCase.id);
      }
    } else {
      assert.equal(typeof fixtureCase.expected.series, 'object', fixtureCase.id);
      assert.deepEqual(
        Object.keys(fixtureCase.expected.series).sort(),
        descriptor.geometry.series.map(({ id }) => id).sort(),
        `${fixtureCase.id} expected series keys`,
      );
      for (const values of Object.values(fixtureCase.expected.series)) {
        assert.equal(values.length, candles.length, fixtureCase.id);
        assert.equal(
          values.every((value) => value === null || Number.isFinite(value)),
          true,
          fixtureCase.id,
        );
      }
    }
  }
  assertFiniteJsonNumbers(fixture, 'indicatorFixture');
  const requiredEdgeCases = [
    'anchored-vwap-user-anchor',
    'anchored-vwap-zero-volume',
    'supertrend-direction-flips',
    'vpvr-equal-range',
    'adx-dmi-warmup',
    'obv-down-and-equal',
    'cci-zero-deviation',
    'williams-r-zero-range',
    'ichimoku-warmup-displacement',
  ];
  for (const id of requiredEdgeCases) {
    assert.ok(
      fixture.indicatorCases.some((fixtureCase) => fixtureCase.id === id),
      id,
    );
  }
  assert.deepEqual(
    fixture.l2Cases.map(({ id }) => id),
    ['balanced-book', 'cumulative-buy-pressure', 'crossed-book', 'empty-side', 'partial-depth'],
  );
  const balancedBook = fixture.l2Cases.find(({ id }) => id === 'balanced-book');
  assert.equal(Array.isArray(balancedBook.priorDepthHistory), true);
  assert.equal('depthHistory' in balancedBook, false);
  assert.equal(balancedBook.expected.cumulativePressure, 0);
  assert.notEqual(
    fixture.l2Cases.find(({ id }) => id === 'cumulative-buy-pressure').expected.cumulativePressure,
    0,
  );
  for (const fixtureCase of fixture.l2Cases) {
    assert.ok(Number.isInteger(fixtureCase.levels) && fixtureCase.levels >= 1);
    for (const side of ['bids', 'asks']) {
      for (const level of fixtureCase.book[side]) {
        assert.ok(Number.isFinite(level.price) && level.price > 0, fixtureCase.id);
        assert.ok(Number.isFinite(level.size) && level.size >= 0, fixtureCase.id);
      }
    }
    for (const value of Object.values(fixtureCase.expected)) {
      assert.ok(
        value === null || ['boolean', 'string'].includes(typeof value) || Number.isFinite(value),
        fixtureCase.id,
      );
    }
  }
  assert.deepEqual(
    fixture.atmIvCases.map(({ id }) => id),
    [
      'exact-paired-strike',
      'interpolated-paired-strikes',
      'unsorted-paired-strikes',
      'missing-leg',
      'no-bracket',
    ],
  );
  for (const fixtureCase of fixture.atmIvCases) {
    assert.ok(Number.isFinite(fixtureCase.spot) && fixtureCase.spot > 0, fixtureCase.id);
    assert.ok(fixtureCase.strikes.length > 0, fixtureCase.id);
    for (const strike of fixtureCase.strikes) {
      assert.ok(Number.isFinite(strike.strike) && strike.strike > 0, fixtureCase.id);
      assert.ok(strike.callIv === null || (Number.isFinite(strike.callIv) && strike.callIv >= 0));
      assert.ok(strike.putIv === null || (Number.isFinite(strike.putIv) && strike.putIv >= 0));
    }
    assert.ok(
      fixtureCase.expectedAtmIv === null ||
        (Number.isFinite(fixtureCase.expectedAtmIv) && fixtureCase.expectedAtmIv >= 0),
      fixtureCase.id,
    );
  }
});

test('auto scoring fixture encodes rankings, exclusions, no-pass, and deterministic ties', async () => {
  const fixture = await readJson('fixtures/auto-scoring-v1.json');
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.tolerance, 1e-6);
  assert.match(fixture.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    fixture.cases.map(({ id }) => id),
    [
      'weighted-ranking',
      'put-absolute-delta-gamma-seek',
      'hard-filter-exclusions',
      'tie-break-spread',
      'tie-break-open-interest',
      'tie-break-atm-distance',
      'symbol-tie-break',
      'exclusion-reason-matrix',
      'no-pass',
    ],
  );

  const ranking = fixture.cases[0];
  assert.equal(ranking.preferences.schemaVersion, 1);
  assert.deepEqual(
    ranking.expected.rankings.map(({ symbol }) => symbol),
    ['SPXW260805C06000000', 'SPXW260805C06005000'],
  );
  assert.equal(ranking.expected.rankings[0].score, 0.55);
  assert.equal(ranking.expected.rankings[1].score, 0.45);
  assert.equal(ranking.candidates[0].providerMid, 999);
  assert.equal(
    ranking.expected.rankings[0].mid,
    (ranking.candidates[0].bid + ranking.candidates[0].ask) / 2,
  );
  assert.notEqual(ranking.expected.rankings[0].mid, ranking.candidates[0].providerMid);
  for (const ranked of ranking.expected.rankings) {
    assert.match(ranked.summary, /\S/);
    assert.equal(Number.isFinite(ranked.premiumDollars), true);
    assert.equal(Number.isFinite(ranked.atmDistance), true);
    assert.deepEqual(Object.keys(ranked.normalized).sort(), [
      'delta',
      'gamma',
      'iv',
      'openInterest',
      'spread',
    ]);
    assert.deepEqual(Object.keys(ranked.weighted).sort(), Object.keys(ranked.normalized).sort());
  }
  assert.deepEqual(
    ranking.expected.exclusions.map(({ symbol, reason }) => [symbol, reason]),
    [
      ['SPXW260805C06010000', 'spread_too_wide'],
      ['SPXW260805C06015000', 'missing_gamma'],
      ['SPXW260805C06020000', 'stale_quote'],
    ],
  );
  const putCase = fixture.cases.find(({ id }) => id === 'put-absolute-delta-gamma-seek');
  assert.equal(putCase.candidates[0].delta < 0, true);
  assert.equal(Math.abs(putCase.candidates[0].delta), putCase.preferences.targetAbsDelta);
  assert.equal(putCase.preferences.gammaMode, 'seek');
  assert.ok(Math.abs(putCase.candidates[0].gamma) > Math.abs(putCase.candidates[1].gamma));
  assert.equal(putCase.expected.rankings[0].symbol, putCase.candidates[0].symbol);

  const hardFilters = fixture.cases.find(({ id }) => id === 'hard-filter-exclusions');
  assert.deepEqual(hardFilters.expected.exclusions.map(({ reason }) => reason).sort(), [
    'outside_strike_window',
    'premium_too_high',
  ]);
  assert.equal(
    fixture.cases.find(({ id }) => id === 'tie-break-spread').expected.rankings[0].symbol,
    'SPXW260805C06000000',
  );
  assert.equal(
    fixture.cases.find(({ id }) => id === 'tie-break-open-interest').expected.rankings[0].symbol,
    'SPXW260805C06005000',
  );
  assert.equal(
    fixture.cases.find(({ id }) => id === 'tie-break-atm-distance').expected.rankings[0].symbol,
    'SPXW260805C06000000',
  );
  assert.equal(
    fixture.cases.find(({ id }) => id === 'symbol-tie-break').expected.rankings[0].symbol,
    'SPXW260805C05995000',
  );
  const noPass = fixture.cases.find(({ id }) => id === 'no-pass');
  assert.equal(noPass.expected.rankings.length, 0);
  assert.equal(noPass.expected.noPass, true);

  const declarations = await readFile(resolve(packageRoot, 'dist/index.d.ts'), 'utf8');
  const exclusionUnion = declarations.match(/export type AutoScoringExclusionReason =([\s\S]*?);/);
  assert.ok(exclusionUnion, 'AutoScoringExclusionReason declaration');
  const contractReasons = [...exclusionUnion[1].matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
    .sort();
  const observedReasons = [
    ...new Set(
      fixture.cases.flatMap(({ expected }) => expected.exclusions.map(({ reason }) => reason)),
    ),
  ].sort();
  assert.deepEqual(observedReasons, contractReasons);

  const reasonMatrix = fixture.cases.find(({ id }) => id === 'exclusion-reason-matrix');
  const matrixCandidates = new Map(
    reasonMatrix.candidates.map((candidate) => [candidate.symbol, candidate]),
  );
  const candidateFor = (reason) => {
    const exclusion = reasonMatrix.expected.exclusions.find((entry) => entry.reason === reason);
    assert.ok(exclusion, reason);
    return matrixCandidates.get(exclusion.symbol);
  };
  assert.notEqual(candidateFor('wrong_expiration').expiration, reasonMatrix.request.expiration);
  assert.notEqual(candidateFor('wrong_option_type').optionType, reasonMatrix.request.optionType);
  assert.equal(candidateFor('missing_quote').bid, null);
  assert.ok(candidateFor('invalid_quote').ask < candidateFor('invalid_quote').bid);
  assert.ok(
    Date.parse(candidateFor('future_quote').quoteTimestamp) - Date.parse(reasonMatrix.serverTime) >
      2_000,
  );
  assert.equal(candidateFor('missing_delta').delta, null);
  assert.equal(candidateFor('missing_iv').impliedVolatility, null);
  assert.equal(candidateFor('missing_open_interest').openInterest, null);
  assert.ok(
    Date.parse(reasonMatrix.serverTime) -
      Date.parse(candidateFor('stale_analytics').analyticsTimestamp) >
      60_000,
  );
  assert.ok(Math.abs(candidateFor('delta_out_of_range').delta) > 1);

  for (const fixtureCase of fixture.cases) {
    assert.match(fixtureCase.serverTime, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(fixtureCase.preferences.schemaVersion, 1, fixtureCase.id);
    assert.ok(fixtureCase.candidates.length > 0, fixtureCase.id);
    for (const candidate of fixtureCase.candidates) {
      assert.equal(typeof candidate.symbol, 'string', fixtureCase.id);
      for (const field of [
        'strike',
        'bid',
        'ask',
        'delta',
        'gamma',
        'impliedVolatility',
        'openInterest',
      ]) {
        assert.ok(
          candidate[field] === null || Number.isFinite(candidate[field]),
          `${fixtureCase.id}.${field}`,
        );
      }
    }
    for (const exclusion of fixtureCase.expected.exclusions) {
      assert.equal(typeof exclusion.symbol, 'string', fixtureCase.id);
      assert.match(exclusion.reason, /\S/, fixtureCase.id);
    }
    for (const ranked of fixtureCase.expected.rankings) {
      assert.match(ranked.summary, /\S/, fixtureCase.id);
      for (const field of ['rank', 'score', 'mid', 'spreadBps', 'premiumDollars', 'atmDistance']) {
        assert.equal(Number.isFinite(ranked[field]), true, `${fixtureCase.id}.${field}`);
      }
      assert.ok(ranked.rank >= 1 && Number.isInteger(ranked.rank), fixtureCase.id);
      assert.ok(ranked.score >= 0 && ranked.score <= 1, fixtureCase.id);
      const dimensions = ['delta', 'spread', 'openInterest', 'gamma', 'iv'];
      assert.deepEqual(Object.keys(ranked.normalized).sort(), [...dimensions].sort());
      assert.deepEqual(Object.keys(ranked.weighted).sort(), [...dimensions].sort());
      for (const dimension of dimensions) {
        assert.ok(
          ranked.normalized[dimension] >= 0 && ranked.normalized[dimension] <= 1,
          `${fixtureCase.id}.${dimension}.normalized`,
        );
        assert.ok(
          ranked.weighted[dimension] >= 0 && ranked.weighted[dimension] <= 1,
          `${fixtureCase.id}.${dimension}.weighted`,
        );
      }
      const contributionTotal = Object.values(ranked.weighted).reduce(
        (sum, value) => sum + value,
        0,
      );
      assert.ok(Math.abs(contributionTotal - ranked.score) <= fixture.tolerance, fixtureCase.id);
    }
    assert.equal(
      fixtureCase.expected.selectedSymbol,
      fixtureCase.expected.rankings[0]?.symbol ?? null,
      fixtureCase.id,
    );
  }
  assertFiniteJsonNumbers(fixture, 'autoFixture');
});

test('compiled declaration surface exposes indicator, L2, IV, and Auto contracts', async () => {
  const declarations = await readFile(resolve(packageRoot, 'dist/index.d.ts'), 'utf8');
  const requiredDeclarations = [
    "SelectionMode = 'auto_otm' | 'auto_scored' | 'explicit'",
    'interface IndicatorRegistry',
    'type IndicatorGeometryDescriptor',
    'type IndicatorGeometry =',
    'interface OrderBookSnapshot',
    'interface StreamL2SubscribeMessage',
    'interface StreamL2StatusMessage',
    'interface StreamL2SnapshotMessage',
    'interface IVAlertConfiguration',
    'interface StreamIVAlertConfigureMessage',
    'interface StreamIVAlertMessage',
    'interface AutoScoringPreferences',
    'interface AutoScoringPreferenceCreate',
    'interface AutoScoringPreferenceUpdate',
    'interface AutoScoringCandidate',
    'type AutoScoringResult =',
    'expectedUpdatedAt: string',
    'deltaWeight: number',
    'ivWeight: number',
  ];
  for (const declaration of requiredDeclarations) {
    assert.ok(declarations.includes(declaration), `missing declaration: ${declaration}`);
  }

  const orderBookBlock = declarations.slice(
    declarations.indexOf('export interface OrderBookSnapshot'),
    declarations.indexOf('export interface FreshOrderBookSnapshot'),
  );
  for (const field of ['timestamp: string', 'receivedAt: string', 'depth: number']) {
    assert.ok(orderBookBlock.includes(field), `missing OrderBookSnapshot field: ${field}`);
  }
  for (const oldField of [
    'sourceTimestamp',
    'receivedTimestamp',
    'serverReceivedTimestamp',
    'publishedDepth',
  ]) {
    assert.equal(
      orderBookBlock.includes(oldField),
      false,
      `obsolete OrderBookSnapshot field: ${oldField}`,
    );
  }

  const l2SnapshotBlock = declarations.slice(
    declarations.indexOf('export interface StreamL2SnapshotMessage'),
    declarations.indexOf('export interface StreamL2StatusMessage'),
  );
  assert.ok(l2SnapshotBlock.includes("type: 'l2Snapshot'"));
  assert.equal(declarations.includes("type: 'l2Data'"), false);
  assert.equal(declarations.includes('interface StreamL2DataMessage'), false);

  const ivAlertBlock = declarations.slice(
    declarations.indexOf('export interface IVAlert {'),
    declarations.indexOf('export interface Credentials'),
  );
  for (const field of [
    'currentIv: number',
    'baselineIv: number',
    'zScore: number',
    'timestamp: string',
  ]) {
    assert.ok(ivAlertBlock.includes(field), `missing IVAlert field: ${field}`);
  }
  for (const oldField of ['atmIv:', 'baseline:', 'score:', 'observedAt:']) {
    assert.equal(ivAlertBlock.includes(oldField), false, `obsolete IVAlert field: ${oldField}`);
  }
});

test('OptionContract exposes optional scorer analytics without invalidating classic contracts', async () => {
  const declarations = await readFile(resolve(packageRoot, 'dist/index.d.ts'), 'utf8');
  const optionContractStart = declarations.indexOf('export interface OptionContract');
  const optionContractEnd = declarations.indexOf(
    'export interface OptionsChain',
    optionContractStart,
  );
  const optionContract = declarations.slice(optionContractStart, optionContractEnd);
  for (const field of [
    'volume?: number',
    'openInterest?: number',
    'impliedVolatility?: number',
    'delta?: number',
    'gamma?: number',
    'quoteTimestamp?: string',
    'analyticsTimestamp?: string',
    'quoteProvider?: BrokerProvider',
  ]) {
    assert.ok(optionContract.includes(field), `missing optional OptionContract field: ${field}`);
  }
  assert.ok(optionContract.includes('bid: number'));
  assert.ok(optionContract.includes('ask: number'));
  assert.ok(optionContract.includes('last: number'));
});
