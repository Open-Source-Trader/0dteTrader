import { useEffect, useState } from 'react';
import type { TradeHistory, TradeHistoryEntry } from '@0dtetrader/shared-types';
import { useContainer } from '../../app/container';
import { errorMessage } from '../../core/api/ApiError';
import { NavBar } from '../../design/components/NavBar';
import { Sheet } from '../../design/components/Sheet';
import { Spinner } from '../../design/components/Spinner';
import { Format } from '../../design/format';
import { ClockIcon } from '../../design/icons';
import { orderStatusDisplayName, orderTypeDisplayName } from '../../core/models/domain';

function statusColor(status: TradeHistoryEntry['status']): string {
  switch (status) {
    case 'filled':
      return 'var(--pnl-positive)';
    case 'rejected':
      return 'var(--pnl-negative)';
    default:
      return 'var(--label-secondary)';
  }
}

function timeLabel(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return timestamp;
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Trade history sheet: every order with its fill status and realized P/L. */
export function HistoryView({ onDismiss }: { onDismiss: () => void }) {
  const { apiClient } = useContainer();
  const [history, setHistory] = useState<TradeHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    apiClient
      .orderHistory()
      .then((result) => {
        if (!cancelled) setHistory(result);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, loadKey]);

  return (
    <Sheet detent="large" onDismiss={onDismiss}>
      <div
        style={{
          background: 'var(--app-background)',
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <NavBar
          title="History"
          trailing={
            <button
              className="navbar-text-button"
              style={{
                minHeight: 44,
                minWidth: 44,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 12px',
                margin: '0 -12px 0 0',
              }}
              onClick={onDismiss}
            >
              Done
            </button>
          }
        />
        <div
          className="sheet-body hide-scrollbar"
          style={{ overflowY: 'auto', padding: '0 16px 16px' }}
        >
          {history === null && error === null ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 320,
              }}
            >
              <Spinner size={18} />
            </div>
          ) : null}

          {error !== null ? (
            <div
              className="text-secondary"
              style={{
                padding: 24,
                textAlign: 'center',
                fontSize: 'var(--fs-subheadline)',
              }}
            >
              <div>{error}</div>
              <button
                className="navbar-text-button"
                style={{ marginTop: 12, fontWeight: 600 }}
                onClick={() => {
                  setHistory(null);
                  setLoadKey((k) => k + 1);
                }}
              >
                Try Again
              </button>
            </div>
          ) : null}

          {history !== null ? (
            <>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  padding: '12px 0',
                  borderBottom: '1px solid var(--app-border)',
                  // Pin the running total above the scrolling list.
                  position: 'sticky',
                  top: 0,
                  background: 'var(--app-background)',
                  zIndex: 1,
                }}
              >
                <span className="text-secondary" style={{ fontSize: 'var(--fs-subheadline)' }}>
                  Net realized P/L
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-title3)',
                    fontWeight: 600,
                    color:
                      history.totalRealizedPnl === 0
                        ? 'var(--label-primary)'
                        : history.totalRealizedPnl > 0
                          ? 'var(--pnl-positive)'
                          : 'var(--pnl-negative)',
                  }}
                >
                  {Format.signedPrice(history.totalRealizedPnl)}
                </span>
              </div>

              {history.entries.length === 0 ? (
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    minHeight: 320,
                  }}
                >
                  <span className="text-secondary" style={{ display: 'flex' }} aria-hidden>
                    <ClockIcon size={34} />
                  </span>
                  <span style={{ fontSize: 'var(--fs-headline)', fontWeight: 600 }}>
                    No orders yet
                  </span>
                  <span
                    className="text-secondary"
                    style={{ fontSize: 'var(--fs-subheadline)', textAlign: 'center' }}
                  >
                    Filled, working, and rejected orders will appear here.
                  </span>
                </div>
              ) : (
                history.entries.map((entry: TradeHistoryEntry, index: number) => (
                  <div
                    key={entry.orderId}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      padding: '12px 0',
                      borderBottom:
                        index === history.entries.length - 1
                          ? 'none'
                          : '1px solid var(--app-border)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 'var(--fs-subheadline)',
                          fontWeight: 600,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <span
                          style={{
                            color: entry.side === 'buy' ? 'var(--buy-green)' : 'var(--sell-red)',
                          }}
                        >
                          {entry.side.toUpperCase()}
                        </span>{' '}
                        {entry.quantity} {entry.contractSymbol}
                      </span>
                      <span
                        style={{
                          fontSize: 'var(--fs-caption)',
                          fontWeight: 600,
                          flex: 'none',
                          color: statusColor(entry.status),
                        }}
                      >
                        {orderStatusDisplayName(entry.status)}
                      </span>
                    </div>
                    <div
                      className="text-secondary"
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 8,
                        fontSize: 'var(--fs-caption)',
                      }}
                    >
                      <span>
                        {orderTypeDisplayName(entry.orderType)}
                        {entry.filledPrice !== undefined
                          ? ` · filled @ ${Format.price(entry.filledPrice)}`
                          : entry.limitPrice !== undefined
                            ? ` · limit ${Format.price(entry.limitPrice)}`
                            : ''}
                        {' · '}
                        {timeLabel(entry.timestamp)}
                      </span>
                      {entry.realizedPnl !== null ? (
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontWeight: 600,
                            flex: 'none',
                            color:
                              entry.realizedPnl >= 0
                                ? 'var(--pnl-positive)'
                                : 'var(--pnl-negative)',
                          }}
                        >
                          {Format.signedPrice(entry.realizedPnl)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </>
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}
