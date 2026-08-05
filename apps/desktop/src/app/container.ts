import { createContext, useContext } from 'react';
import { deriveStreamUrl } from './config';
import { ApiClient } from '../core/api/ApiClient';
import { QuoteSocket } from '../core/api/QuoteSocket';
import { ServerConfigStore } from '../core/api/ServerConfigStore';
import { SessionStore } from '../core/api/SessionStore';
import { SettingsStore } from '../core/storage/SettingsStore';
import { AuthStore } from '../features/auth/AuthStore';
import { ChartOrdersStore } from '../features/chart/chartOrders';
import { ChartStore } from '../features/chart/ChartStore';
import { DrawingsStore } from '../features/chart/drawings';
import { ChainStore } from '../features/trade/ChainStore';
import { TradeStore } from '../features/trade/TradeStore';

/** Dependency container (AppContainer.swift analog). Recreated by main.tsx
    whenever ServerConfigStore changes the base URL. */
export class AppContainer {
  readonly serverConfigStore: ServerConfigStore;
  readonly settingsStore: SettingsStore;
  readonly sessionStore: SessionStore;
  readonly apiClient: ApiClient;
  readonly quoteSocket: QuoteSocket;
  readonly authStore: AuthStore;
  readonly chartStore: ChartStore;
  readonly chainStore: ChainStore;
  readonly tradeStore: TradeStore;
  readonly drawingsStore: DrawingsStore;
  readonly chartOrdersStore: ChartOrdersStore;

  constructor(serverConfigStore: ServerConfigStore, baseUrl: string) {
    this.serverConfigStore = serverConfigStore;
    this.settingsStore = new SettingsStore();
    this.sessionStore = new SessionStore(baseUrl);
    this.apiClient = new ApiClient(baseUrl, this.sessionStore);
    this.quoteSocket = new QuoteSocket(deriveStreamUrl(baseUrl), () =>
      this.sessionStore.accessTokenOrRefresh(),
    );
    this.authStore = new AuthStore(
      this.apiClient,
      this.sessionStore,
      this.settingsStore,
      this.quoteSocket,
    );
    this.chartStore = new ChartStore(this.apiClient, this.quoteSocket, this.settingsStore);
    this.chainStore = new ChainStore(this.apiClient, this.settingsStore);
    this.tradeStore = new TradeStore(this.apiClient);
    // CURR mode reads the open positions TradeStore owns.
    this.chainStore.positionsProvider = () => this.tradeStore.getState().positions;
    // Success/info toasts obey the Profile toggle; errors always show.
    this.tradeStore.toastPolicy = () => this.settingsStore.toastsEnabled;
    this.drawingsStore = new DrawingsStore();
    this.chartOrdersStore = new ChartOrdersStore(this.apiClient);
  }

  /** Stops background work before a server change retires this container. */
  dispose(): void {
    this.tradeStore.stopPolling();
    this.quoteSocket.disconnect();
  }
}

const ContainerContext = createContext<AppContainer | null>(null);

export const ContainerProvider = ContainerContext.Provider;

export function useContainer(): AppContainer {
  const container = useContext(ContainerContext);
  if (!container) throw new Error('AppContainer not provided');
  return container;
}
