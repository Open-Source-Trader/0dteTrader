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
/** Digits, optionally one decimal point. Also matches the part-typed forms a
 *  level passes through on the way in (`''`, `'.'`, `'4300.'`). */
const LEVEL_SHAPE = /^\d*\.?\d*$/;
/** Ties the note to the level input, so a screen reader reads *why* it is
 *  invalid rather than only that it is. */
const NOTE_ID = 'order-placement-note';

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
  /** Raw text, held for as long as the user is typing. A level cannot be
   *  reached keystroke by keystroke without passing through text that is not
   *  what a number would print as — `''`, `'.'`, `'4300.'`, `'00.5'` — so the
   *  field shows exactly what was typed and only *reports* a level when the
   *  text parses to one. Snapping back to `String(price)` mid-word is what
   *  eats the decimal point. */
  const [levelDraft, setLevelDraft] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const levelRef = useRef<HTMLInputElement>(null);

  const levelText = levelDraft ?? String(price);
  const levelNumber = Number(levelText);
  const levelValid = Number.isFinite(levelNumber) && levelNumber > 0;

  // The level is the field most likely to be adjusted the moment this opens —
  // the `+` only gets you approximately where you meant.
  useEffect(() => {
    levelRef.current?.focus();
    levelRef.current?.select();
  }, []);

  // Escape closes, and so does a click anywhere else — the window must never be
  // the thing standing between the user and their chart.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // The chart's `+` is outside this card but is not "elsewhere": it is
      // inert while the window is open and says so, and dismissing on a press
      // there would contradict the disabled affordance it shows.
      if (target?.closest('[data-chart-placement]')) return;
      if (!ref.current?.contains(target)) onCancel();
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
    if (submitting || !levelValid) return;
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
          ref={levelRef}
          // Text rather than `number`: a number input reports unparseable
          // intermediate states as `''`, which would wipe what the user is
          // still typing when the draft is rendered back. The stepper beside it
          // covers what the native spinner would have.
          type="text"
          inputMode="decimal"
          value={levelText}
          aria-label="Trigger price"
          aria-invalid={!levelValid}
          aria-describedby={NOTE_ID}
          onChange={(event) => {
            const raw = event.target.value;
            // Digits and at most one point, nothing else: `Number` is happy to
            // read `0x1f`, `1e5` and `' 42 '` as prices, and none of those are
            // things anyone means to type into a dollar level.
            if (!LEVEL_SHAPE.test(raw)) return;
            setLevelDraft(raw);
            const next = Number(raw);
            if (Number.isFinite(next) && next > 0) onPriceChange(Math.round(next * 100) / 100);
          }}
          // Typing is over, so the field can stop showing the keystrokes and
          // show the level they added up to.
          onBlur={() => setLevelDraft(null)}
        />
        <Stepper
          value={price}
          min={0.01}
          max={100000}
          step={PRICE_STEP}
          onChange={(next) => {
            setLevelDraft(null);
            onPriceChange(next);
          }}
        />
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

      <p className="order-placement__note" id={NOTE_ID}>
        {levelValid ? (
          <>
            Fires an order when {contract.underlying} reaches {Format.price(price)}. Watched by the
            app — not a broker-side resting order.
          </>
        ) : (
          'Enter a level above 0 to place this line.'
        )}
      </p>

      <div className="order-placement__actions">
        <button type="button" className="order-placement__btn hud-clip" onClick={onCancel}>
          CANCEL
        </button>
        <button
          type="button"
          className={`order-placement__btn hud-clip order-placement__btn--${side}`}
          onClick={() => void submit()}
          disabled={submitting || !levelValid}
        >
          {submitting ? 'PLACING…' : 'PLACE'}
        </button>
      </div>
    </div>
  );
}
