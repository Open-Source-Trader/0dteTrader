import { useState } from 'react';
import { Spinner } from '../../design/components/Spinner';
import { useStore } from '../../core/observable';
import type { AuthStore } from './AuthStore';
import { RegisterView } from './RegisterView';

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
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 24,
        padding: 'var(--pad-screen)',
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <h1 style={{ fontSize: 'var(--fs-large-title)', fontWeight: 700 }}>0dteTrader</h1>
        <span className="text-secondary" style={{ fontSize: 'var(--fs-subheadline)' }}>
          Rapid options &amp; futures trading
        </span>
      </div>

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
          onKeyDown={(event) => event.key === 'Enter' && submit()}
        />
        <input
          className="field"
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
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
        className={`button-primary${!isFormValid || isLoading ? ' dimmed' : ''}`}
        disabled={!isFormValid || isLoading}
        onClick={submit}
      >
        {isLoading ? <Spinner white /> : 'Log In'}
      </button>

      <button
        style={{
          fontSize: 'var(--fs-subheadline)',
          color: 'var(--app-accent)',
          alignSelf: 'center',
        }}
        onClick={() => {
          store.clearError();
          setShowRegister(true);
        }}
      >
        Create an account
      </button>

      {showRegister ? <RegisterView store={store} onDismiss={() => setShowRegister(false)} /> : null}
    </div>
  );
}
