import { useState } from 'react';
import { NavBar } from '../../design/components/NavBar';
import { Sheet } from '../../design/components/Sheet';
import { Spinner } from '../../design/components/Spinner';
import { useStore } from '../../core/observable';
import type { AuthStore } from './AuthStore';
import { PasswordField } from './PasswordField';

export function RegisterView({ store, onDismiss }: { store: AuthStore; onDismiss: () => void }) {
  const { isLoading, errorMessage } = useStore(store);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [touched, setTouched] = useState(false);

  // Same rules as RegisterView.swift; shown as a hint once any field loses focus.
  const validationMessage = !email.includes('@')
    ? 'Enter a valid email address.'
    : password.length < 8
      ? 'Password must be at least 8 characters.'
      : password !== confirmPassword
        ? 'Passwords do not match.'
        : null;

  const submit = () => {
    if (validationMessage !== null || isLoading) return;
    void store.register(email.trim(), password);
  };

  return (
    <Sheet detent="large" onDismiss={onDismiss}>
      <NavBar
        title="Create Account"
        leading={
          <button className="navbar-text-button" onClick={onDismiss}>
            Cancel
          </button>
        }
      />
      <form
        className="sheet-body"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-6)',
          padding: 'var(--pad-screen)',
          background: 'var(--app-background)',
        }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        noValidate
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <input
            className="field"
            type="email"
            name="email"
            inputMode="email"
            placeholder="Email"
            aria-label="Email"
            aria-invalid={errorMessage ? true : undefined}
            autoComplete="email"
            autoCapitalize="off"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onBlur={() => setTouched(true)}
          />
          <div>
            <PasswordField
              placeholder="Password"
              autoComplete="new-password"
              value={password}
              onChange={setPassword}
              onBlur={() => setTouched(true)}
              ariaLabel="Password"
              ariaInvalid={!!errorMessage}
            />
            <span
              className="text-secondary"
              style={{ fontSize: 'var(--fs-caption)', paddingLeft: 'var(--space-1)' }}
            >
              Minimum 8 characters
            </span>
          </div>
          <PasswordField
            placeholder="Confirm password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            onBlur={() => setTouched(true)}
            ariaLabel="Confirm password"
            ariaInvalid={!!errorMessage}
          />
        </div>

        {touched && validationMessage ? (
          <div
            role="status"
            style={{
              fontSize: 'var(--fs-footnote)',
              color: 'var(--label-secondary)',
              textAlign: 'center',
            }}
          >
            {validationMessage}
          </div>
        ) : null}

        {/* Slot is always rendered so an error doesn't shift the CTA. */}
        <div
          role="alert"
          style={{
            fontSize: 'var(--fs-footnote)',
            color: 'var(--pnl-negative)',
            textAlign: 'center',
            minHeight: 18,
            visibility: errorMessage ? 'visible' : 'hidden',
          }}
        >
          {errorMessage ? (
            <>
              <span aria-hidden="true">⚠ </span>
              {errorMessage}
            </>
          ) : (
            ' '
          )}
        </div>

        <button
          type="submit"
          className={`button-primary${validationMessage !== null || isLoading ? ' dimmed' : ''}`}
          disabled={validationMessage !== null || isLoading}
          aria-busy={isLoading}
        >
          {isLoading ? <Spinner white /> : 'Create Account'}
        </button>

        <div style={{ flex: 1 }} />
        <p
          className="text-secondary"
          style={{
            fontSize: 'var(--fs-caption)',
            textAlign: 'center',
            paddingBottom: 'var(--space-2)',
          }}
        >
          By creating an account you agree to the Terms of Service and Privacy Policy.
        </p>
      </form>
    </Sheet>
  );
}
