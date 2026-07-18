import { useState } from 'react';
import { NavBar } from '../../design/components/NavBar';
import { Sheet } from '../../design/components/Sheet';
import { Spinner } from '../../design/components/Spinner';
import { useStore } from '../../core/observable';
import type { AuthStore } from './AuthStore';

export function RegisterView({ store, onDismiss }: { store: AuthStore; onDismiss: () => void }) {
  const { isLoading, errorMessage } = useStore(store);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Same rules as RegisterView.swift; the message gates the button but is not shown.
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
      <div
        className="sheet-body"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          padding: 'var(--pad-screen)',
          background: 'var(--app-background)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <input
            className="field"
            type="email"
            placeholder="Email"
            autoComplete="email"
            autoCapitalize="off"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <input
            className="field"
            type="password"
            placeholder="Password (8+ characters)"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <input
            className="field"
            type="password"
            placeholder="Confirm password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
          />
        </div>

        {errorMessage ? (
          <div
            style={{
              fontSize: 'var(--fs-footnote)',
              color: 'var(--pnl-negative)',
              textAlign: 'center',
            }}
          >
            {errorMessage}
          </div>
        ) : null}

        <button
          className={`button-primary${validationMessage !== null || isLoading ? ' dimmed' : ''}`}
          disabled={validationMessage !== null || isLoading}
          onClick={submit}
        >
          {isLoading ? <Spinner white /> : 'Create Account'}
        </button>
      </div>
    </Sheet>
  );
}
