import { Fragment, type ReactNode } from 'react';

interface SegmentedControlProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** Extra class on the track — `segmented--split` for the order-type row. */
  className?: string;
  /**
   * Content laid *between* the segments, so a two-option control can put its
   * choices at the two ends of a row with something else in the middle. The
   * order-type row wants exactly that — Mid hard left, Market hard right, the
   * contract's bid/mid/ask between them — and the two must still read as one
   * either/or rather than as two independent toggles, so they stay inside the
   * one track instead of being split into two controls.
   */
  center?: ReactNode;
}

/** iOS UISegmentedControl look-alike (HudSegmentedControl.swift). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
  center,
}: SegmentedControlProps<T>) {
  return (
    <div className={className ? `segmented ${className}` : 'segmented'}>
      {options.map((option, index) => (
        <Fragment key={option.value}>
          {index === 1 && center ? center : null}
          <button
            className={`segment${option.value === value ? ' selected' : ''}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
