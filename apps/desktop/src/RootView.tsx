import { useEffect } from 'react';
import { useContainer } from './app/container';
import { useStore } from './core/observable';
import { Spinner } from './design/components/Spinner';
import { StatusBar } from './design/components/StatusBar';
import { LoginView } from './features/auth/LoginView';
import { RiskDisclaimerView } from './features/auth/RiskDisclaimerView';
import { TradeScreen } from './features/trade/TradeScreen';

/**
 * Top-level coordinator (RootView.swift):
 * checking session → first-launch risk disclaimer → login/register → trade
 * screen, framed by the cosmetic iPhone status bar and home indicator.
 */
export function RootView() {
  const container = useContainer();
  const { state } = useStore(container.authStore);

  useEffect(() => {
    void container.authStore.start();
  }, [container]);

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

  return (
    <div className="phone-frame">
      <StatusBar />
      <div className="phone-content">
        {state === 'checking' ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
            }}
          >
            <Spinner size={22} />
            <span className="text-secondary" style={{ fontSize: 'var(--fs-footnote)' }}>
              Restoring session…
            </span>
          </div>
        ) : state === 'disclaimer' ? (
          <RiskDisclaimerView store={container.authStore} />
        ) : state === 'unauthenticated' ? (
          <LoginView store={container.authStore} />
        ) : (
          <TradeScreen onLogout={() => container.authStore.logout()} />
        )}
      </div>
      <div className="home-indicator" />
    </div>
  );
}
