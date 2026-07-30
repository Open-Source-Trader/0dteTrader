import { describe, expect, it } from 'vitest';
import type { OptionContract, Position } from '@0dtetrader/shared-types';
import {
  calculateLongOptionExpiryBreakEven,
  selectPositionExpiryBreakEven,
  selectSelectedContractExpiryBreakEven,
} from './expiryBreakEven';

const call: OptionContract = {
  symbol: 'SPY260729C00729000',
  underlying: 'SPY',
  expiration: '2026-07-29',
  strike: 729,
  optionType: 'call',
  bid: 0.19,
  ask: 0.22,
  last: 0.21,
};

const put: OptionContract = { ...call, symbol: 'SPY260729P00729000', optionType: 'put' };

function position(contract: OptionContract, avgPrice: number, markPrice = 0.3): Position {
  return {
    symbol: contract.symbol,
    assetClass: 'option',
    quantity: 1,
    avgPrice,
    markPrice,
    unrealizedPnl: (markPrice - avgPrice) * 100,
    multiplier: 100,
  };
}

describe('expiry break-even domain logic', () => {
  it('selected long call uses strike plus premium', () => {
    expect(
      calculateLongOptionExpiryBreakEven({ strike: 729, optionType: 'call', premium: 0.21 }),
    ).toBe(729.21);
  });

  it('selected long put uses strike minus premium', () => {
    expect(
      calculateLongOptionExpiryBreakEven({ strike: 729, optionType: 'put', premium: 0.21 }),
    ).toBe(728.79);
  });

  it('uses bid, mid, ask, custom, and market estimates for selected contracts', () => {
    expect(
      selectSelectedContractExpiryBreakEven({
        contract: call,
        orderType: 'bid',
        customLimitPrice: null,
      }),
    ).toBe(729.19);
    expect(
      selectSelectedContractExpiryBreakEven({
        contract: call,
        orderType: 'mid',
        customLimitPrice: null,
      }),
    ).toBe(729.21);
    expect(
      selectSelectedContractExpiryBreakEven({
        contract: call,
        orderType: 'ask',
        customLimitPrice: null,
      }),
    ).toBe(729.22);
    expect(
      selectSelectedContractExpiryBreakEven({
        contract: call,
        orderType: 'custom',
        customLimitPrice: 0.3,
      }),
    ).toBe(729.3);
    expect(
      selectSelectedContractExpiryBreakEven({
        contract: call,
        orderType: 'market',
        customLimitPrice: null,
      }),
    ).toBe(729.22);
  });

  it('clears stale values when quotes are missing or contract is missing', () => {
    expect(
      selectSelectedContractExpiryBreakEven({
        contract: null,
        orderType: 'mid',
        customLimitPrice: null,
      }),
    ).toBeNull();
    expect(
      selectSelectedContractExpiryBreakEven({
        contract: { ...call, bid: 0, ask: 0 },
        orderType: 'mid',
        customLimitPrice: null,
      }),
    ).toBeNull();
  });

  it('open long positions use average entry and ignore mark/P&L changes', () => {
    const first = selectPositionExpiryBreakEven({
      position: position(call, 0.21, 0.29),
      contract: call,
    });
    const quoteChanged = selectPositionExpiryBreakEven({
      position: { ...position(call, 0.21, 0.5), unrealizedPnl: 29 },
      contract: { ...call, bid: 0.4, ask: 0.42 },
    });
    const avgChanged = selectPositionExpiryBreakEven({
      position: position(call, 0.25, 0.29),
      contract: call,
    });

    expect(first).toBe(729.21);
    expect(quoteChanged).toBe(729.21);
    expect(avgChanged).toBe(729.25);
  });

  it('open long puts use average entry and unsupported shorts display unavailable', () => {
    expect(selectPositionExpiryBreakEven({ position: position(put, 0.21), contract: put })).toBe(
      728.79,
    );
    expect(
      selectPositionExpiryBreakEven({
        position: { ...position(put, 0.21), quantity: -1 },
        contract: put,
      }),
    ).toBeNull();
  });
});
