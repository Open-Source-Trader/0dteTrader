import { describe, expect, it } from 'vitest';
import { parseOccSymbol } from './occSymbol';

describe('parseOccSymbol', () => {
  it('parses a standard OCC symbol', () => {
    expect(parseOccSymbol('SPY260717C00503000')).toEqual({
      underlying: 'SPY',
      expiration: '2026-07-17',
      optionType: 'call',
      strike: 503,
    });
  });

  it('handles fractional strikes and puts', () => {
    expect(parseOccSymbol('QQQ261218P00482500')).toEqual({
      underlying: 'QQQ',
      expiration: '2026-12-18',
      optionType: 'put',
      strike: 482.5,
    });
  });

  it('rejects non-OCC symbols', () => {
    expect(parseOccSymbol('MESU26')).toBeNull();
    expect(parseOccSymbol('SPY')).toBeNull();
    expect(parseOccSymbol('spy260717C00503000')).toBeNull();
  });
});
