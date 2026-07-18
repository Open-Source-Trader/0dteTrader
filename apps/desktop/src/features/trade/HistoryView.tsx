import { useEffect, useState } from 'react';
import type { TradeHistory, TradeHistoryEntry } from '@0dtetrader/shared-types';
import { useContainer } from '../../app/container';
import { errorMessage } from '../../core/api/ApiError';
import { NavBar } from '../../design/components/NavBar';
import { Sheet } from '../../design/components/Sheet';
import { Spinner } from '../../design/components/Spinner';
import { Format } from '../../design/format';
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

  useEffect(() => {
    let cancelled = false;
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
  }, [apiClient]);

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
            <button className="navbar-text-button" onClick={onDismiss}>
              Done
            </button>
          }
        />
        <div className="sheet-body hide-scrollbar" style={{ overflowY: 'auto', padding: '0 16px 16px' }}>
          {history === null && error === null ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
              <Spinner size={18} />
            </div>
          ) : null}

          {error !== null ? (
            <div className="text-secondary" style={{ padding: 24, textAlign: 'center' }}>
              {error}
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
                      history.totalRealizedPnl >= 0
                        ? 'var(--pnl-positive)'
                        : 'var(--pnl-negative)',
                  }}
                >
                  {Format.signedPrice(history.totalRealizedPnl)}
                </span>
              </div>

              {history.entries.length === 0 ? (
                <div className="text-secondary" style={{ padding: 24, textAlign: 'center' }}>
                  No orders yet.
                </div>
              ) : (
                history.entries.map((entry) => (
                  <div
                    key={entry.orderId}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      padding: '10px 0',
                      borderBottom: '1px solid var(--app-border)',
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
                        {entry.side.toUpperCase()} {entry.quantity} {entry.contractSymbol}
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
                      style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 'var(--fs-caption)' }}
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
