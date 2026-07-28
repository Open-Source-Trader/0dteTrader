import { describe, expect, it } from 'vitest';
import type { OptionContract, Position } from '@0dtetrader/shared-types';
import { positionsForUnderlying } from './positionsForUnderlying';

function contract(overrides: Partial<OptionContract> = {}): OptionContract {
  return {
    symbol: 'SPY250725C00450000',
    underlying: 'SPY',
    expiration: '2025-07-25',
    strike: 450,
    optionType: 'call',
    bid: 1,
    ask: 1.1,
    last: 1.05,
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    symbol: 'SPY250725C00450000',
    assetClass: 'option',
    quantity: 1,
    avgPrice: 1.05,
    markPrice: 1.1,
    unrealizedPnl: 5,
    multiplier: 100,
    ...overrides,
  };
}

describe('positionsForUnderlying', () => {
  it('keeps positions whose contract underlying matches the chart symbol', () => {
    const spyPosition = position({ symbol: 'SPY250725C00450000' });
    const qqqPosition = position({ symbol: 'QQQ250725P00380000' });
    const contracts = [
      contract({ symbol: 'SPY250725C00450000', underlying: 'SPY' }),
      contract({ symbol: 'QQQ250725P00380000', underlying: 'QQQ', optionType: 'put', strike: 380 }),
    ];

    expect(positionsForUnderlying([spyPosition, qqqPosition], 'SPY', contracts)).toEqual([
      spyPosition,
    ]);
  });

  it('drops a position whose contract is not present in the loaded chain', () => {
    const orphanPosition = position({ symbol: 'IWM250725C00200000' });
    expect(positionsForUnderlying([orphanPosition], 'SPY', [])).toEqual([]);
  });

  it('returns an empty array when there are no positions', () => {
    expect(positionsForUnderlying([], 'SPY', [contract()])).toEqual([]);
  });
});
