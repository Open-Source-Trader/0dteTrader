import { useEffect, useMemo, useState } from 'react';
import type {
  BrokerProvider,
  CredentialProvider,
  DiscordNotificationSettings,
  LegalAcceptanceStatus,
  LegalDocument,
  LegalDocumentSlug,
  TradingMode,
} from '@0dtetrader/shared-types';
import { useContainer } from '../../app/container';
import { useStore } from '../../core/observable';
import { AlertDialog } from '../../design/components/AlertDialog';
import { DesktopSheet } from '../../design/components/DesktopSheet';
import { NavBar } from '../../design/components/NavBar';
import { SegmentedControl } from '../../design/components/SegmentedControl';
import { Sheet } from '../../design/components/Sheet';
import { Spinner } from '../../design/components/Spinner';
import { Toggle } from '../../design/components/Toggle';
import { CheckCircleFillIcon, WarningFillIcon } from '../../design/icons';
import { LegalMarkdown } from '../legal/LegalMarkdown';
import { ProfileStore } from './ProfileStore';
import { ProfileStoreProvider } from './ProfileStoreContext';
import { useProfileStore } from './useProfileStore';
import { AlpacaCredentialsForm } from './AlpacaCredentialsForm';
import { SnapTradeCredentialsForm } from './SnapTradeCredentialsForm';
import { TradierCredentialsForm } from './TradierCredentialsForm';
import { WebullCredentialsForm } from './WebullCredentialsForm';
import './profile.css';

interface ProfileViewProps {
  onLogout: () => Promise<void>;
  onDismiss: () => void;
  /** Desktop grid: centered floating panel instead of an iOS bottom sheet. */
  dense?: boolean;
  /** Render just the settings content, no NavBar/Sheet chrome — used when
   *  embedded as a tab inside DesktopSettingsPanel, which supplies its own
   *  window chrome and tab navigation. */
  bodyOnly?: boolean;
}

type DeleteTarget = {
  provider: CredentialProvider | 'snaptrade-key';
  environment: TradingMode;
  connectionId?: string;
};

function deleteActionLabel(target: DeleteTarget): string {
  if (target.connectionId) return 'Disconnect';
  if (target.provider === 'tradier') return 'Delete API Key';
  return 'Delete Credentials';
}

function deleteTargetTitle(target: DeleteTarget): string {
  if (target.connectionId) return 'Disconnect brokerage?';
  const envLabel = target.environment === 'live' ? 'Live' : 'Practice';
  if (target.provider === 'webull') return `Remove ${envLabel} Webull credentials?`;
  if (target.provider === 'alpaca') return `Remove ${envLabel} Alpaca credentials?`;
  if (target.provider === 'tradier') return `Remove ${envLabel} Tradier API key?`;
  return `Remove ${envLabel} SnapTrade credentials?`;
}

function deleteCredentialsMessage(target: DeleteTarget): string {
  if (target.provider === 'tradier') {
    return "Index and options market data will fall back to the server's shared Tradier key.";
  }
  if (target.provider === 'snaptrade-key') {
    return 'Any connected SnapTrade brokerages will stop working until new credentials are saved.';
  }
  if (target.provider !== 'webull') {
    return 'Trading with this provider will stop working until new credentials are saved.';
  }
  if (target.environment === 'live') {
    return 'Trading will stop working until new credentials are saved.';
  }
  return "Practice trading will use the server's built-in practice app credentials.";
}

function AccountSection() {
  const store = useProfileStore();
  const state = useStore(store);
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
}

function DiscordAndLegalSection({ onAccountDeleted }: { onAccountDeleted: () => void }) {
  const container = useContainer();
  const store = useProfileStore();
  const profile = useStore(store);
  const [discord, setDiscord] = useState<DiscordNotificationSettings | null>(null);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [legal, setLegal] = useState<LegalAcceptanceStatus | null>(null);
  const [document, setDocument] = useState<LegalDocument | null>(null);
  const [deleteEmail, setDeleteEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [discordLoadFailed, setDiscordLoadFailed] = useState(false);
  const [legalLoadFailed, setLegalLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void container.apiClient
      .discordSettings()
      .then((value) => {
        if (cancelled) return;
        setDiscord(value);
        setDiscordLoadFailed(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setDiscordLoadFailed(true);
        setMessage(error instanceof Error ? error.message : String(error));
      });
    void container.apiClient
      .legalStatus()
      .then((value) => {
        if (cancelled) return;
        setLegal(value);
        setLegalLoadFailed(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setLegalLoadFailed(true);
        setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [container]);

  const reloadDiscord = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setDiscord(await container.apiClient.discordSettings());
      setDiscordLoadFailed(false);
    } catch (error) {
      setDiscordLoadFailed(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const reloadLegalStatus = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setLegal(await container.apiClient.legalStatus());
      setLegalLoadFailed(false);
    } catch (error) {
      setLegalLoadFailed(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const openDocument = async (slug: LegalDocumentSlug) => {
    setBusy(true);
    setMessage(null);
    setDocument(null);
    try {
      setDocument(await container.apiClient.legalDocument(slug));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="grouped-section">
        <div className="section-header">Discord</div>
        <div className="section-card">
          {discordLoadFailed ? (
            <button
              className="grouped-row button-row"
              disabled={busy}
              onClick={() => void reloadDiscord()}
            >
              Retry Loading Discord Settings
            </button>
          ) : null}
          <label className="grouped-row">
            <span>Webhook URL</span>
            <input
              type="password"
              value={webhookUrl}
              placeholder={discord?.maskedWebhookUrl ?? 'https://discord.com/api/webhooks/...'}
              onChange={(event) => setWebhookUrl(event.target.value)}
            />
          </label>
          <div className="grouped-row">
            <span>Post filled orders</span>
            <span style={{ marginLeft: 'auto' }}>
              <Toggle
                on={discord?.enabled ?? false}
                onChange={(enabled) => setDiscord((current) => current && { ...current, enabled })}
              />
            </span>
          </div>
          <div className="grouped-row">
            <span>Include realized P/L</span>
            <span style={{ marginLeft: 'auto' }}>
              <Toggle
                on={discord?.includePnl ?? false}
                onChange={(includePnl) =>
                  setDiscord((current) => current && { ...current, includePnl })
                }
              />
            </span>
          </div>
          <button
            className="grouped-row button-row"
            disabled={!discord || busy}
            onClick={() => {
              if (!discord) return;
              setBusy(true);
              void container.apiClient
                .updateDiscordSettings({
                  ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
                  enabled: discord.enabled,
                  includePnl: discord.includePnl,
                })
                .then((value) => {
                  setDiscord(value);
                  setWebhookUrl('');
                  setMessage('Discord settings saved.');
                })
                .catch((error) =>
                  setMessage(error instanceof Error ? error.message : String(error)),
                )
                .finally(() => setBusy(false));
            }}
          >
            Save Discord Settings
          </button>
          <button
            className="grouped-row button-row"
            disabled={!discord?.configured || busy}
            onClick={() => {
              setBusy(true);
              void container.apiClient
                .testDiscord()
                .then(() => setMessage('Test notification sent.'))
                .catch((error) =>
                  setMessage(error instanceof Error ? error.message : String(error)),
                )
                .finally(() => setBusy(false));
            }}
          >
            Send Test Notification
          </button>
        </div>
      </div>

      <div className="grouped-section">
        <div className="section-header">About & Legal</div>
        <div className="section-card">
          <div className="grouped-row">
            <span>Version</span>
            <span className="row-value">
              {__APP_VERSION__} ({__BUILD_IDENTIFIER__.slice(0, 12)})
            </span>
          </div>
          {legal?.documents.map((item) => (
            <div className="grouped-row" key={item.slug}>
              <button
                className="inline-button"
                disabled={busy}
                onClick={() => void openDocument(item.slug)}
              >
                {item.title}
              </button>
              {item.requiresAcceptance &&
                (item.accepted ? (
                  <span className="row-value positive">Accepted</span>
                ) : (
                  <button
                    className="inline-button row-value"
                    disabled={busy}
                    onClick={() => void openDocument(item.slug)}
                  >
                    Review & accept
                  </button>
                ))}
            </div>
          ))}
          {legalLoadFailed ? (
            <button
              className="grouped-row button-row"
              disabled={busy}
              onClick={() => void reloadLegalStatus()}
            >
              Retry Loading Legal Documents
            </button>
          ) : null}
          {document ? (
            <div className="grouped-row legal-document" role="region">
              <div>
                <strong>{document.title}</strong>
                <LegalMarkdown markdown={document.markdown} style={{ marginTop: 8 }} />
                {document.requiresAcceptance &&
                !legal?.documents.find((item) => item.slug === document.slug)?.accepted ? (
                  <button
                    className="inline-button"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setMessage(null);
                      void container.apiClient
                        .acceptLegal(document.slug as 'terms' | 'risk', document.version)
                        .then((value) => {
                          setLegal(value);
                          setMessage(`${document.title} accepted.`);
                        })
                        .catch((error) =>
                          setMessage(error instanceof Error ? error.message : String(error)),
                        )
                        .finally(() => setBusy(false));
                    }}
                  >
                    Accept {document.title}
                  </button>
                ) : null}
                <button className="inline-button" onClick={() => setDocument(null)}>
                  Close
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="grouped-section">
        <div className="section-header">Delete Account</div>
        <div className="section-card">
          <label className="grouped-row">
            <span>Confirm email</span>
            <input
              type="email"
              value={deleteEmail}
              placeholder={profile.me?.email ?? 'you@example.com'}
              onChange={(event) => setDeleteEmail(event.target.value)}
            />
          </label>
          <button
            className="grouped-row destructive"
            disabled={busy || deleteEmail.trim() === ''}
            onClick={() => {
              if (!window.confirm('Permanently delete this account and all stored data?')) return;
              setBusy(true);
              void container.apiClient
                .deleteAccount(deleteEmail)
                .then(onAccountDeleted)
                .catch((error) =>
                  setMessage(error instanceof Error ? error.message : String(error)),
                )
                .finally(() => setBusy(false));
            }}
          >
            Permanently Delete Account
          </button>
        </div>
        {message ? <div className="section-footer">{message}</div> : null}
      </div>
    </>
  );
}

/** Success/error rows for one section. Keyed by provider AND environment —
 *  several sections can render for the same environment (e.g. Webull +
 *  Tradier), so the environment alone doesn't identify a section. SnapTrade
 *  key/connection actions don't set messageProvider, so those sections match
 *  on environment only. */
function SectionMessages({
  provider,
  environment,
}: {
  provider?: CredentialProvider;
  environment: TradingMode;
}) {
  const store = useProfileStore();
  const state = useStore(store);
  const providerMatches = provider === undefined || state.messageProvider === provider;
  if (!providerMatches || state.messageEnv !== environment) return null;
  return (
    <>
      {state.successMessage ? (
        <div className="grouped-row footnote positive" role="status">
          <CheckCircleFillIcon size={14} />
          <span>{state.successMessage}</span>
        </div>
      ) : null}
      {state.errorMessage ? (
        <div className="grouped-row footnote negative" role="alert">
          <WarningFillIcon size={14} />
          <span>{state.errorMessage}</span>
        </div>
      ) : null}
    </>
  );
}

function WebullCredentialsSection({
  environment,
  configured,
  onRequestDelete,
}: {
  environment: TradingMode;
  configured: boolean;
  onRequestDelete: (target: DeleteTarget) => void;
}) {
  const store = useProfileStore();
  const state = useStore(store);
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
              onClick={() => onRequestDelete({ provider: 'webull', environment })}
            >
              {env.isDeleting ? <Spinner size={14} /> : 'Delete Credentials'}
            </button>
          </>
        ) : (
          <>
            <WebullCredentialsForm environment={environment} />
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

        <SectionMessages provider="webull" environment={environment} />
      </div>
      <div className="section-footer">
        {environment === 'live'
          ? 'Your app key, app secret, and account ID come from the Webull OpenAPI developer portal.'
          : "Optional paper-trading credentials. If left blank, the server's built-in practice app credentials are used."}
      </div>
    </div>
  );
}

function AlpacaSection({
  environment,
  configured,
  onRequestDelete,
}: {
  environment: TradingMode;
  configured: boolean;
  onRequestDelete: (target: DeleteTarget) => void;
}) {
  const store = useProfileStore();
  const state = useStore(store);
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
              onClick={() => onRequestDelete({ provider: 'alpaca', environment })}
            >
              {env.isDeleting ? <Spinner size={14} /> : 'Delete Credentials'}
            </button>
          </>
        ) : (
          <>
            <AlpacaCredentialsForm environment={environment} />
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

        <SectionMessages provider="alpaca" environment={environment} />
      </div>
      <div className="section-footer">
        {environment === 'live'
          ? 'Your API Key and Secret come from the Alpaca dashboard (use the matching live or paper key).'
          : 'Optional paper-trading key/secret.'}
      </div>
    </div>
  );
}

function TradierSection({
  environment,
  configured,
  onRequestDelete,
}: {
  environment: TradingMode;
  configured: boolean;
  onRequestDelete: (target: DeleteTarget) => void;
}) {
  const store = useProfileStore();
  const state = useStore(store);
  const env = state.tradier[environment];
  const title = environment === 'live' ? 'Tradier API — Live' : 'Tradier API — Practice (sandbox)';
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
              onClick={() => onRequestDelete({ provider: 'tradier', environment })}
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

        <SectionMessages provider="tradier" environment={environment} />
      </div>
      <div className="section-footer">
        {environment === 'live'
          ? 'Optional. Tradier supplies index and options market data alongside Webull; your access token comes from the Tradier dashboard.'
          : 'Optional sandbox access token for practice mode.'}
      </div>
    </div>
  );
}

function SnapTradeKeySection({
  environment,
  configured,
  onRequestDelete,
}: {
  environment: TradingMode;
  configured: boolean;
  onRequestDelete: (target: DeleteTarget) => void;
}) {
  const store = useProfileStore();
  const state = useStore(store);
  const env = state.snaptradeKey[environment];
  const title = environment === 'live' ? 'SnapTrade API — Live' : 'SnapTrade API — Practice';
  return (
    <div className="grouped-section" key={`snaptrade-key-${environment}`}>
      <div className="section-header">{title}</div>
      <div className="section-card">
        {configured && !env.isEditing ? (
          <>
            <div className="grouped-row positive">
              <CheckCircleFillIcon size={14} />
              <span>Configured</span>
            </div>
            <div className="grouped-row footnote text-secondary">
              Your Personal client ID and consumer key are stored encrypted on the server and are
              never displayed here.
            </div>
            <button
              type="button"
              className="grouped-row button-row"
              onClick={() => store.setSnapTradeKeyEditing(environment, true)}
            >
              Update Credentials
            </button>
            <button
              type="button"
              className="grouped-row destructive"
              disabled={env.isDeleting}
              onClick={() => onRequestDelete({ provider: 'snaptrade-key', environment })}
            >
              {env.isDeleting ? <Spinner size={14} /> : 'Delete Credentials'}
            </button>
          </>
        ) : (
          <>
            <SnapTradeCredentialsForm environment={environment} />
            {configured ? (
              <button
                type="button"
                className="grouped-row button-row"
                onClick={() => store.setSnapTradeKeyEditing(environment, false)}
              >
                Cancel Update
              </button>
            ) : null}
          </>
        )}

        <SectionMessages environment={environment} />
      </div>
      <div className="section-footer">
        Create a free Personal client ID and consumer key in your own SnapTrade Dashboard — this
        identifies you directly to SnapTrade, not 0dteTrader.
      </div>
    </div>
  );
}

function SnapTradeDisconnectedState({
  environment,
  keyConfigured,
  isConnecting,
}: {
  environment: TradingMode;
  keyConfigured: boolean;
  isConnecting: boolean;
}) {
  const store = useProfileStore();
  if (!keyConfigured) {
    return (
      <div className="grouped-row text-secondary">
        Save your SnapTrade Personal client ID and consumer key above first.
      </div>
    );
  }
  return (
    <>
      <div className="grouped-row text-secondary">No brokerage connected yet.</div>
      <button
        type="button"
        className="grouped-row button-row"
        disabled={isConnecting}
        onClick={() => void store.connectSnapTrade(environment)}
      >
        {isConnecting ? <Spinner size={14} /> : 'Connect Brokerage'}
      </button>
    </>
  );
}

function SnapTradeConnectionSection({
  environment,
  onRequestDelete,
}: {
  environment: TradingMode;
  onRequestDelete: (target: DeleteTarget) => void;
}) {
  const store = useProfileStore();
  const state = useStore(store);
  const env = store.snaptradeEnvironment(environment);
  const title = environment === 'live' ? 'SnapTrade — Live' : 'SnapTrade — Practice';
  const selectedAccountId = env.status.selectedAccountId;
  const activeConnection = env.connections.find((c) => c.status === 'active');
  const keyConfigured =
    environment === 'live'
      ? state.me?.snaptradeKeyConfigured === true
      : state.me?.snaptradeKeyPracticeConfigured === true;
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
                onRequestDelete({
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
          <SnapTradeDisconnectedState
            environment={environment}
            keyConfigured={keyConfigured}
            isConnecting={env.isConnecting}
          />
        )}

        <SectionMessages environment={environment} />
      </div>
      <div className="section-footer">
        Connect your own brokerage account through SnapTrade's secure Connection Portal, using the
        Personal client ID above. 0dteTrader never sees your brokerage credentials.
      </div>
    </div>
  );
}

function ProviderCredentials({
  onRequestDelete,
}: {
  onRequestDelete: (target: DeleteTarget) => void;
}) {
  const store = useProfileStore();
  const state = useStore(store);
  if (state.tradingProvider === 'webull') {
    return (
      <>
        <WebullCredentialsSection
          environment="live"
          configured={state.me?.webullConfigured === true}
          onRequestDelete={onRequestDelete}
        />
        <WebullCredentialsSection
          environment="practice"
          configured={state.me?.webullPracticeConfigured === true}
          onRequestDelete={onRequestDelete}
        />
        {/* Tradier market-data key rides along with Webull only —
            Alpaca and SnapTrade supply their own data, so no key is needed there. */}
        <TradierSection
          environment="live"
          configured={state.me?.tradierConfigured === true}
          onRequestDelete={onRequestDelete}
        />
        <TradierSection
          environment="practice"
          configured={state.me?.tradierPracticeConfigured === true}
          onRequestDelete={onRequestDelete}
        />
      </>
    );
  }
  if (state.tradingProvider === 'alpaca') {
    return (
      <>
        <AlpacaSection
          environment="live"
          configured={state.me?.alpacaConfigured === true}
          onRequestDelete={onRequestDelete}
        />
        <AlpacaSection
          environment="practice"
          configured={state.me?.alpacaPracticeConfigured === true}
          onRequestDelete={onRequestDelete}
        />
      </>
    );
  }
  return (
    <>
      <SnapTradeKeySection
        environment="live"
        configured={state.me?.snaptradeKeyConfigured === true}
        onRequestDelete={onRequestDelete}
      />
      <SnapTradeKeySection
        environment="practice"
        configured={state.me?.snaptradeKeyPracticeConfigured === true}
        onRequestDelete={onRequestDelete}
      />
      <SnapTradeConnectionSection environment="live" onRequestDelete={onRequestDelete} />
      <SnapTradeConnectionSection environment="practice" onRequestDelete={onRequestDelete} />
    </>
  );
}

function ProfileViewContent({
  onLogout,
  onDismiss,
  dense = false,
  bodyOnly = false,
}: ProfileViewProps) {
  const container = useContainer();
  const store = useProfileStore();
  const state = useStore(store);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [showLogoutConfirmation, setShowLogoutConfirmation] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [bypassConfirmation, setBypassConfirmation] = useState(
    () => container.settingsStore.bypassOrderConfirmation,
  );
  const [shortcutsEnabled, setShortcutsEnabled] = useState(
    () => container.settingsStore.keyboardShortcutsEnabled,
  );
  const [autoOtmOffset, setAutoOtmOffset] = useState(() => container.settingsStore.autoOtmOffset);
  const [toastsEnabled, setToastsEnabled] = useState(() => container.settingsStore.toastsEnabled);
  const [systemNotificationsEnabled, setSystemNotificationsEnabled] = useState(
    () => container.settingsStore.systemNotificationsEnabled,
  );

  const handleBypassChange = (on: boolean) => {
    setBypassConfirmation(on);
    container.settingsStore.bypassOrderConfirmation = on;
  };

  const handleToastsChange = (on: boolean) => {
    setToastsEnabled(on);
    container.settingsStore.toastsEnabled = on;
  };

  const handleSystemNotificationsChange = (on: boolean) => {
    setSystemNotificationsEnabled(on);
    container.settingsStore.systemNotificationsEnabled = on;
  };

  const handleAutoOtmOffsetChange = (value: string) => {
    const offset = Number(value);
    setAutoOtmOffset(offset);
    container.settingsStore.autoOtmOffset = offset;
  };

  const handleShortcutsChange = (on: boolean) => {
    setShortcutsEnabled(on);
    container.settingsStore.keyboardShortcutsEnabled = on;
  };

  useEffect(() => {
    void store.load();
  }, [store]);

  const settingsContent = (
    <>
      <div className={bodyOnly ? 'grouped-list' : 'sheet-body grouped-list hide-scrollbar'}>
        {/* Account */}
        <div className="grouped-section">
          <div className="section-header">Account</div>
          <div className="section-card">
            <AccountSection />
          </div>
        </div>

        {/* Trading provider selector (webull | alpaca | snaptrade). */}
        <div className="grouped-section">
          <div className="section-header">Trading Provider</div>
          <div className="section-card">
            <SegmentedControl
              options={[
                { value: 'webull', label: 'Webull' },
                { value: 'alpaca', label: 'Alpaca' },
                { value: 'snaptrade', label: 'SnapTrade' },
              ]}
              value={state.tradingProvider}
              onChange={async (provider: BrokerProvider) => {
                await store.setTradingProvider(provider);
                // Re-establish the market-data stream so live quotes use the
                // newly selected provider immediately (the subscription was
                // established under the previous provider).
                container.quoteSocket.reconnect();
              }}
            />
          </div>
          <div className="section-footer">
            Switch providers any time. Credentials for the other provider stay saved.
          </div>
        </div>

        <ProviderCredentials onRequestDelete={setDeleteTarget} />

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
            When on, tapping Buy or Sell places the order immediately without the confirmation step.
            This device only.
          </div>
        </div>

        {/* AUTO selection: strikes OTM from the ATM anchor. */}
        <div className="grouped-section">
          <div className="section-header">AUTO selection</div>
          <div className="section-card">
            <div className="grouped-row">
              <SegmentedControl
                options={[
                  { value: '0', label: 'ATM' },
                  { value: '1', label: '+1' },
                  { value: '2', label: '+2' },
                  { value: '3', label: '+3' },
                  { value: '4', label: '+4' },
                  { value: '5', label: '+5' },
                ]}
                value={String(autoOtmOffset)}
                onChange={handleAutoOtmOffsetChange}
              />
            </div>
          </div>
          <div className="section-footer">
            How far AUTO picks from the at-the-money strike: +N OTM from ATM, or ATM itself. Applies
            to new orders on this device.
          </div>
        </div>

        {/* Notifications */}
        <div className="grouped-section">
          <div className="section-header">Notifications</div>
          <div className="section-card">
            <div className="grouped-row">
              <span>In-app toasts</span>
              <span style={{ marginLeft: 'auto' }}>
                <Toggle on={toastsEnabled} onChange={handleToastsChange} />
              </span>
            </div>
            <div className="grouped-row">
              <span>System notifications</span>
              <span style={{ marginLeft: 'auto' }}>
                <Toggle
                  on={systemNotificationsEnabled}
                  onChange={handleSystemNotificationsChange}
                />
              </span>
            </div>
          </div>
          <div className="section-footer">
            Toasts cover order confirmations and info; error toasts always show. System
            notifications report fills, rejections, cancels and chart-order fires while the app is
            in the background.
          </div>
        </div>

        {/* Desktop-grid-only: hotkeys have no meaning on the phone layout. */}
        <div className="grouped-section">
          <div className="section-header">Desktop</div>
          <div className="section-card">
            <div className="grouped-row">
              <span>Trading shortcuts</span>
              <span style={{ marginLeft: 'auto' }}>
                <Toggle on={shortcutsEnabled} onChange={handleShortcutsChange} />
              </span>
            </div>
          </div>
          <div className="section-footer">
            B arms Buy, S arms Sell, L toggles the trading lock. Disabled while typing in any field.
            Desktop grid layout only — ⌘K symbol search is unaffected by this setting.
          </div>
        </div>

        {/* Security section intentionally omitted: Face ID / AppLockManager is
              iOS-only (ProfileView.swift securitySection). */}
        <DiscordAndLegalSection
          onAccountDeleted={() => {
            void onLogout().then(onDismiss);
          }}
        />
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
          title={deleteTargetTitle(deleteTarget)}
          message={deleteCredentialsMessage(deleteTarget)}
          actions={[
            {
              label: deleteActionLabel(deleteTarget),
              role: 'destructive',
              onSelect: () => {
                if (deleteTarget.provider === 'webull') {
                  void store.deleteCredentials(deleteTarget.environment);
                } else if (deleteTarget.provider === 'alpaca') {
                  void store.deleteAlpacaCredentials(deleteTarget.environment);
                } else if (deleteTarget.provider === 'tradier') {
                  void store.deleteTradierCredentials(deleteTarget.environment);
                } else if (deleteTarget.provider === 'snaptrade-key') {
                  void store.deleteSnapTradeKey(deleteTarget.environment);
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
    </>
  );

  if (bodyOnly) {
    return settingsContent;
  }

  const body = (
    <div className="profile-view">
      <NavBar
        title="Profile"
        trailing={
          <button className="navbar-text-button" onClick={onDismiss}>
            Done
          </button>
        }
      />
      {settingsContent}
    </div>
  );

  if (dense) {
    return <DesktopSheet onDismiss={onDismiss}>{body}</DesktopSheet>;
  }
  return (
    <Sheet detent="large" onDismiss={onDismiss}>
      {body}
    </Sheet>
  );
}

export function ProfileView({ onLogout, onDismiss, dense, bodyOnly }: ProfileViewProps) {
  const container = useContainer();
  const store = useMemo(() => new ProfileStore(container.apiClient), [container]);
  return (
    <ProfileStoreProvider store={store}>
      <ProfileViewContent
        onLogout={onLogout}
        onDismiss={onDismiss}
        dense={dense}
        bodyOnly={bodyOnly}
      />
    </ProfileStoreProvider>
  );
}
