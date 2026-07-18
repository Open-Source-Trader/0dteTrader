import { createContext, useContext } from 'react';
import { API_BASE_URL, STREAM_URL } from './config';
import { ApiClient } from '../core/api/ApiClient';
import { QuoteSocket } from '../core/api/QuoteSocket';
import { SessionStore } from '../core/api/SessionStore';
import { SettingsStore } from '../core/storage/SettingsStore';
import { AuthStore } from '../features/auth/AuthStore';
import { ChartStore } from '../features/chart/ChartStore';
import { ChainStore } from '../features/trade/ChainStore';
import { TradeStore } from '../features/trade/TradeStore';

/** Dependency container (AppContainer.swift analog). Created once at launch. */
export class AppContainer {
  readonly settingsStore: SettingsStore;
  readonly sessionStore: SessionStore;
  readonly apiClient: ApiClient;
  readonly quoteSocket: QuoteSocket;
  readonly authStore: AuthStore;
  readonly chartStore: ChartStore;
  readonly chainStore: ChainStore;
  readonly tradeStore: TradeStore;

  constructor() {
    this.settingsStore = new SettingsStore();
    this.sessionStore = new SessionStore(API_BASE_URL);
    this.apiClient = new ApiClient(API_BASE_URL, this.sessionStore);
    this.quoteSocket = new QuoteSocket(STREAM_URL, () => this.sessionStore.accessTokenOrRefresh());
    this.authStore = new AuthStore(
      this.apiClient,
      this.sessionStore,
      this.settingsStore,
      this.quoteSocket,
    );
    this.chartStore = new ChartStore(this.apiClient, this.quoteSocket, this.settingsStore);
    this.chainStore = new ChainStore(this.apiClient);
    this.tradeStore = new TradeStore(this.apiClient);
  }
}

const ContainerContext = createContext<AppContainer | null>(null);

export const ContainerProvider = ContainerContext.Provider;

export function useContainer(): AppContainer {
  const container = useContext(ContainerContext);
  if (!container) throw new Error('AppContainer not provided');
  return container;
}
