import { useState } from 'react';
import { Spinner } from '../../design/components/Spinner';
import { useStore } from '../../core/observable';
import type { AuthStore } from './AuthStore';
import { PasswordField } from './PasswordField';
import { RegisterView } from './RegisterView';

// Reuses the shared toast-in keyframes (base.css) for a staggered entrance;
// the global prefers-reduced-motion rule collapses it for motion-sensitive users.
const ENTRANCE = 'toast-in 250ms cubic-bezier(0.32, 0.72, 0, 1) both';

export function LoginView({ store }: { store: AuthStore }) {
  const { isLoading, errorMessage } = useStore(store);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showRegister, setShowRegister] = useState(false);

  const isFormValid = email.includes('@') && password !== '';

  const submit = () => {
    if (!isFormValid || isLoading) return;
    void store.login(email.trim(), password);
  };

  return (
    <>
      <form
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 'var(--space-6)',
          padding: 'var(--pad-screen)',
          position: 'relative',
        }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        noValidate
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--space-2)',
            animation: ENTRANCE,
          }}
        >
          <div
            aria-hidden="true"
            className="hud-clip"
            style={{
              width: 56,
              height: 56,
              background: 'linear-gradient(135deg, var(--app-accent), var(--app-accent-fill))',
              boxShadow: 'inset 0 0 12px rgba(5, 10, 20, 0.6)',
            }}
          />
          <h1 className="hud-title" style={{ fontSize: 'var(--fs-title)' }}>
            0dteTrader
          </h1>
          <span className="text-secondary" style={{ fontSize: 'var(--fs-subheadline)' }}>
            Rapid options trading
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
            animation: ENTRANCE,
            animationDelay: '60ms',
          }}
        >
          <input
            className="field"
            type="email"
            placeholder="Email"
            aria-label="Email"
            aria-invalid={errorMessage ? true : undefined}
            aria-describedby={errorMessage ? 'login-error' : undefined}
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <PasswordField
            placeholder="Password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            ariaLabel="Password"
            ariaInvalid={!!errorMessage}
            ariaDescribedBy={errorMessage ? 'login-error' : undefined}
          />
        </div>

        {/* Slot is always rendered so an error doesn't recenter the column. */}
        <div
          id="login-error"
          role="alert"
          style={{
            fontSize: 'var(--fs-footnote)',
            color: 'var(--pnl-negative)',
            textAlign: 'center',
            minHeight: 16,
            visibility: errorMessage ? 'visible' : 'hidden',
          }}
        >
          {errorMessage ?? ' '}
        </div>

        <button
          type="submit"
          className={`button-primary${!isFormValid || isLoading ? ' dimmed' : ''}`}
          disabled={!isFormValid || isLoading}
          aria-busy={isLoading}
          style={{ animation: ENTRANCE, animationDelay: '120ms' }}
        >
          {isLoading ? <Spinner white /> : 'Log In'}
        </button>

        <button
          type="button"
          style={{
            fontSize: 'var(--fs-subheadline)',
            color: 'var(--app-accent)',
            alignSelf: 'center',
            minHeight: 44,
            padding: '0 var(--space-4)',
          }}
          onClick={() => {
            store.clearError();
            setShowRegister(true);
          }}
        >
          Create an account
        </button>
      </form>

      {/* Rendered outside the <form>: RegisterView has its own form, and nested forms are invalid HTML. */}
      {showRegister ? (
        <RegisterView store={store} onDismiss={() => setShowRegister(false)} />
      ) : null}
    </>
  );
}
