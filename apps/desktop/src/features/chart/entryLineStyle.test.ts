import { describe, expect, it } from 'vitest';
import type { OptionContract } from '@0dtetrader/shared-types';
import { entryLineLabel, entryLineStroke } from './entryLineStyle';

const PALETTE = { accent: '#3b9eff', pnlNegative: '#ff3b4e' };

function contract(overrides: Partial<OptionContract> = {}): OptionContract {
  return {
    symbol: 'SPY260808C00500000',
    underlying: 'SPY',
    expiration: '2026-08-08',
    strike: 500,
    optionType: 'call',
    bid: 1,
    ask: 1.1,
    last: 1.05,
    ...overrides,
  };
}

describe('entryLineStroke', () => {
  it('strokes calls in accent blue and puts in red, regardless of P/L', () => {
    expect(entryLineStroke(contract({ optionType: 'call' }), PALETTE)).toBe(PALETTE.accent);
    expect(entryLineStroke(contract({ optionType: 'put' }), PALETTE)).toBe(PALETTE.pnlNegative);
  });
});

describe('entryLineLabel', () => {
  it('labels a contract expiring today as 0DTE', () => {
    expect(entryLineLabel(contract(), '2026-08-08')).toBe('500C 0DTE');
  });

  it('labels a later expiration with its month and day', () => {
    expect(entryLineLabel(contract({ optionType: 'put' }), '2026-08-02')).toBe('500P Aug 8');
  });

  it('keeps fractional strikes', () => {
    expect(entryLineLabel(contract({ strike: 482.5, optionType: 'put' }), '2026-08-02')).toBe(
      '482.50P Aug 8',
    );
  });

  it('falls back to the raw expiration string when it is malformed', () => {
    expect(entryLineLabel(contract({ expiration: 'perpetual' }), '2026-08-02')).toBe(
      '500C perpetual',
    );
  });
});
