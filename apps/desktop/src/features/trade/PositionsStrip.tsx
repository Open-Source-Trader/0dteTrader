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
  /** Horizontal inset for the scrolling rows; aligns chips with the buttons
   *  in the fullscreen overlay and with the panel padding in Layout B. */
  rowPadding?: string;
}

const chipStyle: React.CSSProperties = {
  padding: '8px 12px',
  background: 'var(--app-surface)',
  borderRadius: 'var(--radius-chip)',
  border: '1px solid var(--app-border)',
  flex: 'none',
  textAlign: 'left',
};

/** `+$125.00` / `-$87.50` signed dollar P&L; zero renders unsigned. */
function signedCurrency(value: number): string {
  if (value === 0) return `$${Format.price(0)}`;
  return value < 0 ? `-$${Format.price(Math.abs(value))}` : `+$${Format.price(value)}`;
}

// Fades the right edge so a 4th+ chip is discoverable without a scrollbar.
const SCROLL_FADE = 'linear-gradient(to right, #000 calc(100% - 24px), transparent)';

/** Positions strip: open positions (tap to flatten) and open orders (cancel). */
export function PositionsStrip({
  positions,
  openOrders,
  workingSymbols,
  onFlatten,
  onCancelOrder,
  rowPadding = '0 20px',
}: PositionsStripProps) {
  const [positionPendingFlatten, setPositionPendingFlatten] = useState<Position | null>(null);
  const [orderPendingCancel, setOrderPendingCancel] = useState<OrderResult | null>(null);

  // Always render the wrapper so the strip animates in/out instead of
  // materializing and shifting the whole trade panel in one frame.
  const visible = positions.length > 0 || openOrders.length > 0;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        overflow: 'hidden',
        maxHeight: visible ? 140 : 0,
        opacity: visible ? 1 : 0,
        transition: 'max-height 200ms cubic-bezier(0.32, 0.72, 0, 1), opacity 150ms ease',
      }}
    >
      {positions.length > 0 ? (
        <div
          className="hide-scrollbar"
          style={{
            display: 'flex',
            gap: 8,
            overflowX: 'auto',
            padding: rowPadding,
            WebkitMaskImage: SCROLL_FADE,
            maskImage: SCROLL_FADE,
          }}
        >
          {positions.map((position) => (
            <button
              key={position.symbol}
              style={chipStyle}
              onClick={() => setPositionPendingFlatten(position)}
              aria-label={`Position ${position.symbol}${
                workingSymbols.includes(position.symbol) ? ', order working' : ''
              }, activate to flatten`}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 'var(--fs-caption)', fontWeight: 600 }}>
                    {position.symbol}
                  </span>
                  {workingSymbols.includes(position.symbol) ? <Spinner size={11} /> : null}
                </span>
                <span
                  className="text-secondary numeric"
                  style={{ fontSize: 'var(--fs-caption2)' }}
                >
                  {Format.signedQuantity(position.quantity)} @ {Format.price(position.avgPrice)}
                </span>
                <span
                  className="numeric"
                  style={{
                    fontSize: 'var(--fs-caption)',
                    fontWeight: 600,
                    color:
                      position.unrealizedPnl >= 0 ? 'var(--pnl-positive)' : 'var(--pnl-negative)',
                  }}
                >
                  {signedCurrency(position.unrealizedPnl)}
                </span>
              </div>
            </button>
          ))}
        </div>
      ) : null}

      {openOrders.length > 0 ? (
        <div
          className="hide-scrollbar"
          style={{
            display: 'flex',
            gap: 8,
            overflowX: 'auto',
            padding: rowPadding,
            WebkitMaskImage: SCROLL_FADE,
            maskImage: SCROLL_FADE,
          }}
        >
          {openOrders.map((order) => (
            <div
              key={order.orderId}
              style={{ ...chipStyle, display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className="numeric" style={{ fontSize: 'var(--fs-caption)', fontWeight: 600 }}>
                  {sideDisplayName(order.side)} {order.quantity} {order.contractSymbol}
                </span>
                <span
                  className="text-secondary numeric"
                  style={{ fontSize: 'var(--fs-caption2)' }}
                >
                  {orderTypeDisplayName(order.orderType)} · {orderStatusDisplayName(order.status)}
                </span>
              </div>
              <button
                className="text-secondary"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  // Negative margin keeps the chip padding while growing the
                  // hit target to ~33x33px.
                  margin: '-8px -8px -8px 0',
                  padding: 8,
                }}
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
