import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../../core/api/ApiClient';
import type { GexSettings } from './gexSettings';
import type { GexLevels } from './gexTypes';

export interface GexState {
  levels: GexLevels | null;
  /** Fresh fetch failed — showing the last good computation. */
  stale: boolean;
  /** Set only when there is nothing to show (e.g. token not configured). */
  errorMessage: string | null;
}

/**
 * Polls GET /v1/market/gex while the indicator is enabled. The server
 * caches the option chain (OI is static intraday), so each poll is cheap.
 * On failure the last good levels stay on screen, flagged stale. State is
 * per-symbol: switching symbols resets levels, stale flag, and any error,
 * so the previous symbol's data can neither paint nor mask the new symbol's
 * error surface.
 */
export function useGexLevels(
  apiClient: ApiClient,
  symbol: string,
  settings: GexSettings,
): GexState {
  const [state, setState] = useState<GexState>({
    levels: null,
    stale: false,
    errorMessage: null,
  });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    setState({ levels: null, stale: false, errorMessage: null });
    if (!settings.enabled) return;
    let cancelled = false;
    let timer = 0;

    const poll = async (): Promise<void> => {
      try {
        const levels = await apiClient.gexLevels(symbol);
        if (cancelled) return;
        setState({ levels, stale: levels.stale, errorMessage: null });
      } catch (error) {
        if (cancelled) return;
        setState((prev) =>
          prev.levels
            ? { ...prev, stale: true }
            : {
                levels: null,
                stale: false,
                errorMessage: error instanceof Error ? error.message : String(error),
              },
        );
      } finally {
        if (!cancelled) {
          const interval = Math.max(settingsRef.current.refreshSeconds, 15) * 1000;
          timer = window.setTimeout(() => void poll(), interval);
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [apiClient, symbol, settings.enabled]);

  return state;
}
