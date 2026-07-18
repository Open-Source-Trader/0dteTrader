interface ToggleProps {
  on: boolean;
  onChange: (on: boolean) => void;
}

/** 51x31 iOS switch. */
export function Toggle({ on, onChange }: ToggleProps) {
  return (
    <button
      className={`toggle${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className="knob" />
    </button>
  );
}
