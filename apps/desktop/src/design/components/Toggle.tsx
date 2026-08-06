interface ToggleProps {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

/** 51x31 iOS switch. */
export function Toggle({ on, onChange, disabled = false, ariaLabel }: ToggleProps) {
  return (
    <button
      type="button"
      className={`toggle${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="knob" />
    </button>
  );
}
