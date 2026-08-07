import { describe, expect, it } from 'vitest';
import { isResultCurrent } from './stalenessGate';
import type { AnalysisContextIdentity } from './types';

function context(overrides: Partial<AnalysisContextIdentity> = {}): AnalysisContextIdentity {
  return {
    symbol: 'SPY',
    timeframe: '5m',
    snapshotSequence: 1,
    positionVersion: 0,
    ...overrides,
  };
}

describe('isResultCurrent', () => {
  it('is current when every identity field matches', () => {
    expect(isResultCurrent(context(), context())).toBe(true);
  });

  it('is stale when the symbol changed (user switched tickers)', () => {
    expect(isResultCurrent(context({ symbol: 'SPY' }), context({ symbol: 'QQQ' }))).toBe(false);
  });

  it('is stale when a newer snapshot sequence has since been captured', () => {
    expect(
      isResultCurrent(context({ snapshotSequence: 1 }), context({ snapshotSequence: 2 })),
    ).toBe(false);
  });

  it('is stale when the position version changed underneath the result', () => {
    expect(isResultCurrent(context({ positionVersion: 0 }), context({ positionVersion: 1 }))).toBe(
      false,
    );
  });

  it('is stale when the strategy policy version changed', () => {
    expect(
      isResultCurrent(context({ strategyPolicyVersion: 1 }), context({ strategyPolicyVersion: 2 })),
    ).toBe(false);
  });

  it('is stale when the selected contract changed', () => {
    expect(
      isResultCurrent(
        context({ selectedContractSymbol: 'SPY260101C00580000' }),
        context({ selectedContractSymbol: 'SPY260101C00590000' }),
      ),
    ).toBe(false);
  });

  it('is stale when the timeframe changed', () => {
    expect(isResultCurrent(context({ timeframe: '5m' }), context({ timeframe: '1m' }))).toBe(false);
  });
});
