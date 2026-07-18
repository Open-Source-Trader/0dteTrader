import type { AuthTokens } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { errorMessage } from '../../core/api/ApiError';
import type { QuoteSocket } from '../../core/api/QuoteSocket';
import type { SessionStore } from '../../core/api/SessionStore';
import { Store } from '../../core/observable';
import type { SettingsStore } from '../../core/storage/SettingsStore';

export type AuthState = 'checking' | 'disclaimer' | 'unauthenticated' | 'authenticated';

interface AuthStoreState {
  state: AuthState;
  isLoading: boolean;
  errorMessage: string | null;
}

/**
 * Auth flow (AuthViewModel.swift analog): disclaimer gate, session restore,
 * login/register, logout, forced logout when the refresh token is rejected.
 */
export class AuthStore extends Store<AuthStoreState> {
  constructor(
    private readonly apiClient: ApiClient,
    private readonly sessionStore: SessionStore,
    private readonly settingsStore: SettingsStore,
    private readonly socket: QuoteSocket,
  ) {
    super({ state: 'checking', isLoading: false, errorMessage: null });
    sessionStore.onUnauthenticated(() => this.handleSessionExpired());
  }

  /** Entry point on app launch. */
  async start(): Promise<void> {
    if (!this.settingsStore.hasAcceptedRiskDisclaimer) {
      this.set({ state: 'disclaimer' });
      return;
    }
    await this.restoreSession();
  }

  acceptDisclaimer(): void {
    this.settingsStore.hasAcceptedRiskDisclaimer = true;
    this.set({ state: 'checking' });
    void this.restoreSession();
  }

  async login(email: string, password: string): Promise<void> {
    await this.authenticate(() => this.apiClient.login(email, password));
  }

  async register(email: string, password: string): Promise<void> {
    await this.authenticate(() => this.apiClient.register(email, password));
  }

  async logout(): Promise<void> {
    this.socket.disconnect();
    await this.sessionStore.signOut();
    this.set({ state: 'unauthenticated' });
  }

  clearError(): void {
    this.set({ errorMessage: null });
  }

  private async restoreSession(): Promise<void> {
    this.set({ state: 'checking' });
    if (await this.sessionStore.restoreSession()) {
      this.becomeAuthenticated();
    } else {
      this.set({ state: 'unauthenticated' });
    }
  }

  private async authenticate(action: () => Promise<AuthTokens>): Promise<void> {
    if (this.getState().isLoading) return;
    this.set({ isLoading: true, errorMessage: null });
    try {
      const tokens = await action();
      this.sessionStore.signIn(tokens);
      this.becomeAuthenticated();
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      this.set({ isLoading: false });
    }
  }

  private becomeAuthenticated(): void {
    this.socket.connect();
    this.set({ state: 'authenticated' });
  }

  private handleSessionExpired(): void {
    this.socket.disconnect();
    this.set({
      errorMessage: 'Session expired. Please log in again.',
      state: 'unauthenticated',
    });
  }
}
