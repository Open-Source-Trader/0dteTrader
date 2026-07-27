/** One-click backend template (#59). Updated when the final template publishes. */
export const RAILWAY_DEPLOY_URL = 'https://railway.com/deploy/0dtetrader-template';

/** Compact host shown in the login footer and the default-server card. */
export function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
