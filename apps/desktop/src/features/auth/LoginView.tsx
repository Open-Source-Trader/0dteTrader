import { useEffect, useState } from 'react';
import desktopIconUrl from '../../../electron/assets/icon.png';
import { useContainer } from '../../app/container';
import { Spinner } from '../../design/components/Spinner';
import { useStore } from '../../core/observable';
import type { AuthStore } from './AuthStore';
import { BackendStatus } from './BackendStatus';
import { PasswordField } from './PasswordField';
import { RegisterView } from './RegisterView';
import { ServerSelectView } from './ServerSelectView';

// Reuses the shared toast-in keyframes (base.css) for a staggered entrance;
// the global prefers-reduced-motion rule collapses it for motion-sensitive users.
const ENTRANCE = 'toast-in 250ms cubic-bezier(0.32, 0.72, 0, 1) both';

// Saving a new server URL rebuilds the app container, which cycles the auth
// state through 'checking' and remounts this screen (RootView keys its fade on
// that state) — wiping local state. This module-level flag carries the
// "continue to Register after picking a server" intent across that remount.
let resumeRegisterAfterRebuild = false;

/** Why the server picker is open: creating an account, or the footer link. */
type ServerSelectIntent = 'register' | 'change';

export function LoginView({ store }: { store: AuthStore }) {
  const { serverConfigStore } = useContainer();
  const { baseUrl } = useStore(serverConfigStore);
  const { isLoading, errorMessage } = useStore(store);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showRegister, setShowRegister] = useState(false);
  const [serverSelectIntent, setServerSelectIntent] = useState<ServerSelectIntent | null>(null);

  useEffect(() => {
    if (resumeRegisterAfterRebuild) {
      resumeRegisterAfterRebuild = false;
      setShowRegister(true);
    }
  }, []);

  const isFormValid = email.includes('@') && password !== '';

  const submit = () => {
    if (!isFormValid || isLoading) return;
    void store.login(email.trim(), password);
  };

  const finishServerSelect = (serverChanged: boolean) => {
    const intent = serverSelectIntent;
    setServerSelectIntent(null);
    if (intent !== 'register') return;
    if (serverChanged) {
      // The container rebuild is about to remount this screen; resume there.
      resumeRegisterAfterRebuild = true;
    } else {
      setShowRegister(true);
    }
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
          alignItems: 'center',
          padding: 'var(--pad-screen)',
          position: 'relative',
        }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        noValidate
      >
        {/* Caps the form's width on wide desktop windows — the fields/button
            below are full-width within this box, not the whole screen. */}
        <div
          style={{
            width: '100%',
            maxWidth: 360,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-6)',
          }}
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
            <img
              src={desktopIconUrl}
              alt=""
              aria-hidden="true"
              style={{
                width: 56,
                height: 56,
                objectFit: 'contain',
                filter: 'drop-shadow(0 6px 18px rgba(46, 143, 255, 0.25))',
              }}
            />
            <h1 className="hud-title" style={{ fontSize: 'var(--fs-title)' }}>
              0dteTrader
            </h1>
            <span className="text-secondary" style={{ fontSize: 'var(--fs-subheadline)' }}>
              Desktop trading workstation
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
            {errorMessage ?? ' '}
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
              setServerSelectIntent('register');
            }}
          >
            Create an account
          </button>
        </div>
      </form>

      {/* Footer backend indicator: status light + Change, opening the same
          server picker without entering the create-account flow. */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          padding: '0 var(--pad-screen)',
          paddingBottom: 'var(--space-2)',
          animation: ENTRANCE,
          animationDelay: '180ms',
        }}
      >
        <BackendStatus baseUrl={baseUrl} onChange={() => setServerSelectIntent('change')} />
      </div>

      {/* Rendered outside the <form>: these have their own forms, and nested
          forms are invalid HTML. */}
      {serverSelectIntent !== null ? (
        <ServerSelectView
          onDismiss={() => setServerSelectIntent(null)}
          onContinue={finishServerSelect}
        />
      ) : null}
      {showRegister ? (
        <RegisterView store={store} onDismiss={() => setShowRegister(false)} />
      ) : null}
    </>
  );
}
