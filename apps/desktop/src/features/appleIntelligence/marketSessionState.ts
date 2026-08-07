// Canonical spec: docs/apple-intelligence/data-contracts.md
// (MarketAnalysisState). A presentation-layer concept — "what do we tell
// the user" — not part of the Swift-facing snapshot schema, since the model
// doesn't need to know session state to interpret supplied evidence.
//
// v1 scope: regular US-equity trading hours (Mon-Fri 09:30-16:00 America/
// New_York) only. Deliberately does not account for market holidays or
// early closes — a holiday snapshot will show as "live" if captured during
// what would otherwise be regular hours. Revisit if that gap causes a real
// user-facing problem; a hardcoded holiday calendar is a maintenance
// burden not worth taking on speculatively.
import type { MarketAnalysisState } from './types';

const NY_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function isRegularTradingHours(now: Date): boolean {
  const parts = NY_TIME_FORMAT.formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');

  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const minutesSinceMidnight = hour * 60 + minute;
  return minutesSinceMidnight >= 9 * 60 + 30 && minutesSinceMidnight < 16 * 60;
}

export interface DeriveMarketSessionStateInput {
  /** Quote socket connection state — true when the live feed is down and
   * displayed prices may be frozen (ChartStoreState.isStale). */
  isQuoteStreamStale: boolean;
  /** True when the options chain hasn't refreshed within its configured
   * freshness window (AnalysisSnapshot.quality.isChainStale). */
  isChainStale: boolean;
  now?: () => Date;
}

/**
 * Pure function of connection/freshness state and the current time — no
 * network calls, no model involvement. `stale` takes priority over
 * `market-closed` when both apply, since a frozen feed is the more urgent
 * fact regardless of session (e.g. a disconnect during regular hours).
 */
export function deriveMarketSessionState(
  input: DeriveMarketSessionStateInput,
): MarketAnalysisState {
  const now = (input.now ?? (() => new Date()))();
  if (input.isQuoteStreamStale) return 'unavailable';
  if (input.isChainStale) return 'stale';
  if (!isRegularTradingHours(now)) return 'market-closed';
  return 'live';
}
