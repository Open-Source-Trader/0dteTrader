import { describe, expect, it } from 'vitest';
import { resolveEnterSelection } from './symbolSections';

describe('resolveEnterSelection', () => {
  it('selects the highlighted row even with an empty query', () => {
    // Regression: pressing Enter after arrow-keying to QQQ with nothing
    // typed used to no-op because the old guard required a typed query.
    expect(resolveEnterSelection(['SPY', 'QQQ', 'SPX'], 1, '')).toBe('QQQ');
  });

  it('selects the highlighted row when a query is typed', () => {
    expect(resolveEnterSelection(['AAPL', 'AMD'], 0, 'A')).toBe('AAPL');
  });

  it('falls back to the typed query when no row is highlighted', () => {
    expect(resolveEnterSelection([], 0, 'NFLX')).toBe('NFLX');
  });

  it('returns null when there is no highlighted row and no typed query', () => {
    expect(resolveEnterSelection([], 0, '')).toBeNull();
  });
});
