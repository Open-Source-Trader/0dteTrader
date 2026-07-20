import { useEffect, useState } from 'react';
import type { ApiClient } from '../../../core/api/ApiClient';
import { OptionsAnalyticsPoller, type OptionsAnalyticsPollState } from './optionsAnalyticsPoller';
import type { OptionsAnalyticsSettings } from './optionsAnalyticsSettings';

const EMPTY_STATE: OptionsAnalyticsPollState = {
  snapshot: null,
  isLoading: false,
  retained: false,
  errorMessage: null,
};

export function useOptionsAnalytics(
  apiClient: ApiClient,
  symbol: string,
  expiration: string | null,
  settings: OptionsAnalyticsSettings,
): OptionsAnalyticsPollState {
  const [state, setState] = useState<OptionsAnalyticsPollState>(EMPTY_STATE);
  const { refreshSeconds } = settings;

  useEffect(() => {
    setState(EMPTY_STATE);
    if (expiration === null) return;
    const poller = new OptionsAnalyticsPoller((requestSymbol, requestExpiration, signal) =>
      apiClient.optionsAnalytics(requestSymbol, requestExpiration, signal),
    );
    const unsubscribe = poller.subscribe(setState);
    poller.start({
      symbol,
      expiration,
      refreshSeconds,
    });
    return () => {
      unsubscribe();
      poller.stop();
    };
  }, [apiClient, symbol, expiration, refreshSeconds]);

  return state;
}
