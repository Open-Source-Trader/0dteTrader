import { OptionContract } from '@0dtetrader/shared-types';
import {
  computeMid,
  estimateBuyingPower,
  findExplicitOption,
  formatOccSymbol,
  parseOccSymbol,
  pickExpiration,
  resolveAutoOtm,
} from './contract-resolution';

function contract(strike: number, optionType: 'call' | 'put'): OptionContract {
  return {
    symbol: `SPY260717${optionType === 'call' ? 'C' : 'P'}${String(strike * 1000).padStart(8, '0')}`,
    underlying: 'SPY',
    expiration: '2026-07-17',
    strike,
    optionType,
    bid: 1,
    ask: 1.1,
    last: 1.05,
  };
}

function chain(strikes: number[]): OptionContract[] {
  return strikes.flatMap((s) => [contract(s, 'call'), contract(s, 'put')]);
}

// This expectation table is mirrored verbatim by the desktop
// (autoContractSelector.test.ts) and iOS (AutoContractSelectorTests.swift)
// selector specs — the three implementations must agree strike-for-strike.
describe('resolveAutoOtm', () => {
  const contracts = chain([100, 101, 102, 103]);

  it('steps one strike out from the ATM strike by default', () => {
    expect(resolveAutoOtm(contracts, 'call', 100.4).strike).toBe(101); // ATM 100
    expect(resolveAutoOtm(contracts, 'call', 100.6).strike).toBe(102); // ATM 101
    expect(resolveAutoOtm(contracts, 'put', 102.6).strike).toBe(102); // ATM 103
    expect(resolveAutoOtm(contracts, 'put', 102.4).strike).toBe(101); // ATM 102
  });

  it('price exactly on a strike: that strike is the ATM anchor', () => {
    expect(resolveAutoOtm(contracts, 'call', 101).strike).toBe(102);
    expect(resolveAutoOtm(contracts, 'put', 101).strike).toBe(100);
  });

  it('equidistant between strikes: the ATM anchor resolves toward the OTM side', () => {
    expect(resolveAutoOtm(contracts, 'call', 101.5).strike).toBe(103); // ATM 102
    expect(resolveAutoOtm(contracts, 'put', 101.5).strike).toBe(100); // ATM 101
  });

  it('throws a validation error when the ladder runs out', () => {
    expect(() => resolveAutoOtm(contracts, 'call', 102.99)).toThrow(/No call contract/);
    expect(() => resolveAutoOtm(contracts, 'put', 100.01)).toThrow(/No put contract/);
    expect(() => resolveAutoOtm([], 'call', 100)).toThrow(/No call contract/);
  });
});

describe('pickExpiration', () => {
  const expirations = ['2026-07-17', '2026-07-18', '2026-07-24'];

  it('defaults to the nearest expiration', () => {
    expect(pickExpiration(expirations)).toBe('2026-07-17');
    expect(pickExpiration(expirations, undefined)).toBe('2026-07-17');
  });

  it('accepts a requested expiration that exists', () => {
    expect(pickExpiration(expirations, '2026-07-24')).toBe('2026-07-24');
  });

  it('rejects an unknown expiration', () => {
    expect(() => pickExpiration(expirations, '2027-01-01')).toThrow(/not available/);
  });

  it('rejects an empty expiration list', () => {
    expect(() => pickExpiration([])).toThrow(/No expirations/);
  });
});

describe('computeMid', () => {
  it('computes (bid + ask) / 2', () => {
    expect(computeMid(10.0, 10.2)).toBeCloseTo(10.1);
    expect(computeMid(1.01, 1.02)).toBeCloseTo(1.02, 2); // rounds to cents
    expect(computeMid(503.11, 503.15)).toBeCloseTo(503.13);
  });

  it('rejects crossed/invalid spreads', () => {
    expect(() => computeMid(10.2, 10.0)).toThrow(/crossed/);
    expect(() => computeMid(0, 10)).toThrow(/crossed/);
    expect(() => computeMid(-1, 10)).toThrow(/crossed/);
  });

  it('caps the book at the shared option-price ceiling — finite operands can still overflow', () => {
    // computeMid(1e308, 1e308) survived every finiteness check on the
    // OPERANDS and returned Infinity from the sum. Bounding inputs to
    // MAX_OPTION_PRICE makes the result finite by construction.
    expect(() => computeMid(1e308, 1e308)).toThrow(/crossed|invalid/);
    expect(() => computeMid(Number.MAX_VALUE, Number.MAX_VALUE)).toThrow(/crossed|invalid/);
    expect(() => computeMid(100_000, 100_000.01)).toThrow(/crossed|invalid/);
    expect(computeMid(99_999.99, 100_000)).toBeCloseTo(100_000, 1);
  });

  it('rejects non-finite sides before doing any arithmetic', () => {
    // bid 1 / ask ∞ passed every ordering comparison and returned an
    // infinite midpoint — the one price no order should ever be sent at.
    expect(() => computeMid(1, Number.POSITIVE_INFINITY)).toThrow(/crossed|invalid/);
    expect(() => computeMid(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toThrow(
      /crossed|invalid/,
    );
    expect(() => computeMid(Number.NEGATIVE_INFINITY, 1)).toThrow(/crossed|invalid/);
    expect(() => computeMid(Number.NaN, 1)).toThrow(/crossed|invalid/);
  });
});

describe('findExplicitOption', () => {
  const contracts = chain([100, 101]);
  it('finds the matching contract', () => {
    expect(findExplicitOption(contracts, 'call', 100)?.strike).toBe(100);
    expect(findExplicitOption(contracts, 'put', 101)?.optionType).toBe('put');
  });
  it('returns undefined when absent', () => {
    expect(findExplicitOption(contracts, 'call', 105)).toBeUndefined();
  });
});

describe('OCC symbol format/parse', () => {
  it('round-trips', () => {
    const symbol = formatOccSymbol('SPY', '2026-07-17', 'call', 503);
    expect(symbol).toBe('SPY260717C00503000');
    expect(parseOccSymbol(symbol)).toEqual({
      underlying: 'SPY',
      expiration: '2026-07-17',
      optionType: 'call',
      strike: 503,
    });
  });

  it('handles fractional strikes and puts', () => {
    const symbol = formatOccSymbol('QQQ', '2026-12-18', 'put', 482.5);
    expect(parseOccSymbol(symbol)).toEqual({
      underlying: 'QQQ',
      expiration: '2026-12-18',
      optionType: 'put',
      strike: 482.5,
    });
  });

  it('rejects non-OCC symbols', () => {
    expect(parseOccSymbol('MESU26')).toBeNull();
    expect(parseOccSymbol('SPY')).toBeNull();
  });
});

describe('buying power', () => {
  it('estimates option buying power with the 100x multiplier', () => {
    expect(estimateBuyingPower(2, 1.5)).toBe(300);
  });
});
