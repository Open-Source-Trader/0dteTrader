import { useEffect, useMemo, useState } from 'react';
import type { BrokerProvider, CredentialProvider, TradingMode } from '@0dtetrader/shared-types';
import { useContainer } from '../../app/container';
import { useStore } from '../../core/observable';
import { AlertDialog } from '../../design/components/AlertDialog';
import { NavBar } from '../../design/components/NavBar';
import { Sheet } from '../../design/components/Sheet';
import { Spinner } from '../../design/components/Spinner';
import { Toggle } from '../../design/components/Toggle';
import { CheckCircleFillIcon, WarningFillIcon } from '../../design/icons';
import { ProfileStore } from './ProfileStore';
import { AlpacaCredentialsForm } from './AlpacaCredentialsForm';
import { TradierCredentialsForm } from './TradierCredentialsForm';
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
  const [deleteTarget, setDeleteTarget] = useState<{
    provider: CredentialProvider;
    environment: TradingMode;
    connectionId?: string;
  } | null>(null);
  const [showLogoutConfirmation, setShowLogoutConfirmation] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [bypassConfirmation, setBypassConfirmation] = useState(
    () => container.settingsStore.bypassOrderConfirmation,
  );

  const handleBypassChange = (on: boolean) => {
    setBypassConfirmation(on);
    container.settingsStore.bypassOrderConfirmation = on;
  };

  useEffect(() => {
    void store.load();
  }, [store]);

  const deleteCredentialsMessage = (target: {
    provider: CredentialProvider;
    environment: TradingMode;
  }) => {
    if (target.provider === 'tradier') {
      return "Index and options market data will fall back to the server's shared Tradier key.";
    }
    if (target.provider !== 'webull') {
      return 'Trading with this provider will stop working until new credentials are saved.';
    }
    if (target.environment === 'live') {
      return 'Trading will stop working until new credentials are saved.';
    }
    return "Practice trading will use the server's built-in practice app credentials.";
  };

  const renderAccountSection = () => {
    if (state.me) {
      return (
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
      );
    }
    if (state.isLoading) {
      return (
        <div className="grouped-row" aria-busy="true">
          <span className="skeleton skeleton-label" />
          <span className="skeleton skeleton-value row-value" />
        </div>
      );
    }
    return (
      <>
        <div className="grouped-row text-secondary">Account details unavailable</div>
        <button className="grouped-row button-row" onClick={() => void store.load()}>
          Retry
        </button>
      </>
    );
  };

  /** Success/error rows for one section. Keyed by provider AND environment —
   *  the Tradier sections render alongside the Webull ones, so the
   *  environment alone no longer identifies a section. */
  const renderSectionMessages = (provider: CredentialProvider, environment: TradingMode) => (
    <>
      {state.messageProvider === provider &&
      state.messageEnv === environment &&
      state.successMessage ? (
        <div className="grouped-row footnote positive" role="status">
          <CheckCircleFillIcon size={14} />
          <span>{state.successMessage}</span>
        </div>
      ) : null}
      {state.messageProvider === provider &&
      state.messageEnv === environment &&
      state.errorMessage ? (
        <div className="grouped-row footnote negative" role="alert">
          <WarningFillIcon size={14} />
          <span>{state.errorMessage}</span>
        </div>
      ) : null}
    </>
  );

  const renderCredentialsSection = (environment: TradingMode, configured: boolean) => {
    const env = state[environment];
    const title = environment === 'live' ? 'Webull API — Live' : 'Webull API — Practice';
    const accountId =
      environment === 'live' ? state.me?.webullAccountId : state.me?.webullPracticeAccountId;
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
              <div className="grouped-row">
                <span>Account</span>
                <span className="row-value text-secondary">
                  {accountId ?? 'detected after first connection'}
                </span>
              </div>
              <div className="grouped-row account-selector-row">
                <span>Connected Webull account</span>
                {state.webullAccounts[environment]?.length > 0 ? (
                  <select
                    aria-label={`${title} connected account`}
                    value={accountId ?? ''}
                    disabled={state.selectingAccount[environment]}
                    onChange={(event) => {
                      if (event.target.value === '') return;
                      void store.selectWebullAccount(environment, event.target.value);
                    }}
                  >
                    <option value="" disabled>
                      Select an account
                    </option>
                    {state.webullAccounts[environment]?.map((account) => (
                      <option key={account.accountId} value={account.accountId}>
                        {account.accountName ?? account.accountType ?? 'Webull account'} —{' '}
                        {account.accountId}
                      </option>
                    ))}
                  </select>
                ) : (
                  <button
                    className="inline-button"
                    disabled={state.loadingAccounts[environment]}
                    onClick={() => void store.loadWebullAccounts(environment)}
                  >
                    {state.loadingAccounts[environment] ? <Spinner size={14} /> : 'Choose account'}
                  </button>
                )}
              </div>
              <div className="grouped-row footnote text-secondary">
                Credentials are stored encrypted on the server and are never displayed here.
              </div>
              <button
                type="button"
                className="grouped-row button-row"
                onClick={() => store.setEditing(environment, true)}
              >
                Update Credentials
              </button>
              {state.me?.tradingMode === environment ? (
                <button
                  type="button"
                  className="grouped-row button-row"
                  disabled={env.isReconnecting}
                  onClick={() => void store.reconnect(environment)}
                >
                  {env.isReconnecting ? <Spinner size={14} /> : 'Reconnect to Webull'}
                </button>
              ) : null}
              <button
                type="button"
                className="grouped-row destructive"
                disabled={env.isDeleting}
                onClick={() => setDeleteTarget({ provider: 'webull', environment })}
              >
                {env.isDeleting ? <Spinner size={14} /> : 'Delete Credentials'}
              </button>
            </>
          ) : (
            <>
              <WebullCredentialsForm store={store} environment={environment} />
              {configured ? (
                <button
                  type="button"
                  className="grouped-row button-row"
                  onClick={() => store.setEditing(environment, false)}
                >
                  Cancel Update
                </button>
              ) : null}
            </>
          )}

          {renderSectionMessages('webull', environment)}
        </div>
        <div className="section-footer">
          {environment === 'live'
            ? 'Your app key, app secret, and account ID come from the Webull OpenAPI developer portal.'
            : "Optional paper-trading credentials. If left blank, the server's built-in practice app credentials are used."}
        </div>
      </div>
    );
  };

  const renderAlpacaSection = (environment: TradingMode, configured: boolean) => {
    const env = state.alpaca[environment];
    const title = environment === 'live' ? 'Alpaca API — Live' : 'Alpaca API — Practice';
    const accountId =
      environment === 'live' ? state.me?.alpacaAccountId : state.me?.alpacaPracticeAccountId;
    return (
      <div className="grouped-section" key={`alpaca-${environment}`}>
        <div className="section-header">{title}</div>
        <div className="section-card">
          {configured && !env.isEditing ? (
            <>
              <div className="grouped-row positive">
                <CheckCircleFillIcon size={14} />
                <span>Configured</span>
              </div>
              <div className="grouped-row">
                <span>Account</span>
                <span className="row-value text-secondary">
                  {accountId ?? 'key-scoped (no account id)'}
                </span>
              </div>
              <div className="grouped-row footnote text-secondary">
                Credentials are stored encrypted on the server and are never displayed here.
              </div>
              <button
                type="button"
                className="grouped-row button-row"
                onClick={() => store.setAlpacaEditing(environment, true)}
              >
                Update Credentials
              </button>
              <button
                type="button"
                className="grouped-row destructive"
                disabled={env.isDeleting}
                onClick={() => setDeleteTarget({ provider: 'alpaca', environment })}
              >
                {env.isDeleting ? <Spinner size={14} /> : 'Delete Credentials'}
              </button>
            </>
          ) : (
            <>
              <AlpacaCredentialsForm store={store} environment={environment} />
              {configured ? (
                <button
                  type="button"
                  className="grouped-row button-row"
                  onClick={() => store.setAlpacaEditing(environment, false)}
                >
                  Cancel Update
                </button>
              ) : null}
            </>
          )}

          {renderSectionMessages('alpaca', environment)}
        </div>
        <div className="section-footer">
          {environment === 'live'
            ? 'Your API Key and Secret come from the Alpaca dashboard (use the matching live or paper key).'
            : 'Optional paper-trading key/secret.'}
        </div>
      </div>
    );
  };

  const renderTradierSection = (environment: TradingMode, configured: boolean) => {
    const env = state.tradier[environment];
    const title =
      environment === 'live' ? 'Tradier API — Live' : 'Tradier API — Practice (sandbox)';
    return (
      <div className="grouped-section" key={`tradier-${environment}`}>
        <div className="section-header">{title}</div>
        <div className="section-card">
          {configured && !env.isEditing ? (
            <>
              <div className="grouped-row positive">
                <CheckCircleFillIcon size={14} />
                <span>Configured</span>
              </div>
              <div className="grouped-row footnote text-secondary">
                The key is stored encrypted on the server and is never displayed here.
              </div>
              <button
                className="grouped-row button-row"
                onClick={() => store.setTradierEditing(environment, true)}
              >
                Update API Key
              </button>
              <button
                className="grouped-row destructive"
                disabled={env.isDeleting}
                onClick={() => setDeleteTarget({ provider: 'tradier', environment })}
              >
                {env.isDeleting ? <Spinner size={14} /> : 'Delete API Key'}
              </button>
            </>
          ) : (
            <>
              <TradierCredentialsForm store={store} environment={environment} />
              {configured ? (
                <button
                  className="grouped-row button-row"
                  onClick={() => store.setTradierEditing(environment, false)}
                >
                  Cancel Update
                </button>
              ) : null}
            </>
          )}

          {renderSectionMessages('tradier', environment)}
        </div>
        <div className="section-footer">
          {environment === 'live'
            ? 'Optional. Tradier supplies index and options market data alongside Webull; your access token comes from the Tradier dashboard.'
            : 'Optional sandbox access token for practice mode.'}
        </div>
      </div>
    );
  };

  const renderSnapTradeSection = (environment: TradingMode) => {
    const env = store.snaptradeEnvironment(environment);
    const title = environment === 'live' ? 'SnapTrade — Live' : 'SnapTrade — Practice';
    const selectedAccountId = env.status.selectedAccountId;
    const activeConnection = env.connections.find((c) => c.status === 'active');
    return (
      <div className="grouped-section" key={`snaptrade-${environment}`}>
        <div className="section-header">{title}</div>
        <div className="section-card">
          {env.status.configured && activeConnection ? (
            <>
              <div className="grouped-row positive">
                <CheckCircleFillIcon size={14} />
                <span>Connected to {activeConnection.brokerage}</span>
              </div>
              <div className="grouped-row">
                <span>Account</span>
                <span className="row-value text-secondary">
                  {selectedAccountId ?? 'not selected'}
                </span>
              </div>
              {env.accounts[activeConnection.connectionId]?.length ? (
                <div className="grouped-row">
                  <span>Available accounts</span>
                  <select
                    className="select-input"
                    value={selectedAccountId ?? ''}
                    onChange={(event) => {
                      const accountId = event.target.value;
                      if (accountId) {
                        void store.selectSnapTradeAccount(
                          environment,
                          activeConnection.connectionId,
                          accountId,
                        );
                      }
                    }}
                  >
                    <option value="">Select account…</option>
                    {env.accounts[activeConnection.connectionId].map((account) => (
                      <option key={account.accountId} value={account.accountId}>
                        {account.name} ({account.accountId})
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div className="grouped-row footnote text-secondary">
                Credentials are managed through SnapTrade's Connection Portal.
              </div>
              <button
                type="button"
                className="grouped-row button-row"
                disabled={env.isReconnecting}
                onClick={() =>
                  void store.reconnectSnapTrade(environment, activeConnection.connectionId)
                }
              >
                {env.isReconnecting ? <Spinner size={14} /> : 'Reconnect to Brokerage'}
              </button>
              <button
                type="button"
                className="grouped-row destructive"
                disabled={env.isDisconnecting}
                onClick={() =>
                  setDeleteTarget({
                    provider: 'snaptrade',
                    environment,
                    connectionId: activeConnection.connectionId,
                  })
                }
              >
                {env.isDisconnecting ? <Spinner size={14} /> : 'Disconnect Brokerage'}
              </button>
            </>
          ) : (
            <>
              <div className="grouped-row text-secondary">No brokerage connected yet.</div>
              <button
                type="button"
                className="grouped-row button-row"
                disabled={env.isConnecting}
                onClick={() => void store.connectSnapTrade(environment)}
              >
                {env.isConnecting ? <Spinner size={14} /> : 'Connect Brokerage'}
              </button>
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
          Connect your brokerage account through SnapTrade's secure Connection Portal.
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
            <button type="button" className="navbar-text-button" onClick={onDismiss}>
              Done
            </button>
          }
        />
        <div className="sheet-body grouped-list hide-scrollbar">
          {/* Account */}
          <div className="grouped-section">
            <div className="section-header">Account</div>
            <div className="section-card">{renderAccountSection()}</div>
          </div>

          {/* Trading provider selector (webull | alpaca). */}
          <div className="grouped-section">
            <div className="section-header">Trading Provider</div>
            <div className="section-card">
              <div className="segmented-control" role="group" aria-label="Trading provider">
                {(['webull', 'alpaca', 'snaptrade'] as BrokerProvider[]).map((provider) => (
                  <button
                    key={provider}
                    type="button"
                    className={`segment${state.tradingProvider === provider ? ' active' : ''}`}
                    aria-pressed={state.tradingProvider === provider}
                    onClick={async () => {
                      await store.setTradingProvider(provider);
                      // Re-establish the market-data stream so live quotes use the
                      // newly selected provider immediately (the subscription was
                      // established under the previous provider).
                      container.quoteSocket.reconnect();
                    }}
                  >
                    {provider === 'webull'
                      ? 'Webull'
                      : provider === 'alpaca'
                        ? 'Alpaca'
                        : 'SnapTrade'}
                  </button>
                ))}
              </div>
            </div>
            <div className="section-footer">
              Switch providers any time. Credentials for the other provider stay saved.
            </div>
          </div>

          {state.tradingProvider === 'webull' ? (
            <>
              {renderCredentialsSection('live', state.me?.webullConfigured === true)}
              {renderCredentialsSection('practice', state.me?.webullPracticeConfigured === true)}
              {/* Tradier market-data key rides along with Webull only —
                  Alpaca supplies its own data, so no key is needed there. */}
              {renderTradierSection('live', state.me?.tradierConfigured === true)}
              {renderTradierSection('practice', state.me?.tradierPracticeConfigured === true)}
            </>
          ) : state.tradingProvider === 'alpaca' ? (
            <>
              {renderAlpacaSection('live', state.me?.alpacaConfigured === true)}
              {renderAlpacaSection('practice', state.me?.alpacaPracticeConfigured === true)}
            </>
          ) : (
            <>
              {renderSnapTradeSection('live')}
              {renderSnapTradeSection('practice')}
            </>
          )}

          {/* Trading */}
          <div className="grouped-section">
            <div className="section-header">Trading</div>
            <div className="section-card">
              <div className="grouped-row">
                <span>Skip order confirmation</span>
                <span style={{ marginLeft: 'auto' }}>
                  <Toggle on={bypassConfirmation} onChange={handleBypassChange} />
                </span>
              </div>
            </div>
            <div className="section-footer">
              When on, tapping Buy or Sell places the order immediately without the confirmation
              step. This device only.
            </div>
          </div>

          {/* Security section intentionally omitted: Face ID / AppLockManager is
              iOS-only (ProfileView.swift securitySection). */}
          {/* Session */}
          <div className="grouped-section">
            <div className="section-card">
              <button
                type="button"
                className="grouped-row destructive"
                disabled={isLoggingOut}
                onClick={() => setShowLogoutConfirmation(true)}
              >
                {isLoggingOut ? <Spinner size={14} /> : 'Log Out'}
              </button>
            </div>
          </div>
        </div>

        {deleteTarget ? (
          <AlertDialog
            title={`Remove ${deleteTarget.environment === 'live' ? 'Live' : 'Practice'} ${
              { webull: 'Webull', alpaca: 'Alpaca', tradier: 'Tradier', snaptrade: 'SnapTrade' }[
                deleteTarget.provider
              ]
            } ${deleteTarget.provider === 'tradier' ? 'API key' : 'credentials'}?`}
            message={deleteCredentialsMessage(deleteTarget)}
            actions={[
              {
                label:
                  deleteTarget.provider === 'tradier' ? 'Delete API Key' : 'Delete Credentials',
                role: 'destructive',
                onSelect: () => {
                  if (deleteTarget.provider === 'webull') {
                    void store.deleteCredentials(deleteTarget.environment);
                  } else if (deleteTarget.provider === 'alpaca') {
                    void store.deleteAlpacaCredentials(deleteTarget.environment);
                  } else if (deleteTarget.provider === 'tradier') {
                    void store.deleteTradierCredentials(deleteTarget.environment);
                  } else if (deleteTarget.connectionId) {
                    void store.disconnectSnapTrade(
                      deleteTarget.environment,
                      deleteTarget.connectionId,
                    );
                  }
                },
              },
              { label: 'Cancel', role: 'cancel' },
            ]}
            onDismiss={() => setDeleteTarget(null)}
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
