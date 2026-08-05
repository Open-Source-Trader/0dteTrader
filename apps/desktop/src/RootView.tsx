import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useContainer } from './app/container';
import { useStore } from './core/observable';
import { getDesktopShell } from './core/desktop/desktopShell';
import { Spinner } from './design/components/Spinner';
import { LoginView } from './features/auth/LoginView';
import { LegalGateView } from './features/auth/LegalGateView';
import { RiskDisclaimerView } from './features/auth/RiskDisclaimerView';
import { ServerSelectView } from './features/auth/ServerSelectView';
import { hostLabel } from './features/auth/serverSelect';
import { TradeScreen } from './features/trade/TradeScreen';

/** Fades each root state in on mount (keyed by state below); the global
    prefers-reduced-motion rule in base.css collapses the transition. */
function StateFade({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        opacity: visible ? 1 : 0,
        transition: 'opacity var(--dur-med) var(--ease-out)',
      }}
    >
      {children}
    </div>
  );
}

function StartupRecoveryCard({
  title,
  message,
  serverHost,
  onRetry,
  onChangeServer,
  onContinueToLogin,
}: {
  title: string;
  message: string;
  serverHost: string;
  onRetry: () => void;
  onChangeServer: () => void;
  onContinueToLogin: () => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--pad-screen)',
      }}
    >
      <div
        className="hud-panel"
        style={{
          width: '100%',
          maxWidth: 480,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-5)',
          padding: 'var(--space-6)',
          textAlign: 'center',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <h1 className="hud-title" style={{ fontSize: 'var(--fs-title2)' }}>
            {title}
          </h1>
          <p className="text-secondary" style={{ fontSize: 'var(--fs-subheadline)' }}>
            {message}
          </p>
          <p className="text-secondary" style={{ fontSize: 'var(--fs-footnote)' }}>
            Active server: {serverHost}
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <button type="button" className="button-primary" onClick={onRetry}>
            Retry Connection
          </button>
          <button
            type="button"
            style={{ fontSize: 'var(--fs-subheadline)', color: 'var(--app-accent)' }}
            onClick={onChangeServer}
          >
            Change Server
          </button>
          <button
            type="button"
            className="text-secondary"
            style={{ fontSize: 'var(--fs-footnote)' }}
            onClick={onContinueToLogin}
          >
            Continue to Login
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Top-level coordinator (RootView.swift):
 * checking session → first-launch risk disclaimer → server setup → login →
 * trade screen.
 */
export function RootView() {
  const container = useContainer();
  const { state, startupRecovery } = useStore(container.authStore);
  const { baseUrl } = useStore(container.serverConfigStore);
  const [slowRestore, setSlowRestore] = useState(false);
  const [manageServerPrefillUrl, setManageServerPrefillUrl] = useState<string | null>(null);

  useEffect(() => {
    void container.authStore.start();
  }, [container]);

  useEffect(() => {
    const desktopShell = getDesktopShell();
    if (!desktopShell) return;
    return desktopShell.onCommand((command) => {
      if (command.type === 'open-server-selector') {
        if (command.url) {
          container.authStore.clearStartupRecovery();
          setManageServerPrefillUrl(command.url);
        } else if (state === 'serverSetup') {
          container.authStore.clearStartupRecovery();
        } else {
          setManageServerPrefillUrl(baseUrl);
        }
        if (state === 'startupRecovery') {
          container.authStore.showServerSetup();
        }
        return;
      }
      container.settingsStore.lastSymbol = command.symbol;
      if (state === 'authenticated') {
        container.chartStore.selectSymbol(command.symbol);
      }
    });
  }, [baseUrl, container, state]);

  // Escalate if the session restore hangs (server unreachable, stalled
  // token refresh) instead of spinning forever.
  useEffect(() => {
    if (state !== 'checking') {
      setSlowRestore(false);
      return;
    }
    const timer = setTimeout(() => setSlowRestore(true), 8000);
    return () => clearTimeout(timer);
  }, [state]);

  // Foreground/visibility: re-establish the stream if it dropped.
  useEffect(() => {
    const onVisibilityChange = () => {
      // Both of these need a session. On the login screen they would open a
      // socket nobody is authorised for and issue a GET that 401s, surfacing a
      // stale error from the previous session.
      if (state !== 'authenticated') return;
      if (document.visibilityState === 'visible') {
        container.quoteSocket.reconnectIfNeeded();
        // A backgrounded tab can have its socket killed without a close event
        // ever arriving, so reconnectIfNeeded may see nothing to do. Re-read
        // the order lines regardless — they arm real orders.
        void container.chartOrdersStore.load();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [container, state]);

  const serverHost = useMemo(() => hostLabel(baseUrl), [baseUrl]);

  let content: ReactNode;
  if (state === 'checking') {
    content = (
      <div
        role="status"
        aria-live="polite"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 'var(--space-3)',
        }}
      >
        {/* The text label carries the meaning; hide the glyph from AT. */}
        <span aria-hidden="true">
          <Spinner size={24} />
        </span>
        <span className="text-secondary" style={{ fontSize: 'var(--fs-footnote)' }}>
          Restoring session…
        </span>
        {slowRestore ? (
          <>
            <span className="text-secondary" style={{ fontSize: 'var(--fs-footnote)' }}>
              Still reaching {serverHost}. This can take a few seconds if your backend is waking up.
            </span>
            <button
              style={{ fontSize: 'var(--fs-subheadline)', color: 'var(--app-accent)' }}
              onClick={() => void container.authStore.start()}
            >
              Retry
            </button>
          </>
        ) : null}
      </div>
    );
  } else if (state === 'disclaimer') {
    content = <RiskDisclaimerView store={container.authStore} />;
  } else if (state === 'serverSetup') {
    content = (
      <ServerSelectView
        mode="setup"
        prefillUrl={manageServerPrefillUrl}
        onContinue={(serverChanged) => {
          container.settingsStore.hasCompletedServerSelection = true;
          setManageServerPrefillUrl(null);
          if (!serverChanged) {
            container.authStore.completeServerSelection();
          }
        }}
      />
    );
  } else if (state === 'startupRecovery' && startupRecovery) {
    content = (
      <StartupRecoveryCard
        title={startupRecovery.title}
        message={startupRecovery.message}
        serverHost={serverHost}
        onRetry={() => void container.authStore.start()}
        onChangeServer={() => container.authStore.showServerSetup()}
        onContinueToLogin={() => {
          container.authStore.clearStartupRecovery();
          container.authStore.clearError();
          container.authStore.showLogin();
          setManageServerPrefillUrl(null);
        }}
      />
    );
  } else if (state === 'unauthenticated') {
    content = <LoginView store={container.authStore} />;
  } else if (state === 'legal') {
    content = <LegalGateView store={container.authStore} />;
  } else {
    content = (
      <TradeScreen
        onLogout={() => {
          // AppContainer outlives the screen, so per-account state has to be
          // dropped explicitly — otherwise the next sign-in draws the previous
          // account's order lines.
          container.chartOrdersStore.reset();
          return container.authStore.logout();
        }}
      />
    );
  }

  return (
    <div className="phone-frame">
      <div className="phone-content">
        <StateFade key={state}>{content}</StateFade>
        {manageServerPrefillUrl !== null && state !== 'serverSetup' ? (
          <ServerSelectView
            mode="manage"
            prefillUrl={manageServerPrefillUrl}
            onDismiss={() => setManageServerPrefillUrl(null)}
            onContinue={() => setManageServerPrefillUrl(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
