import type { Me } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { errorMessage } from '../../core/api/ApiError';
import { Store } from '../../core/observable';

interface ProfileStoreState {
  me: Me | null;
  isLoading: boolean;
  isSavingCredentials: boolean;
  isDeletingCredentials: boolean;
  errorMessage: string | null;
  successMessage: string | null;
  appKey: string;
  appSecret: string;
  accountId: string;
  isEditingCredentials: boolean;
}

/**
 * Profile sheet state (ProfileViewModel.swift analog): account info and the
 * write-only Webull credential lifecycle. Secrets are never re-displayed.
 */
export class ProfileStore extends Store<ProfileStoreState> {
  constructor(private readonly apiClient: ApiClient) {
    super({
      me: null,
      isLoading: false,
      isSavingCredentials: false,
      isDeletingCredentials: false,
      errorMessage: null,
      successMessage: null,
      appKey: '',
      appSecret: '',
      accountId: '',
      isEditingCredentials: false,
    });
  }

  get canSaveCredentials(): boolean {
    const { appKey, appSecret, accountId } = this.getState();
    return appKey.trim() !== '' && appSecret !== '' && accountId.trim() !== '';
  }

  setField(field: 'appKey' | 'appSecret' | 'accountId', value: string): void {
    this.set({ [field]: value } as Partial<ProfileStoreState>);
  }

  setEditing(isEditing: boolean): void {
    this.set({ isEditingCredentials: isEditing });
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

  async saveCredentials(): Promise<void> {
    if (!this.canSaveCredentials || this.getState().isSavingCredentials) return;
    this.set({ isSavingCredentials: true, errorMessage: null, successMessage: null });
    try {
      const { appKey, appSecret, accountId } = this.getState();
      await this.apiClient.putWebullCredentials({
        appKey: appKey.trim(),
        appSecret,
        accountId: accountId.trim(),
      });
      // Write-only: wipe the fields, never render them back.
      this.set({
        appKey: '',
        appSecret: '',
        accountId: '',
        isEditingCredentials: false,
        successMessage: 'Webull credentials saved.',
      });
      await this.load();
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      this.set({ isSavingCredentials: false });
    }
  }

  async deleteCredentials(): Promise<void> {
    if (this.getState().isDeletingCredentials) return;
    this.set({ isDeletingCredentials: true, errorMessage: null, successMessage: null });
    try {
      await this.apiClient.deleteWebullCredentials();
      this.set({ successMessage: 'Webull credentials removed.' });
      await this.load();
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      this.set({ isDeletingCredentials: false });
    }
  }
}
