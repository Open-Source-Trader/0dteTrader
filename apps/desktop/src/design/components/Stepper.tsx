import { MinusIcon, PlusIcon } from '../icons';

interface StepperProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}

/** iOS − / + stepper (94x32 two-segment control). */
export function Stepper({ value, min, max, step = 1, onChange }: StepperProps) {
  const round = (v: number) => Math.round(v * 100) / 100;
  return (
    <div className="stepper">
      <button
        disabled={value <= min}
        onClick={() => onChange(round(Math.max(min, value - step)))}
        aria-label="Decrement"
      >
        <MinusIcon size={13} />
      </button>
      <button
        disabled={value >= max}
        onClick={() => onChange(round(Math.min(max, value + step)))}
        aria-label="Increment"
      >
        <PlusIcon size={13} />
      </button>
    </div>
  );
}
