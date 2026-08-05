import type { TradeHistoryEntry } from '@0dtetrader/shared-types';

type RollingHistoryIdentity = Pick<TradeHistoryEntry, 'orderId' | 'timestamp'> & {
  internalOrderId?: string;
};

/**
 * New servers provide an app-owned UUID. Keep a deterministic fallback while
 * an older API instance can still answer during a rolling deployment.
 */
export function tradeHistoryKey(entry: RollingHistoryIdentity, index: number): string {
  return entry.internalOrderId || `${entry.orderId}:${entry.timestamp}:${index}`;
}
