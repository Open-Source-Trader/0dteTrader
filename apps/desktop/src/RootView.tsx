import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useContainer } from './app/container';
import { useStore } from './core/observable';
import { Spinner } from './design/components/Spinner';
import { StatusBar } from './design/components/StatusBar';
import { LoginView } from './features/auth/LoginView';
import { RiskDisclaimerView } from './features/auth/RiskDisclaimerView';
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

/**
 * Top-level coordinator (RootView.swift):
 * checking session → first-launch risk disclaimer → login/register → trade
 * screen, framed by the cosmetic iPhone status bar and home indicator.
 */
export function RootView() {
  const container = useContainer();
  const { state } = useStore(container.authStore);
  const [slowRestore, setSlowRestore] = useState(false);

  useEffect(() => {
    void container.authStore.start();
  }, [container]);

  // Escalate if the session restore hangs (server unreachable, stalled
  // token refresh) instead of spinning forever.
  useEffect(() => {
    if (state !== 'checking') return;
    const timer = setTimeout(() => setSlowRestore(true), 8000);
    return () => clearTimeout(timer);
  }, [state]);

  // Foreground/visibility: re-establish the stream if it dropped.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        container.quoteSocket.reconnectIfNeeded();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [container]);

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
              Taking longer than expected — check your connection.
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
  } else if (state === 'unauthenticated') {
    content = <LoginView store={container.authStore} />;
  } else {
    content = <TradeScreen onLogout={() => container.authStore.logout()} />;
  }

  return (
    <div className="phone-frame">
      <StatusBar />
      <div className="phone-content">
        <StateFade key={state}>{content}</StateFade>
      </div>
      <div className="home-indicator" />
    </div>
  );
}
