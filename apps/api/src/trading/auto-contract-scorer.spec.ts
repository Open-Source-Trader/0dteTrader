import type {
  AutoScoringCandidate,
  AutoScoringPreferences,
  AutoScoringResult,
  OptionType,
} from '@0dtetrader/shared-types';
import fixtureDocument from '../../../../packages/shared-types/fixtures/auto-scoring-v1.json';
import {
  AGGRESSIVE_AUTO_SCORING_PRESET,
  CONSERVATIVE_AUTO_SCORING_PRESET,
  scoreAutoContracts,
  type AutoScoringRequest,
} from './auto-contract-scorer';

interface FixtureCase {
  id: string;
  serverTime: string;
  request: AutoScoringRequest & { classicFallbackAcknowledged: boolean };
  preferences: AutoScoringPreferences;
  candidates: Array<AutoScoringCandidate & { providerMid?: number }>;
  expected: {
    rankings: Array<{
      rank: number;
      symbol: string;
      score: number;
      summary: string;
      mid: number;
      spreadBps: number;
      premiumDollars: number;
      atmDistance: number;
      normalized: Record<string, number>;
      weighted: Record<string, number>;
    }>;
    exclusions: Array<{ symbol: string; reason: string }>;
    selectedSymbol: string | null;
    noPass: boolean;
    requiresConfirmation: boolean;
  };
}

const fixtures = fixtureDocument as unknown as {
  tolerance: number;
  cases: FixtureCase[];
};

function expectClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(fixtures.tolerance);
}

function verifyFixture(result: AutoScoringResult, expected: FixtureCase['expected']): void {
  expect(result.selectedSymbol).toBe(expected.selectedSymbol);
  expect(result.noPass).toBe(expected.noPass);
  expect(result.requiresConfirmation).toBe(expected.requiresConfirmation);
  expect(result.exclusions).toEqual(expected.exclusions);
  expect(result.rankings).toHaveLength(expected.rankings.length);
  result.rankings.forEach((ranking, index) => {
    const wanted = expected.rankings[index];
    expect(ranking.rank).toBe(wanted.rank);
    expect(ranking.candidate.symbol).toBe(wanted.symbol);
    expect(ranking.rationale.summary).toBe(wanted.summary);
    expectClose(ranking.score, wanted.score);
    expectClose(ranking.rationale.mid, wanted.mid);
    expectClose(ranking.rationale.spreadBps, wanted.spreadBps);
    expectClose(ranking.rationale.premiumDollars, wanted.premiumDollars);
    expectClose(ranking.rationale.atmDistance, wanted.atmDistance);
    for (const key of Object.keys(wanted.normalized)) {
      expectClose(
        ranking.rationale.normalized[key as keyof typeof ranking.rationale.normalized],
        wanted.normalized[key],
      );
      expectClose(
        ranking.rationale.weighted[key as keyof typeof ranking.rationale.weighted],
        wanted.weighted[key],
      );
    }
  });
}

describe('scoreAutoContracts', () => {
  it.each(fixtures.cases)('matches shared golden fixture $id', (fixture) => {
    const result = scoreAutoContracts(
      fixture.request,
      fixture.preferences,
      fixture.candidates,
      new Date(fixture.serverTime),
    );
    verifyFixture(result, fixture.expected);
    expect(result.rankedAt).toBe(fixture.serverTime);
  });

  it('is independent of candidate input ordering', () => {
    const fixture = fixtures.cases[0];
    const forward = scoreAutoContracts(
      fixture.request,
      fixture.preferences,
      fixture.candidates,
      new Date(fixture.serverTime),
    );
    const reversed = scoreAutoContracts(
      fixture.request,
      fixture.preferences,
      [...fixture.candidates].reverse(),
      new Date(fixture.serverTime),
    );
    expect(reversed).toEqual(forward);
  });

  it('publishes the exact Conservative and Aggressive numeric presets', () => {
    expect(CONSERVATIVE_AUTO_SCORING_PRESET).toEqual({
      schemaVersion: 1,
      preset: 'conservative',
      targetAbsDelta: 0.25,
      strikeRungs: 5,
      maxSpreadBps: 500,
      maxPremiumDollars: 250,
      minOpenInterest: 100,
      gammaMode: 'avoid',
      weights: { delta: 0.3, spread: 0.25, openInterest: 0.2, gamma: 0.1, iv: 0.15 },
    });
    expect(AGGRESSIVE_AUTO_SCORING_PRESET).toEqual({
      schemaVersion: 1,
      preset: 'aggressive',
      targetAbsDelta: 0.4,
      strikeRungs: 8,
      maxSpreadBps: 1000,
      maxPremiumDollars: 500,
      minOpenInterest: 25,
      gammaMode: 'seek',
      weights: { delta: 0.25, spread: 0.15, openInterest: 0.15, gamma: 0.3, iv: 0.15 },
    });
  });

  it('rejects invalid requests and preference bounds before scoring', () => {
    const fixture = fixtures.cases[0];
    expect(() =>
      scoreAutoContracts(
        { ...fixture.request, spot: Number.NaN },
        fixture.preferences,
        fixture.candidates,
        new Date(fixture.serverTime),
      ),
    ).toThrow(/spot/i);
    expect(() =>
      scoreAutoContracts(
        fixture.request,
        { ...fixture.preferences, strikeRungs: 1.5 },
        fixture.candidates,
        new Date(fixture.serverTime),
      ),
    ).toThrow(/strikeRungs/i);
    expect(() =>
      scoreAutoContracts(
        fixture.request,
        { ...fixture.preferences, weights: { ...fixture.preferences.weights, delta: 0 } },
        fixture.candidates,
        new Date('invalid'),
      ),
    ).toThrow(/server time/i);
  });

  it('chooses the option-side ATM tie and limits the window by distinct strike rungs', () => {
    const base = fixtures.cases.find((entry) => entry.id === 'symbol-tie-break')!;
    const candidates = base.candidates.map((candidate) => ({
      ...candidate,
      expiration: '2026-08-05',
      optionType: 'put' as OptionType,
    }));
    const result = scoreAutoContracts(
      { ...base.request, optionType: 'put', spot: 5997.5 },
      { ...base.preferences, strikeRungs: 0 },
      candidates,
      new Date(base.serverTime),
    );
    expect(result.rankings.map((ranking) => ranking.candidate.strike)).toEqual([5995]);
    expect(result.exclusions).toContainEqual({
      symbol: 'SPXW260805C06000000',
      reason: 'outside_strike_window',
    });
  });
});
