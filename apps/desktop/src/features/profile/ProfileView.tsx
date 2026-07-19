import { useEffect, useMemo, useState } from 'react';
import type { TradingMode } from '@0dtetrader/shared-types';
import { useContainer } from '../../app/container';
import { useStore } from '../../core/observable';
import { AlertDialog } from '../../design/components/AlertDialog';
import { NavBar } from '../../design/components/NavBar';
import { Sheet } from '../../design/components/Sheet';
import { Spinner } from '../../design/components/Spinner';
import { CheckCircleFillIcon, WarningFillIcon } from '../../design/icons';
import { ProfileStore } from './ProfileStore';
import { WebullCredentialsForm } from './WebullCredentialsForm';
import './profile.css';

interface ProfileViewProps {
  onLogout: () => Promise<void>;
  onDismiss: () => void;
}

export function ProfileView({ onLogout, onDismiss }: ProfileViewProps) {
  const container = useContainer();
  const store = useMemo(() => new ProfileStore(container.apiClient), [container]);
  const state = useStore(store);
  const [deleteEnv, setDeleteEnv] = useState<TradingMode | null>(null);
  const [showLogoutConfirmation, setShowLogoutConfirmation] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  useEffect(() => {
    void store.load();
  }, [store]);

  const renderCredentialsSection = (
    environment: TradingMode,
    configured: boolean,
  ) => {
    const env = state[environment];
    const title = environment === 'live' ? 'Webull API — Live' : 'Webull API — Practice';
    return (
      <div className="grouped-section" key={environment}>
        <div className="section-header">{title}</div>
        <div className="section-card">
          {configured && !env.isEditing ? (
            <>
              <div className="grouped-row positive">
                <CheckCircleFillIcon size={14} />
                <span>Configured</span>
              </div>
              <div className="grouped-row footnote text-secondary">
                Credentials are stored encrypted on the server and are never displayed here.
              </div>
              <button
                className="grouped-row button-row"
                onClick={() => store.setEditing(environment, true)}
              >
                Update Credentials
              </button>
              {state.me?.tradingMode === environment ? (
                <button
                  className="grouped-row button-row"
                  disabled={env.isReconnecting}
                  onClick={() => void store.reconnect(environment)}
                >
                  {env.isReconnecting ? <Spinner size={14} /> : 'Reconnect to Webull'}
                </button>
              ) : null}
              <button
                className="grouped-row destructive"
                disabled={env.isDeleting}
                onClick={() => setDeleteEnv(environment)}
              >
                {env.isDeleting ? <Spinner size={14} /> : 'Delete Credentials'}
              </button>
            </>
          ) : (
            <>
              <WebullCredentialsForm store={store} environment={environment} />
              {configured ? (
                <button
                  className="grouped-row button-row"
                  onClick={() => store.setEditing(environment, false)}
                >
                  Cancel Update
                </button>
              ) : null}
            </>
          )}

          {state.messageEnv === environment && state.successMessage ? (
            <div className="grouped-row footnote positive" role="status">
              <CheckCircleFillIcon size={14} />
              <span>{state.successMessage}</span>
            </div>
          ) : null}
          {state.messageEnv === environment && state.errorMessage ? (
            <div className="grouped-row footnote negative" role="alert">
              <WarningFillIcon size={14} />
              <span>{state.errorMessage}</span>
            </div>
          ) : null}
        </div>
        <div className="section-footer">
          {environment === 'live'
            ? 'Your app key, app secret, and account ID come from the Webull OpenAPI developer portal.'
            : "Optional paper-trading credentials. If left blank, the server's built-in practice app credentials are used."}
        </div>
      </div>
    );
  };

  return (
    <Sheet detent="large" onDismiss={onDismiss}>
      <div className="profile-view">
        <NavBar
          title="Profile"
          trailing={
            <button className="navbar-text-button" onClick={onDismiss}>
              Done
            </button>
          }
        />
        <div className="sheet-body grouped-list hide-scrollbar">
          {/* Account */}
          <div className="grouped-section">
            <div className="section-header">Account</div>
            <div className="section-card">
              {state.me ? (
                <>
                  <div className="grouped-row">
                    <span>Email</span>
                    <span className="row-value" title={state.me.email}>
                      {state.me.email}
                    </span>
                  </div>
                  {state.me.tradingDisabled ? (
                    <div className="grouped-row footnote negative">
                      <WarningFillIcon size={14} />
                      <span>Trading is disabled (kill switch active)</span>
                    </div>
                  ) : null}
                </>
              ) : state.isLoading ? (
                <div className="grouped-row" aria-busy="true">
                  <span className="skeleton skeleton-label" />
                  <span className="skeleton skeleton-value row-value" />
                </div>
              ) : (
                <>
                  <div className="grouped-row text-secondary">Account details unavailable</div>
                  <button className="grouped-row button-row" onClick={() => void store.load()}>
                    Retry
                  </button>
                </>
              )}
            </div>
          </div>

          {renderCredentialsSection('live', state.me?.webullConfigured === true)}
          {renderCredentialsSection('practice', state.me?.webullPracticeConfigured === true)}

          {/* Security section intentionally omitted: Face ID / AppLockManager is
              iOS-only (ProfileView.swift securitySection). */}
          {/* Session */}
          <div className="grouped-section">
            <div className="section-card">
              <button
                className="grouped-row destructive"
                disabled={isLoggingOut}
                onClick={() => setShowLogoutConfirmation(true)}
              >
                {isLoggingOut ? <Spinner size={14} /> : 'Log Out'}
              </button>
            </div>
          </div>
        </div>

        {deleteEnv ? (
          <AlertDialog
            title={`Remove ${deleteEnv === 'live' ? 'Live' : 'Practice'} Webull credentials?`}
            message={
              deleteEnv === 'live'
                ? 'Trading will stop working until new credentials are saved.'
                : "Practice trading will use the server's built-in practice app credentials."
            }
            actions={[
              {
                label: 'Delete Credentials',
                role: 'destructive',
                onSelect: () => void store.deleteCredentials(deleteEnv),
              },
              { label: 'Cancel', role: 'cancel' },
            ]}
            onDismiss={() => setDeleteEnv(null)}
          />
        ) : null}

        {showLogoutConfirmation ? (
          <AlertDialog
            title="Log out of 0dteTrader?"
            message="Open positions are unaffected; live quotes will stop."
            actions={[
              {
                label: 'Log Out',
                role: 'destructive',
                onSelect: () => {
                  setIsLoggingOut(true);
                  void onLogout().then(onDismiss);
                },
              },
              { label: 'Cancel', role: 'cancel' },
            ]}
            onDismiss={() => setShowLogoutConfirmation(false)}
          />
        ) : null}
      </div>
    </Sheet>
  );
}
