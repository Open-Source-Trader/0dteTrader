import type { BrokerProvider, Me, TradingMode } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { errorMessage } from '../../core/api/ApiError';
import { Store } from '../../core/observable';
import type { DesktopSnapTradeConnectionRecord } from '../../core/types/snaptrade';

type CredentialField = 'appKey' | 'appSecret';
type AlpacaField = 'apiKey' | 'apiSecret';

interface CredentialEnvironmentState {
  appKey: string;
  appSecret: string;
  isEditing: boolean;
  isSaving: boolean;
  isDeleting: boolean;
  isReconnecting: boolean;
}

interface AlpacaEnvironmentState {
  apiKey: string;
  apiSecret: string;
  isEditing: boolean;
  isSaving: boolean;
  isDeleting: boolean;
}

interface SnapTradeEnvironmentState {
  connections: DesktopSnapTradeConnectionRecord[];
  accounts: Record<string, { accountId: string; name: string }[]>;
  status: { configured: boolean; selectedAccountId: string | null };
  isConnecting: boolean;
  isDisconnecting: boolean;
  isReconnecting: boolean;
}

interface ProfileStoreState {
  me: Me | null;
  isLoading: boolean;
  errorMessage: string | null;
  successMessage: string | null;
  /** Which section the current success/error message belongs to. */
  messageEnv: TradingMode | null;
  /** Active trading provider chosen by the user (webull | alpaca). */
  tradingProvider: BrokerProvider;
  live: CredentialEnvironmentState;
  practice: CredentialEnvironmentState;
  alpaca: Record<TradingMode, AlpacaEnvironmentState>;
  snaptrade: Record<TradingMode, SnapTradeEnvironmentState>;
}

const emptyEnvironment = (): CredentialEnvironmentState => ({
  appKey: '',
  appSecret: '',
  isEditing: false,
  isSaving: false,
  isDeleting: false,
  isReconnecting: false,
});

const emptyAlpacaEnvironment = (): AlpacaEnvironmentState => ({
  apiKey: '',
  apiSecret: '',
  isEditing: false,
  isSaving: false,
  isDeleting: false,
});

const emptySnapTradeEnvironment = (): SnapTradeEnvironmentState => ({
  connections: [],
  accounts: {},
  status: { configured: false, selectedAccountId: null },
  isConnecting: false,
  isDisconnecting: false,
  isReconnecting: false,
});

/**
 * Profile sheet state (ProfileViewModel.swift analog): account info, the active
 * trading provider, and the write-only credential lifecycle for both Webull
 * (legacy webull-credentials endpoint) and Alpaca (generic broker-credentials
 * endpoint) — one credential set per environment (live / practice). Secrets are
 * never re-displayed.
 */
export class ProfileStore extends Store<ProfileStoreState> {
  constructor(private readonly apiClient: ApiClient) {
    super({
      me: null,
      isLoading: false,
      errorMessage: null,
      successMessage: null,
      messageEnv: null,
      tradingProvider: 'webull',
      live: emptyEnvironment(),
      practice: emptyEnvironment(),
      alpaca: { live: emptyAlpacaEnvironment(), practice: emptyAlpacaEnvironment() },
      snaptrade: { live: emptySnapTradeEnvironment(), practice: emptySnapTradeEnvironment() },
    });
  }

  canSaveCredentials(environment: TradingMode): boolean {
    const { appKey, appSecret } = this.getState()[environment];
    return appKey.trim() !== '' && appSecret !== '';
  }

  setField(environment: TradingMode, field: CredentialField, value: string): void {
    this.set({ [environment]: { ...this.getState()[environment], [field]: value } });
  }

  setEditing(environment: TradingMode, isEditing: boolean): void {
    this.set({ [environment]: { ...this.getState()[environment], isEditing } });
  }

  canSaveAlpaca(environment: TradingMode): boolean {
    const { apiKey, apiSecret } = this.getState().alpaca[environment];
    return apiKey.trim() !== '' && apiSecret !== '';
  }

  setAlpacaField(environment: TradingMode, field: AlpacaField, value: string): void {
    const next = {
      ...this.getState().alpaca,
      [environment]: { ...this.getState().alpaca[environment], [field]: value },
    };
    this.set({ alpaca: next });
  }

  setAlpacaEditing(environment: TradingMode, isEditing: boolean): void {
    const next = {
      ...this.getState().alpaca,
      [environment]: { ...this.getState().alpaca[environment], isEditing },
    };
    this.set({ alpaca: next });
  }

  // MARK: - SnapTrade connection lifecycle

  snaptradeEnvironment(environment: TradingMode): SnapTradeEnvironmentState {
    return this.getState().snaptrade[environment];
  }

  async loadSnapTradeConnections(environment: TradingMode): Promise<void> {
    const envKey = environment;
    this.set({
      snaptrade: {
        ...this.getState().snaptrade,
        [envKey]: {
          ...this.getState().snaptrade[envKey],
          isConnecting: false,
          isReconnecting: false,
        },
      },
      errorMessage: null,
    });
    try {
      const data = await this.apiClient.getSnapTradeConnections();
      const connections = data.connections ?? [];
      const accounts = data.accounts ?? {};
      const status = data.status ?? { configured: false, selectedAccountId: null };
      this.set({
        snaptrade: {
          ...this.getState().snaptrade,
          [envKey]: { ...this.getState().snaptrade[envKey], connections, accounts, status },
        },
      });
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    }
  }

  async connectSnapTrade(environment: TradingMode): Promise<void> {
    const envKey = environment;
    if (this.getState().snaptrade[envKey].isConnecting) return;
    this.set({
      snaptrade: {
        ...this.getState().snaptrade,
        [envKey]: { ...this.getState().snaptrade[envKey], isConnecting: true },
      },
      errorMessage: null,
      successMessage: null,
      messageEnv: envKey,
    });
    try {
      const result = await this.apiClient.authorizeSnapTrade({
        connectionType: 'trade',
      });
      await this.openExternal(result.redirectUrl);
      // Refresh after the user returns from the Connection Portal.
      await this.loadSnapTradeConnections(envKey);
      this.set({ successMessage: 'SnapTrade brokerage connected.' });
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      this.set({
        snaptrade: {
          ...this.getState().snaptrade,
          [envKey]: { ...this.getState().snaptrade[envKey], isConnecting: false },
        },
      });
    }
  }

  async reconnectSnapTrade(environment: TradingMode, connectionId: string): Promise<void> {
    const envKey = environment;
    if (this.getState().snaptrade[envKey].isReconnecting) return;
    this.set({
      snaptrade: {
        ...this.getState().snaptrade,
        [envKey]: { ...this.getState().snaptrade[envKey], isReconnecting: true },
      },
      errorMessage: null,
      successMessage: null,
      messageEnv: envKey,
    });
    try {
      const result = await this.apiClient.reconnectSnapTrade(connectionId);
      await this.openExternal(result.redirectUrl);
      await this.loadSnapTradeConnections(envKey);
      this.set({ successMessage: 'SnapTrade connection refreshed.' });
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      this.set({
        snaptrade: {
          ...this.getState().snaptrade,
          [envKey]: { ...this.getState().snaptrade[envKey], isReconnecting: false },
        },
      });
    }
  }

  async selectSnapTradeAccount(
    environment: TradingMode,
    connectionId: string,
    accountId: string,
  ): Promise<void> {
    const envKey = environment;
    try {
      await this.apiClient.selectSnapTradeAccount(connectionId, accountId);
      await this.loadSnapTradeConnections(envKey);
      this.set({ successMessage: 'SnapTrade trading account selected.' });
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    }
  }

  async disconnectSnapTrade(environment: TradingMode, connectionId: string): Promise<void> {
    const envKey = environment;
    if (this.getState().snaptrade[envKey].isDisconnecting) return;
    this.set({
      snaptrade: {
        ...this.getState().snaptrade,
        [envKey]: { ...this.getState().snaptrade[envKey], isDisconnecting: true },
      },
      errorMessage: null,
      successMessage: null,
      messageEnv: envKey,
    });
    try {
      await this.apiClient.deleteSnapTradeConnection(connectionId);
      await this.loadSnapTradeConnections(envKey);
      this.set({ successMessage: 'SnapTrade connection removed.' });
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      this.set({
        snaptrade: {
          ...this.getState().snaptrade,
          [envKey]: { ...this.getState().snaptrade[envKey], isDisconnecting: false },
        },
      });
    }
  }

  private openExternal(url: string): Promise<void> {
    if (typeof window !== 'undefined' && window.electron?.openExternal) {
      return window.electron.openExternal(url);
    }
    // Fallback for non-Electron environments (tests, web preview).
    return Promise.resolve();
  }

  async load(): Promise<void> {
    this.set({ isLoading: true, errorMessage: null });
    try {
      const me = await this.apiClient.me();
      this.set({ me, tradingProvider: me.tradingProvider });
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      this.set({ isLoading: false });
    }
  }

  async setTradingProvider(provider: BrokerProvider): Promise<void> {
    this.set({ errorMessage: null, successMessage: null });
    try {
      const me = await this.apiClient.updateTradingProvider(provider);
      this.set({ me, tradingProvider: me.tradingProvider });
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    }
  }

  async saveCredentials(environment: TradingMode): Promise<void> {
    const env = this.getState()[environment];
    if (!this.canSaveCredentials(environment) || env.isSaving) return;
    this.set({
      [environment]: { ...env, isSaving: true },
      errorMessage: null,
      successMessage: null,
      messageEnv: environment,
    });
    try {
      // Account id is intentionally absent: the server discovers it via
      // Webull's account/list once the token is approved (official flow).
      await this.apiClient.putWebullCredentials(
        {
          appKey: env.appKey.trim(),
          appSecret: env.appSecret,
        },
        environment,
      );
      // Write-only: wipe the fields, never render them back.
      this.set({
        [environment]: { ...emptyEnvironment() },
        successMessage: 'Webull credentials saved.',
      });
      await this.load();
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      this.set({
        [environment]: { ...this.getState()[environment], isSaving: false },
      });
    }
  }

  async deleteCredentials(environment: TradingMode): Promise<void> {
    if (this.getState()[environment].isDeleting) return;
    this.set({
      [environment]: { ...this.getState()[environment], isDeleting: true },
      errorMessage: null,
      successMessage: null,
      messageEnv: environment,
    });
    try {
      await this.apiClient.deleteWebullCredentials(environment);
      this.set({ successMessage: 'Webull credentials removed.' });
      await this.load();
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      this.set({
        [environment]: { ...this.getState()[environment], isDeleting: false },
      });
    }
  }

  /**
   * "Reconnect": mint a fresh Webull access token using the stored
   * credentials, so a stale token never forces re-entering secrets. The
   * server refreshes the caller's current trading mode, so the button is
   * only shown for the active environment.
   */
  async reconnect(environment: TradingMode): Promise<void> {
    if (this.getState()[environment].isReconnecting) return;
    this.set({
      [environment]: { ...this.getState()[environment], isReconnecting: true },
      errorMessage: null,
      successMessage: null,
      messageEnv: environment,
    });
    try {
      await this.apiClient.refreshWebullSession();
      this.set({ successMessage: 'Webull session refreshed.' });
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      this.set({
        [environment]: { ...this.getState()[environment], isReconnecting: false },
      });
    }
  }

  async saveAlpacaCredentials(environment: TradingMode): Promise<void> {
    const env = this.getState().alpaca[environment];
    if (!this.canSaveAlpaca(environment) || env.isSaving) return;
    const next = { ...this.getState().alpaca, [environment]: { ...env, isSaving: true } };
    this.set({
      alpaca: next,
      errorMessage: null,
      successMessage: null,
      messageEnv: environment,
    });
    try {
      await this.apiClient.putBrokerCredentials(
        { provider: 'alpaca', apiKey: env.apiKey.trim(), apiSecret: env.apiSecret },
        environment,
      );
      // Write-only: wipe the fields, never render them back.
      this.set({
        alpaca: { ...this.getState().alpaca, [environment]: { ...emptyAlpacaEnvironment() } },
        successMessage: 'Alpaca credentials saved.',
      });
      await this.load();
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      const done = this.getState().alpaca[environment];
      this.set({
        alpaca: { ...this.getState().alpaca, [environment]: { ...done, isSaving: false } },
      });
    }
  }

  async deleteAlpacaCredentials(environment: TradingMode): Promise<void> {
    const env = this.getState().alpaca[environment];
    if (env.isDeleting) return;
    const next = { ...this.getState().alpaca, [environment]: { ...env, isDeleting: true } };
    this.set({
      alpaca: next,
      errorMessage: null,
      successMessage: null,
      messageEnv: environment,
    });
    try {
      await this.apiClient.deleteBrokerCredentials('alpaca', environment);
      this.set({ successMessage: 'Alpaca credentials removed.' });
      await this.load();
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      const done = this.getState().alpaca[environment];
      this.set({
        alpaca: { ...this.getState().alpaca, [environment]: { ...done, isDeleting: false } },
      });
    }
  }
}
