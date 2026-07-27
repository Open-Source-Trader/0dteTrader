/** Environment configuration (AppConfig.swift analog). Build-time default only;
    the runtime override lives in ServerConfigStore. */
export const DEFAULT_API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000';

/** WebSocket stream URL derived from an API base (http→ws, https→wss). */
export function deriveStreamUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/v1/stream';
  return url.toString();
}
