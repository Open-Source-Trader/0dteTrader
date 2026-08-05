import { describe, expect, it } from 'vitest';
import type { OptionContract } from '@0dtetrader/shared-types';
import {
  canBracketFromEntry,
  entryLineSource,
  entryLineLabel,
  entryLineStroke,
} from './entryLineStyle';

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

describe('entryLineSource — provenance decides what the line may do', () => {
  it('prefers the authoritative fill-time price when both exist', () => {
    expect(entryLineSource({ underlyingEntryPrice: 601, underlyingEntryEstimate: 600 })).toEqual({
      price: 601,
      authoritative: true,
    });
  });

  it('falls back to the estimate for display, marked non-authoritative', () => {
    expect(entryLineSource({ underlyingEntryEstimate: 600 })).toEqual({
      price: 600,
      authoritative: false,
    });
  });

  it('returns nothing when neither field exists', () => {
    expect(entryLineSource({})).toBeNull();
  });
});

describe('canBracketFromEntry', () => {
  it('allows a bracket drag only from an authoritative entry with the setting on', () => {
    expect(canBracketFromEntry({ authoritative: true }, true)).toBe(true);
  });

  it.each([
    ['an estimated entry', { authoritative: false }, true],
    ['the setting off', { authoritative: true }, false],
    ['both', { authoritative: false }, false],
  ])('refuses with %s', (_label, source, enabled) => {
    // An estimate can sit on the wrong side of the true fill level, so a
    // drag across it would classify the wrong bracket kind and move the
    // wrong OCO sibling. Estimates display and close; they never classify.
    expect(canBracketFromEntry(source as { authoritative: boolean }, enabled as boolean)).toBe(
      false,
    );
  });
});
