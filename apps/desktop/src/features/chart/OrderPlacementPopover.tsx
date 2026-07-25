import { useEffect, useRef, useState } from 'react';
import type { OptionContract, OrderSide, OrderType } from '@0dtetrader/shared-types';
import { Format } from '../../design/format';

export interface OrderPlacementInput {
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
}

interface OrderPlacementPopoverProps {
  /** Level the line will sit at, on the underlying. */
  price: number;
  /** Vertical anchor in pane coordinates. */
  top: number;
  rightInset: number;
  contract: OptionContract;
  defaultQuantity: number;
  defaultOrderType: OrderType;
  onPlace: (input: OrderPlacementInput) => Promise<void>;
  onCancel: () => void;
}

/**
 * The small window behind the price-axis `+`: pick a side, a size, and how the
 * order executes when the level is hit.
 *
 * The execution type is offered here (rather than inherited silently) for the
 * same reason it sits on the line itself — `market` into a thin 0DTE spread and
 * `mid` that never fills are both bad in different situations, and the choice
 * should be in front of you when you arm the line.
 */
export function OrderPlacementPopover({
  price,
  top,
  rightInset,
  contract,
  defaultQuantity,
  defaultOrderType,
  onPlace,
  onCancel,
}: OrderPlacementPopoverProps) {
  const [side, setSide] = useState<OrderSide>('buy');
  const [quantity, setQuantity] = useState(defaultQuantity);
  const [orderType, setOrderType] = useState<OrderType>(defaultOrderType);
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Escape closes, and so does a click anywhere else — the popover must never
  // be the thing standing between the user and their chart.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onCancel();
    };
    window.addEventListener('keydown', onKey);
    // Deferred: the click that opened this popover is still propagating.
    const timer = setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
      clearTimeout(timer);
    };
  }, [onCancel]);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onPlace({ side, quantity, orderType });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Place a chart order"
      style={{
        position: 'absolute',
        right: 32 + rightInset,
        top: Math.max(4, top - 60),
        zIndex: 6,
        width: 208,
        padding: 10,
        borderRadius: 8,
        border: '1px solid var(--hud-stroke-dim)',
        background: 'var(--app-surface, #101826)',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.45)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontSize: 12,
      }}
    >
      <div style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-mono)' }}>
        {contract.underlying} @ {Format.price(price)}
      </div>
      <div style={{ color: 'var(--label-secondary)', fontSize: 11 }}>
        {Format.strike(contract.strike)}
        {contract.optionType === 'call' ? 'C' : 'P'} · {contract.expiration}
      </div>

      <Segmented
        label="Side"
        options={[
          { value: 'buy', label: 'BUY' },
          { value: 'sell', label: 'SELL' },
        ]}
        value={side}
        onChange={(value) => setSide(value as OrderSide)}
      />
      <Segmented
        label="Execution"
        options={[
          { value: 'mid', label: 'MID' },
          { value: 'market', label: 'MKT' },
        ]}
        value={orderType}
        onChange={(value) => setOrderType(value as OrderType)}
      />

      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--label-secondary)' }}>Qty</span>
        <input
          type="number"
          min={1}
          max={1000}
          value={quantity}
          onChange={(event) =>
            setQuantity(Math.max(1, Math.min(1000, Number(event.target.value) || 1)))
          }
          style={{
            flex: 1,
            background: 'var(--app-background)',
            border: '1px solid var(--hud-stroke-dim)',
            borderRadius: 4,
            color: 'var(--label-primary)',
            padding: '4px 6px',
            fontFamily: 'var(--font-mono)',
          }}
        />
      </label>

      <div style={{ color: 'var(--label-secondary)', fontSize: 10, lineHeight: 1.35 }}>
        Fires an order when {contract.underlying} reaches {Format.price(price)}. Watched by the app
        — not a broker-side resting order.
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" onClick={onCancel} style={buttonStyle(false)}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting}
          style={buttonStyle(true)}
        >
          {submitting ? 'Placing…' : 'Place'}
        </button>
      </div>
    </div>
  );
}

function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', gap: 4 }}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          style={{
            flex: 1,
            padding: '5px 0',
            borderRadius: 4,
            border: '1px solid var(--hud-stroke-dim)',
            background: value === option.value ? 'var(--app-accent)' : 'transparent',
            color: value === option.value ? 'var(--app-background)' : 'var(--label-secondary)',
            fontWeight: 600,
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function buttonStyle(primary: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: '6px 0',
    borderRadius: 4,
    border: '1px solid var(--hud-stroke-dim)',
    background: primary ? 'var(--app-accent)' : 'transparent',
    color: primary ? 'var(--app-background)' : 'var(--label-secondary)',
    fontWeight: 600,
    cursor: 'pointer',
  };
}
