/** Environment configuration (AppConfig.swift analog). */
export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000';

/** WebSocket stream URL derived from the API base (http→ws, https→wss). */
export const STREAM_URL: string = (() => {
  const url = new URL(API_BASE_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/v1/stream';
  return url.toString();
})();
