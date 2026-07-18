import { useEffect, useMemo, useState } from 'react';
import { useContainer } from '../../app/container';
import { useStore } from '../../core/observable';
import { AlertDialog } from '../../design/components/AlertDialog';
import { NavBar } from '../../design/components/NavBar';
import { Sheet } from '../../design/components/Sheet';
import { Spinner } from '../../design/components/Spinner';
import { CheckCircleFillIcon, WarningFillIcon } from '../../design/icons';
import { ProfileStore } from './ProfileStore';
import { WebullCredentialsForm } from './WebullCredentialsForm';

interface ProfileViewProps {
  onLogout: () => Promise<void>;
  onDismiss: () => void;
}

export function ProfileView({ onLogout, onDismiss }: ProfileViewProps) {
  const container = useContainer();
  const store = useMemo(() => new ProfileStore(container.apiClient), [container]);
  const state = useStore(store);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);

  useEffect(() => {
    void store.load();
  }, [store]);

  const webullConfigured = state.me?.webullConfigured === true;

  return (
    <Sheet detent="large" onDismiss={onDismiss}>
      <div
        style={{
          background: 'var(--app-background)',
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
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
                    <span className="row-value">{state.me.email}</span>
                  </div>
                  {state.me.tradingDisabled ? (
                    <div
                      className="grouped-row"
                      style={{ color: 'var(--pnl-negative)', fontSize: 'var(--fs-footnote)' }}
                    >
                      <WarningFillIcon size={14} />
                      <span>Trading is disabled (kill switch active)</span>
                    </div>
                  ) : null}
                </>
              ) : state.isLoading ? (
                <div className="grouped-row">
                  <Spinner size={16} />
                </div>
              ) : (
                <div className="grouped-row text-secondary">Account details unavailable</div>
              )}
            </div>
          </div>

          {/* Webull API */}
          <div className="grouped-section">
            <div className="section-header">Webull API</div>
            <div className="section-card">
              {webullConfigured && !state.isEditingCredentials ? (
                <>
                  <div className="grouped-row" style={{ color: 'var(--pnl-positive)' }}>
                    <CheckCircleFillIcon size={15} />
                    <span>Configured</span>
                  </div>
                  <div
                    className="grouped-row text-secondary"
                    style={{ fontSize: 'var(--fs-footnote)' }}
                  >
                    Credentials are stored encrypted on the server and are never displayed here.
                  </div>
                  <button className="grouped-row button-row" onClick={() => store.setEditing(true)}>
                    Update Credentials
                  </button>
                  <button
                    className="grouped-row destructive"
                    disabled={state.isDeletingCredentials}
                    onClick={() => setShowDeleteConfirmation(true)}
                  >
                    {state.isDeletingCredentials ? <Spinner size={14} /> : 'Delete Credentials'}
                  </button>
                </>
              ) : (
                <>
                  <WebullCredentialsForm store={store} />
                  {webullConfigured ? (
                    <button
                      className="grouped-row button-row"
                      onClick={() => store.setEditing(false)}
                    >
                      Cancel Update
                    </button>
                  ) : null}
                </>
              )}

              {state.successMessage ? (
                <div
                  className="grouped-row"
                  style={{ color: 'var(--pnl-positive)', fontSize: 'var(--fs-footnote)' }}
                >
                  {state.successMessage}
                </div>
              ) : null}
              {state.errorMessage ? (
                <div
                  className="grouped-row"
                  style={{ color: 'var(--pnl-negative)', fontSize: 'var(--fs-footnote)' }}
                >
                  {state.errorMessage}
                </div>
              ) : null}
            </div>
            <div className="section-footer">
              Your app key, app secret, and account ID come from the Webull OpenAPI developer
              portal.
            </div>
          </div>

          {/* Session */}
          <div className="grouped-section">
            <div className="section-card">
              <button
                className="grouped-row destructive"
                onClick={() => {
                  void onLogout().then(onDismiss);
                }}
              >
                Log Out
              </button>
            </div>
          </div>
        </div>

        {showDeleteConfirmation ? (
          <AlertDialog
            title="Remove Webull credentials?"
            message="Trading will stop working until new credentials are saved."
            actions={[
              {
                label: 'Delete Credentials',
                role: 'destructive',
                onSelect: () => void store.deleteCredentials(),
              },
              { label: 'Cancel', role: 'cancel' },
            ]}
            onDismiss={() => setShowDeleteConfirmation(false)}
          />
        ) : null}
      </div>
    </Sheet>
  );
}
