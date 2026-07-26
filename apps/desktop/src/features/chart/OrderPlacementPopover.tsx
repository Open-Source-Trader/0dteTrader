import { useEffect, useRef, useState } from 'react';
import type { OptionContract, OrderSide, OrderType } from '@0dtetrader/shared-types';
import { SegmentedControl } from '../../design/components/SegmentedControl';
import { Stepper } from '../../design/components/Stepper';
import { Format } from '../../design/format';

export interface OrderPlacementInput {
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
}

interface OrderPlacementPopoverProps {
  /** Level the line will sit at, on the underlying. */
  price: number;
  /** Editing the price here moves the guide on the chart — the number and the
   *  line are the same fact, so they must never disagree. */
  onPriceChange: (price: number) => void;
  rightInset: number;
  contract: OptionContract;
  defaultQuantity: number;
  defaultOrderType: OrderType;
  onPlace: (input: OrderPlacementInput) => Promise<void>;
  onCancel: () => void;
}

/** Trigger price step: one cent, the tick the level is rounded to anyway. */
const PRICE_STEP = 0.01;

/**
 * The window behind the chart's `+`: pick a level, a side, a size, and how the
 * order executes when the level is hit. Every field is editable — the `+` puts
 * you roughly where you meant, and this is where you say exactly.
 *
 * The execution type is offered here (rather than inherited silently) for the
 * same reason it sits on the line itself — `market` into a thin 0DTE spread and
 * `mid` that never fills are both bad in different situations, and the choice
 * should be in front of you when you arm the line.
 */
export function OrderPlacementPopover({
  price,
  onPriceChange,
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

  // Escape closes, and so does a click anywhere else — the window must never be
  // the thing standing between the user and their chart.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onCancel();
    };
    window.addEventListener('keydown', onKey);
    // Deferred: the click that opened this window is still propagating.
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
      data-chart-placement=""
      className="hud-card order-placement"
      role="dialog"
      aria-label="Place a chart order"
      style={{ right: 36 + rightInset }}
    >
      <div className="order-placement__title">PLACE ORDER LINE</div>

      <label className="order-placement__row">
        <span>Level</span>
        <input
          type="number"
          step={PRICE_STEP}
          value={price}
          aria-label="Trigger price"
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onPriceChange(Math.round(next * 100) / 100);
          }}
        />
        <Stepper value={price} min={0.01} max={100000} step={PRICE_STEP} onChange={onPriceChange} />
      </label>

      <div className="order-placement__contract">
        {contract.underlying} {Format.strike(contract.strike)}
        {contract.optionType === 'call' ? 'C' : 'P'} · {contract.expiration}
      </div>

      <SegmentedControl
        options={[
          { value: 'buy', label: 'BUY' },
          { value: 'sell', label: 'SELL' },
        ]}
        value={side}
        onChange={(value) => setSide(value as OrderSide)}
      />
      <SegmentedControl
        options={[
          { value: 'mid', label: 'MID' },
          { value: 'market', label: 'MKT' },
        ]}
        value={orderType}
        onChange={(value) => setOrderType(value as OrderType)}
      />

      <label className="order-placement__row">
        <span>Qty</span>
        <input
          type="number"
          min={1}
          max={1000}
          value={quantity}
          aria-label="Quantity"
          onChange={(event) =>
            setQuantity(Math.max(1, Math.min(1000, Number(event.target.value) || 1)))
          }
        />
        <Stepper value={quantity} min={1} max={1000} onChange={setQuantity} />
      </label>

      <p className="order-placement__note">
        Fires an order when {contract.underlying} reaches {Format.price(price)}. Watched by the app
        — not a broker-side resting order.
      </p>

      <div className="order-placement__actions">
        <button type="button" className="order-placement__btn" onClick={onCancel}>
          CANCEL
        </button>
        <button
          type="button"
          className={`order-placement__btn order-placement__btn--${side}`}
          onClick={() => void submit()}
          disabled={submitting}
        >
          {submitting ? 'PLACING…' : 'PLACE'}
        </button>
      </div>
    </div>
  );
}
