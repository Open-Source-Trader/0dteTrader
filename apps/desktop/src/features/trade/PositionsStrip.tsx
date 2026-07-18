import { useState } from 'react';
import type { OrderResult, Position } from '@0dtetrader/shared-types';
import { AlertDialog } from '../../design/components/AlertDialog';
import { Spinner } from '../../design/components/Spinner';
import { Format } from '../../design/format';
import { XCircleFillIcon } from '../../design/icons';
import { orderStatusDisplayName, orderTypeDisplayName, sideDisplayName } from '../../core/models/domain';

interface PositionsStripProps {
  positions: Position[];
  openOrders: OrderResult[];
  workingSymbols: string[];
  onFlatten: (position: Position) => void;
  onCancelOrder: (order: OrderResult) => void;
}

const chipStyle: React.CSSProperties = {
  padding: '7px 10px',
  background: 'var(--app-surface)',
  borderRadius: 'var(--radius-card)',
  border: '0.5px solid color-mix(in srgb, var(--app-border) 50%, transparent)',
  flex: 'none',
  textAlign: 'left',
};

/** Positions strip: open positions (tap to flatten) and open orders (cancel). */
export function PositionsStrip({
  positions,
  openOrders,
  workingSymbols,
  onFlatten,
  onCancelOrder,
}: PositionsStripProps) {
  const [positionPendingFlatten, setPositionPendingFlatten] = useState<Position | null>(null);
  const [orderPendingCancel, setOrderPendingCancel] = useState<OrderResult | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {positions.length > 0 ? (
        <div
          className="hide-scrollbar"
          style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '0 12px' }}
        >
          {positions.map((position) => (
            <button
              key={position.symbol}
              style={chipStyle}
              onClick={() => setPositionPendingFlatten(position)}
              aria-label={`Position ${position.symbol}, tap to flatten`}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 'var(--fs-caption)', fontWeight: 600 }}>
                    {position.symbol}
                  </span>
                  {workingSymbols.includes(position.symbol) ? <Spinner size={11} /> : null}
                </span>
                <span className="text-secondary" style={{ fontSize: 'var(--fs-caption2)' }}>
                  {Format.signedQuantity(position.quantity)} @ {Format.price(position.avgPrice)}
                </span>
                <span
                  style={{
                    fontSize: 'var(--fs-caption)',
                    fontWeight: 600,
                    color:
                      position.unrealizedPnl >= 0 ? 'var(--pnl-positive)' : 'var(--pnl-negative)',
                  }}
                >
                  {Format.signedPrice(position.unrealizedPnl)}
                </span>
              </div>
            </button>
          ))}
        </div>
      ) : null}

      {openOrders.length > 0 ? (
        <div
          className="hide-scrollbar"
          style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '0 12px' }}
        >
          {openOrders.map((order) => (
            <div
              key={order.orderId}
              style={{ ...chipStyle, display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 'var(--fs-caption)', fontWeight: 600 }}>
                  {sideDisplayName(order.side)} {order.quantity} {order.contractSymbol}
                </span>
                <span className="text-secondary" style={{ fontSize: 'var(--fs-caption2)' }}>
                  {orderTypeDisplayName(order.orderType)} · {orderStatusDisplayName(order.status)}
                </span>
              </div>
              <button
                className="text-secondary"
                style={{ display: 'flex' }}
                onClick={() => setOrderPendingCancel(order)}
                aria-label="Cancel order"
              >
                <XCircleFillIcon size={17} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {positionPendingFlatten ? (
        <AlertDialog
          title="Flatten position?"
          message={`Submit a market ${positionPendingFlatten.quantity > 0 ? 'sell' : 'buy'} order to close ${positionPendingFlatten.symbol}?`}
          actions={[
            {
              label: `Flatten ${Math.abs(positionPendingFlatten.quantity)} @ Market`,
              role: 'destructive',
              onSelect: () => onFlatten(positionPendingFlatten),
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
