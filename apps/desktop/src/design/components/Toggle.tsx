interface ToggleProps {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  /** 'compact' is the dense desktop-density track used by keyboard+mouse
   * settings surfaces; default is the 51x31 iOS switch used on touch. */
  size?: 'default' | 'compact';
}

export function Toggle({
  on,
  onChange,
  disabled = false,
  ariaLabel,
  size = 'default',
}: ToggleProps) {
  return (
    <button
      type="button"
      className={`toggle${size === 'compact' ? ' toggle--compact' : ''}${on ? ' on' : ''}`}
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
