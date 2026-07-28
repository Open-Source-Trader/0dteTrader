import { useEffect, useState } from 'react';
import { MinusIcon, PlusIcon } from '../icons';

interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  decimals?: number;
  onChange: (value: number) => void;
}

/** Desktop numeric field: type a value directly (VS Code settings
 *  convention) with +/- buttons alongside for quick nudges — unlike the
 *  touch-oriented Stepper, the number itself is a real input, not just a
 *  read-only label next to two buttons. */
export function NumberField({
  value,
  min,
  max,
  step = 1,
  decimals = 0,
  onChange,
}: NumberFieldProps) {
  const [text, setText] = useState(value.toFixed(decimals));

  useEffect(() => {
    setText(value.toFixed(decimals));
  }, [value, decimals]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setText(value.toFixed(decimals));
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    setText(clamped.toFixed(decimals));
    if (clamped !== value) onChange(clamped);
  };

  const nudge = (delta: number) => {
    const next = Math.round((value + delta) * 10 ** decimals) / 10 ** decimals;
    onChange(Math.min(max, Math.max(min, next)));
  };

  return (
    <div className="number-field">
      <input
        className="number-field-input"
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            nudge(step);
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            nudge(-step);
          }
        }}
      />
      <div className="number-field-buttons">
        <button
          type="button"
          disabled={value <= min}
          onClick={() => nudge(-step)}
          aria-label="Decrement"
        >
          <MinusIcon size={9} />
        </button>
        <button
          type="button"
          disabled={value >= max}
          onClick={() => nudge(step)}
          aria-label="Increment"
        >
          <PlusIcon size={9} />
        </button>
      </div>
    </div>
  );
}
