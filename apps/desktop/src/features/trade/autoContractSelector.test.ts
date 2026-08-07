import { describe, expect, it } from 'vitest';
import type { OptionContract, OptionType, OptionsChain } from '@0dtetrader/shared-types';
import { selectAutoOTM } from './autoContractSelector';

const EXPIRATION = '2099-01-15';

function contract(strike: number, optionType: OptionType): OptionContract {
  return {
    symbol: `SPY990115${optionType === 'call' ? 'C' : 'P'}${String(strike * 1000).padStart(8, '0')}`,
    underlying: 'SPY',
    expiration: EXPIRATION,
    strike,
    optionType,
    bid: 1,
    ask: 1.1,
    last: 1.05,
  };
}

function chain(strikes: number[]): OptionsChain {
  return {
    underlying: 'SPY',
    underlyingPrice: 500,
    expirations: [EXPIRATION],
    contracts: strikes.flatMap((s) => [contract(s, 'call'), contract(s, 'put')]),
  };
}

// This expectation table mirrors the server's resolveAutoOtm spec
// (apps/api/src/broker/contract-resolution.spec.ts) verbatim — the desktop and
// server selectors must agree strike-for-strike.
describe('selectAutoOTM', () => {
  const CHAIN = chain([100, 101, 102, 103]);

  it('steps one strike out from the ATM strike by default', () => {
    expect(selectAutoOTM(CHAIN, 'call', EXPIRATION, 100.4)?.strike).toBe(101); // ATM 100
    expect(selectAutoOTM(CHAIN, 'call', EXPIRATION, 100.6)?.strike).toBe(102); // ATM 101
    expect(selectAutoOTM(CHAIN, 'put', EXPIRATION, 102.6)?.strike).toBe(102); // ATM 103
    expect(selectAutoOTM(CHAIN, 'put', EXPIRATION, 102.4)?.strike).toBe(101); // ATM 102
  });

  it('price exactly on a strike: that strike is the ATM anchor', () => {
    expect(selectAutoOTM(CHAIN, 'call', EXPIRATION, 101)?.strike).toBe(102);
    expect(selectAutoOTM(CHAIN, 'put', EXPIRATION, 101)?.strike).toBe(100);
  });

  it('equidistant between strikes: the ATM anchor resolves toward the OTM side', () => {
    expect(selectAutoOTM(CHAIN, 'call', EXPIRATION, 101.5)?.strike).toBe(103); // ATM 102
    expect(selectAutoOTM(CHAIN, 'put', EXPIRATION, 101.5)?.strike).toBe(100); // ATM 101
  });

  it('returns null when the ladder runs out', () => {
    expect(selectAutoOTM(CHAIN, 'call', EXPIRATION, 102.99)).toBeNull();
    expect(selectAutoOTM(CHAIN, 'put', EXPIRATION, 100.01)).toBeNull();
    expect(selectAutoOTM(chain([]), 'call', EXPIRATION, 100)).toBeNull();
  });

  it('picks the selected option type at the resolved strike', () => {
    expect(selectAutoOTM(CHAIN, 'call', EXPIRATION, 100.4)?.optionType).toBe('call');
    expect(selectAutoOTM(CHAIN, 'put', EXPIRATION, 102.4)?.optionType).toBe('put');
  });
});
