import { describe, expect, it } from 'vitest';
import { deriveMarketSessionState } from './marketSessionState';

// Wednesday, well inside regular hours in America/New_York.
const DURING_HOURS = () => new Date('2026-07-29T15:00:00.000Z'); // 11:00 ET
// Wednesday, before the open.
const BEFORE_OPEN = () => new Date('2026-07-29T12:00:00.000Z'); // 08:00 ET
// Wednesday, after the close.
const AFTER_CLOSE = () => new Date('2026-07-29T21:00:00.000Z'); // 17:00 ET
// Saturday.
const WEEKEND = () => new Date('2026-08-01T15:00:00.000Z');

describe('deriveMarketSessionState', () => {
  it('reports live during regular trading hours with fresh data', () => {
    const state = deriveMarketSessionState({
      isQuoteStreamStale: false,
      isChainStale: false,
      now: DURING_HOURS,
    });
    expect(state).toBe('live');
  });

  it('reports market-closed before the open', () => {
    const state = deriveMarketSessionState({
      isQuoteStreamStale: false,
      isChainStale: false,
      now: BEFORE_OPEN,
    });
    expect(state).toBe('market-closed');
  });

  it('reports market-closed after the close', () => {
    const state = deriveMarketSessionState({
      isQuoteStreamStale: false,
      isChainStale: false,
      now: AFTER_CLOSE,
    });
    expect(state).toBe('market-closed');
  });

  it('reports market-closed on a weekend even during would-be trading hours', () => {
    const state = deriveMarketSessionState({
      isQuoteStreamStale: false,
      isChainStale: false,
      now: WEEKEND,
    });
    expect(state).toBe('market-closed');
  });

  it('reports unavailable when the quote stream is stale, even during hours', () => {
    const state = deriveMarketSessionState({
      isQuoteStreamStale: true,
      isChainStale: false,
      now: DURING_HOURS,
    });
    expect(state).toBe('unavailable');
  });

  it('reports stale when the chain is stale but the quote stream is live', () => {
    const state = deriveMarketSessionState({
      isQuoteStreamStale: false,
      isChainStale: true,
      now: DURING_HOURS,
    });
    expect(state).toBe('stale');
  });

  it('prioritizes unavailable over stale when both apply', () => {
    const state = deriveMarketSessionState({
      isQuoteStreamStale: true,
      isChainStale: true,
      now: DURING_HOURS,
    });
    expect(state).toBe('unavailable');
  });
});
