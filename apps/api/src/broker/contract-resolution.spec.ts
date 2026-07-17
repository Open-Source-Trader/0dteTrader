import { OptionContract } from '@0dtetrader/shared-types';
import {
  computeMid,
  estimateBuyingPower,
  findExplicitOption,
  formatOccSymbol,
  futuresRootOf,
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

describe('resolveAutoOtm', () => {
  const contracts = chain([100, 101, 102, 103]);

  it('calls: lowest strike strictly above the last price', () => {
    expect(resolveAutoOtm(contracts, 'call', 100.4).strike).toBe(101);
    expect(resolveAutoOtm(contracts, 'call', 102.99).strike).toBe(103);
  });

  it('puts: highest strike strictly below the last price', () => {
    expect(resolveAutoOtm(contracts, 'put', 102.6).strike).toBe(102);
    expect(resolveAutoOtm(contracts, 'put', 100.01).strike).toBe(100);
  });

  it('price exactly on a strike: that strike is excluded (calls go strictly above)', () => {
    expect(resolveAutoOtm(contracts, 'call', 101).strike).toBe(102);
  });

  it('price exactly on a strike: puts go strictly below', () => {
    expect(resolveAutoOtm(contracts, 'put', 101).strike).toBe(100);
  });

  it('throws a validation error when no contract qualifies', () => {
    expect(() => resolveAutoOtm(contracts, 'call', 500)).toThrow(/No call contract/);
    expect(() => resolveAutoOtm(contracts, 'put', 1)).toThrow(/No put contract/);
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
    expect(() => pickExpiration(expirations, '2027-01-01')).toThrow(
      /not available/,
    );
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

describe('futures symbols + buying power', () => {
  it('extracts known futures roots', () => {
    expect(futuresRootOf('MESU26')).toBe('MES');
    expect(futuresRootOf('ESZ26')).toBe('ES');
    expect(futuresRootOf('CLU26')).toBe('CL');
    expect(futuresRootOf('SPY')).toBeNull();
    expect(futuresRootOf('XXXU26')).toBeNull();
  });

  it('estimates option buying power with the 100x multiplier', () => {
    expect(estimateBuyingPower('option', 'SPY260717C00503000', 2, 1.5)).toBe(300);
  });

  it('estimates futures buying power as margin rate × notional', () => {
    // MES: $5 × 6000 × 10% × 2 contracts
    expect(estimateBuyingPower('future', 'MESU26', 2, 6000)).toBe(6000);
  });
});
