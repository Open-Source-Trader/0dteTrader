import type { Me, TradingMode } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { errorMessage } from '../../core/api/ApiError';
import { Store } from '../../core/observable';

type CredentialField = 'appKey' | 'appSecret' | 'accountId';

interface CredentialEnvironmentState {
  appKey: string;
  appSecret: string;
  accountId: string;
  isEditing: boolean;
  isSaving: boolean;
  isDeleting: boolean;
}

interface ProfileStoreState {
  me: Me | null;
  isLoading: boolean;
  errorMessage: string | null;
  successMessage: string | null;
  /** Which section the current success/error message belongs to. */
  messageEnv: TradingMode | null;
  live: CredentialEnvironmentState;
  practice: CredentialEnvironmentState;
}

const emptyEnvironment = (): CredentialEnvironmentState => ({
  appKey: '',
  appSecret: '',
  accountId: '',
  isEditing: false,
  isSaving: false,
  isDeleting: false,
});

/**
 * Profile sheet state (ProfileViewModel.swift analog): account info and the
 * write-only Webull credential lifecycle, one credential set per environment
 * (live / practice). Secrets are never re-displayed.
 */
export class ProfileStore extends Store<ProfileStoreState> {
  constructor(private readonly apiClient: ApiClient) {
    super({
      me: null,
      isLoading: false,
      errorMessage: null,
      successMessage: null,
      messageEnv: null,
      live: emptyEnvironment(),
      practice: emptyEnvironment(),
    });
  }

  canSaveCredentials(environment: TradingMode): boolean {
    const { appKey, appSecret, accountId } = this.getState()[environment];
    return appKey.trim() !== '' && appSecret !== '' && accountId.trim() !== '';
  }

  setField(environment: TradingMode, field: CredentialField, value: string): void {
    this.set({ [environment]: { ...this.getState()[environment], [field]: value } });
  }

  setEditing(environment: TradingMode, isEditing: boolean): void {
    this.set({ [environment]: { ...this.getState()[environment], isEditing } });
  }

  async load(): Promise<void> {
    this.set({ isLoading: true, errorMessage: null });
    try {
      this.set({ me: await this.apiClient.me() });
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      this.set({ isLoading: false });
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
      await this.apiClient.putWebullCredentials(
        {
          appKey: env.appKey.trim(),
          appSecret: env.appSecret,
          accountId: env.accountId.trim(),
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
}
