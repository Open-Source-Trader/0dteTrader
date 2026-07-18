import { useState } from 'react';

interface PasswordFieldProps {
  placeholder: string;
  autoComplete: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  ariaLabel: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}

/** Password input with a trailing show/hide toggle (iOS eye/eye.slash analog). */
export function PasswordField({
  placeholder,
  autoComplete,
  value,
  onChange,
  onBlur,
  ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
}: PasswordFieldProps) {
  const [show, setShow] = useState(false);

  return (
    <div style={{ position: 'relative' }}>
      <input
        className="field"
        type={show ? 'text' : 'password'}
        placeholder={placeholder}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid ? true : undefined}
        aria-describedby={ariaDescribedBy}
        style={{ paddingRight: 56 }}
      />
      <button
        type="button"
        aria-label={show ? 'Hide password' : 'Show password'}
        aria-pressed={show}
        onClick={() => setShow((v) => !v)}
        style={{
          position: 'absolute',
          right: 12,
          top: '50%',
          transform: 'translateY(-50%)',
          fontSize: 'var(--fs-caption)',
          color: 'var(--app-accent-text)',
          minHeight: 32,
          padding: '0 var(--space-1)',
        }}
      >
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
