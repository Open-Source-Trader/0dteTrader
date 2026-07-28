import { useState } from 'react';
import type { OrderResult, Position } from '@0dtetrader/shared-types';
import { AlertDialog } from '../../design/components/AlertDialog';
import { Spinner } from '../../design/components/Spinner';
import { Format } from '../../design/format';
import { XCircleFillIcon } from '../../design/icons';
import {
  orderStatusDisplayName,
  orderTypeDisplayName,
  sideDisplayName,
} from '../../core/models/domain';

interface DesktopPositionsPanelProps {
  positions: Position[];
  openOrders: OrderResult[];
  workingSymbols: string[];
  onFlatten: (position: Position) => void;
  onCancelOrder: (order: OrderResult) => void;
  locked?: boolean;
}

/** `+$125.00` / `-$87.50` signed dollar P&L; zero renders unsigned. */
function signedCurrency(value: number): string {
  if (value === 0) return `$${Format.price(0)}`;
  return value < 0 ? `-$${Format.price(Math.abs(value))}` : `+$${Format.price(value)}`;
}

/** Desktop-grid positions/orders footer: tabbed dense table (TradingView
 *  Account Manager / ThinkOrSwim Monitor convention), not the phone strip's
 *  horizontally-scrolling chip row. Same confirm-dialog flow as
 *  PositionsStrip, different presentation entirely. */
export function DesktopPositionsPanel({
  positions,
  openOrders,
  workingSymbols,
  onFlatten,
  onCancelOrder,
  locked = false,
}: DesktopPositionsPanelProps) {
  const [tab, setTab] = useState<'positions' | 'orders'>('positions');
  const [positionPendingFlatten, setPositionPendingFlatten] = useState<Position | null>(null);
  const [orderPendingCancel, setOrderPendingCancel] = useState<OrderResult | null>(null);

  let bodyContent: React.ReactNode;
  if (tab === 'positions') {
    bodyContent =
      positions.length === 0 ? (
        <div className="desktop-positions-empty text-secondary">No open positions</div>
      ) : (
        <table className="desktop-positions-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Symbol</th>
              <th style={{ textAlign: 'right' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Avg</th>
              <th style={{ textAlign: 'right' }}>Mark</th>
              <th style={{ textAlign: 'right' }}>P&amp;L</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => (
              <tr key={position.symbol}>
                <td>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {position.symbol}
                    {workingSymbols.includes(position.symbol) ? <Spinner size={11} /> : null}
                  </span>
                </td>
                <td className="numeric" style={{ textAlign: 'right' }}>
                  {Format.signedQuantity(position.quantity)}
                </td>
                <td className="numeric" style={{ textAlign: 'right' }}>
                  {Format.price(position.avgPrice)}
                </td>
                <td className="numeric" style={{ textAlign: 'right' }}>
                  {Format.price(position.markPrice)}
                </td>
                <td
                  className="numeric"
                  style={{
                    textAlign: 'right',
                    color:
                      position.unrealizedPnl >= 0 ? 'var(--pnl-positive)' : 'var(--pnl-negative)',
                    fontWeight: 600,
                  }}
                >
                  {signedCurrency(position.unrealizedPnl)}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    className="desktop-positions-action"
                    disabled={locked}
                    onClick={() => setPositionPendingFlatten(position)}
                    aria-label={`Flatten ${position.symbol}`}
                  >
                    Flatten
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
  } else if (openOrders.length === 0) {
    bodyContent = <div className="desktop-positions-empty text-secondary">No working orders</div>;
  } else {
    bodyContent = (
      <table className="desktop-positions-table">
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Symbol</th>
            <th style={{ textAlign: 'left' }}>Side</th>
            <th style={{ textAlign: 'right' }}>Qty</th>
            <th style={{ textAlign: 'left' }}>Type</th>
            <th style={{ textAlign: 'left' }}>Status</th>
            <th aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {openOrders.map((order) => (
            <tr key={order.orderId}>
              <td className="numeric">{order.contractSymbol}</td>
              <td
                className="numeric"
                style={{
                  color: order.side === 'buy' ? 'var(--buy-green)' : 'var(--sell-red)',
                  fontWeight: 600,
                }}
              >
                {sideDisplayName(order.side)}
              </td>
              <td className="numeric" style={{ textAlign: 'right' }}>
                {order.quantity}
              </td>
              <td>{orderTypeDisplayName(order.orderType)}</td>
              <td className="text-secondary">{orderStatusDisplayName(order.status)}</td>
              <td style={{ textAlign: 'right' }}>
                <button
                  className="desktop-positions-action"
                  disabled={locked}
                  onClick={() => setOrderPendingCancel(order)}
                  aria-label="Cancel order"
                >
                  <XCircleFillIcon size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div className="desktop-positions-panel">
      <div className="desktop-positions-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'positions'}
          className={tab === 'positions' ? 'desktop-positions-tab active' : 'desktop-positions-tab'}
          onClick={() => setTab('positions')}
        >
          Positions
          {positions.length > 0 ? (
            <span className="desktop-positions-tab-count">{positions.length}</span>
          ) : null}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'orders'}
          className={tab === 'orders' ? 'desktop-positions-tab active' : 'desktop-positions-tab'}
          onClick={() => setTab('orders')}
        >
          Open Orders
          {openOrders.length > 0 ? (
            <span className="desktop-positions-tab-count">{openOrders.length}</span>
          ) : null}
        </button>
      </div>

      <div className="desktop-positions-body hide-scrollbar">{bodyContent}</div>

      {positionPendingFlatten ? (
        <AlertDialog
          title="Flatten position?"
          message={`Submit a market ${positionPendingFlatten.quantity > 0 ? 'sell' : 'buy'} order to close ${positionPendingFlatten.symbol}?`}
          actions={[
            {
              label: `Flatten ${Math.abs(positionPendingFlatten.quantity)} @ Market`,
              role: 'destructive',
              onSelect: () => {
                const current =
                  positions.find((p) => p.symbol === positionPendingFlatten.symbol) ??
                  positionPendingFlatten;
                onFlatten(current);
              },
            },
            { label: 'Cancel', role: 'cancel' },
          ]}
          onDismiss={() => setPositionPendingFlatten(null)}
        />
      ) : null}

      {orderPendingCancel ? (
        <AlertDialog
          title="Cancel order?"
          message={`${sideDisplayName(orderPendingCancel.side)} ${orderPendingCancel.quantity} ${orderPendingCancel.contractSymbol}`}
          actions={[
            {
              label: 'Cancel Order',
              role: 'destructive',
              onSelect: () => onCancelOrder(orderPendingCancel),
            },
            { label: 'Keep Order', role: 'cancel' },
          ]}
          onDismiss={() => setOrderPendingCancel(null)}
        />
      ) : null}
    </div>
  );
}
