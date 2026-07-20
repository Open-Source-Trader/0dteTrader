import { describe, expect, it } from 'vitest';
import { optionsAnalyticsExpirationForChart } from './optionsAnalyticsSelection';

describe('TradeScreen options analytics key gating', () => {
  it('suppresses a selected expiration from the previous chain underlying', () => {
    expect(optionsAnalyticsExpirationForChart('QQQ', 'SPY', '2026-07-19')).toBeNull();
  });

  it('passes the selected expiration for the active chart underlying', () => {
    expect(optionsAnalyticsExpirationForChart('QQQ', 'QQQ', '2026-07-20')).toBe('2026-07-20');
  });
});
