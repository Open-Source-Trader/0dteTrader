import type { AuthTokens, LegalDocument } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { errorMessage } from '../../core/api/ApiError';
import type { QuoteSocket } from '../../core/api/QuoteSocket';
import type { RestoreSessionResult, SessionStore } from '../../core/api/SessionStore';
import { Store } from '../../core/observable';
import type { SettingsStore } from '../../core/storage/SettingsStore';

export type AuthState =
  | 'checking'
  | 'disclaimer'
  | 'serverSetup'
  | 'unauthenticated'
  | 'legal'
  | 'authenticated'
  | 'startupRecovery';

export interface StartupRecoveryState {
  title: string;
  message: string;
}

interface AuthStoreState {
  state: AuthState;
  isLoading: boolean;
  errorMessage: string | null;
  startupRecovery: StartupRecoveryState | null;
  legalDocuments: LegalDocument[];
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
    super({
      state: 'checking',
      isLoading: false,
      errorMessage: null,
      startupRecovery: null,
      legalDocuments: [],
    });
    sessionStore.onUnauthenticated(() => this.handleSessionExpired());
  }

  /** Entry point on app launch. */
  async start(): Promise<void> {
    if (!this.settingsStore.hasAcceptedRiskDisclaimer) {
      this.set({ state: 'disclaimer', startupRecovery: null });
      return;
    }
    if (!this.settingsStore.hasCompletedServerSelection) {
      this.set({ state: 'serverSetup', startupRecovery: null });
      return;
    }
    await this.restoreSession();
  }

  acceptDisclaimer(): void {
    this.settingsStore.hasAcceptedRiskDisclaimer = true;
    void this.start();
  }

  completeServerSelection(): void {
    this.settingsStore.hasCompletedServerSelection = true;
    void this.start();
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
    this.set({ state: 'unauthenticated', startupRecovery: null, legalDocuments: [] });
  }

  async acceptRequiredLegal(): Promise<void> {
    if (this.getState().isLoading) return;
    this.set({ isLoading: true, errorMessage: null });
    try {
      for (const document of this.getState().legalDocuments.filter(
        (candidate) => candidate.requiresAcceptance,
      )) {
        if (document.slug !== 'terms' && document.slug !== 'risk') continue;
        await this.apiClient.acceptLegal(document.slug, document.version);
      }
      await this.completeAuthenticatedSession();
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      this.set({ isLoading: false });
    }
  }

  clearError(): void {
    this.set({ errorMessage: null });
  }

  clearStartupRecovery(): void {
    this.set({ startupRecovery: null });
  }

  showServerSetup(): void {
    this.set({ state: 'serverSetup', startupRecovery: null });
  }

  showLogin(): void {
    this.set({ state: 'unauthenticated', startupRecovery: null });
  }

  private async restoreSession(): Promise<void> {
    this.set({ state: 'checking', startupRecovery: null });
    const result = await this.sessionStore.restoreSession();
    this.handleRestoreResult(result);
  }

  private async authenticate(action: () => Promise<AuthTokens>): Promise<void> {
    if (this.getState().isLoading) return;
    this.set({ isLoading: true, errorMessage: null, startupRecovery: null });
    try {
      const tokens = await action();
      this.sessionStore.signIn(tokens);
      await this.completeAuthenticatedSession();
    } catch (error) {
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      this.set({ isLoading: false });
    }
  }

  private becomeAuthenticated(): void {
    this.socket.connect();
    this.set({ state: 'authenticated', startupRecovery: null, legalDocuments: [] });
  }

  private async completeAuthenticatedSession(): Promise<void> {
    try {
      const status = await this.apiClient.legalStatus();
      const missing = status.documents.filter(
        (document) => document.requiresAcceptance && !document.accepted,
      );
      if (missing.length === 0) {
        this.becomeAuthenticated();
        return;
      }
      const documents = await Promise.all(
        missing.map((document) => this.apiClient.legalDocument(document.slug)),
      );
      this.socket.disconnect();
      this.set({ state: 'legal', legalDocuments: documents, startupRecovery: null });
    } catch (error) {
      this.socket.disconnect();
      this.set({
        state: 'startupRecovery',
        startupRecovery: {
          title: 'Cannot verify required disclosures',
          message: errorMessage(error),
        },
      });
    }
  }

  private handleRestoreResult(result: RestoreSessionResult): void {
    if (result.status === 'authenticated') {
      void this.completeAuthenticatedSession();
      return;
    }
    if (result.status === 'no-session') {
      this.set({ state: 'unauthenticated', startupRecovery: null });
      return;
    }
    if (result.status === 'session-expired') {
      this.set({
        errorMessage: 'Session expired. Please log in again.',
        state: 'unauthenticated',
        startupRecovery: null,
      });
      return;
    }
    this.socket.disconnect();
    this.set({
      state: 'startupRecovery',
      startupRecovery: {
        title: 'Cannot reach your backend',
        message: result.message,
      },
    });
  }

  private handleSessionExpired(): void {
    this.socket.disconnect();
    this.set({
      errorMessage: 'Session expired. Please log in again.',
      state: 'unauthenticated',
      startupRecovery: null,
    });
  }
}
