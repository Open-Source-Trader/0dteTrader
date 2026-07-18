import { createHash, createHmac, randomUUID } from 'node:crypto';

/**
 * Webull OpenAPI request signing (docs/WEBULL-INTEGRATION.md; ported from the
 * official Python SDK's DefaultSignatureComposer). Every request is signed
 * individually with the app secret — the secret itself is never sent.
 *
 * Algorithm depends on the host: legacy hosts (production api.webull.com) use
 * HMAC-SHA1 with an MD5 body hash; upgraded hosts (api.sandbox.webull.com) use
 * HMAC-SHA256 with a SHA-256 body hash.
 */

const SIGNATURE_VERSION = '1.0';
const API_VERSION = 'v2';

/**
 * Hosts still on the legacy HMAC-SHA1/MD5 scheme. Source: official Python SDK
 * webull/core/utils/common.py is_not_upgrade_api_host — every host NOT in this
 * set (including data-api.webull.com and the sandbox hosts) signs with
 * HMAC-SHA256 + SHA-256 body hash.
 */
const LEGACY_HOSTS = new Set([
  'api.webull.com',
  'events-api.webull.com',
  'api.webull.hk',
  'events-api.webull.hk',
  'pre-openapi-us-alb.webullbroker.com',
  'pre-openapi-us-events.webullbroker.com',
  'pre-openapi-alb.webullbroker.com',
  'pre-openapi-events.webullbroker.com',
  'us-openapi-alb.uat.webullbroker.com',
  'us-openapi-events.uat.webullbroker.com',
  'hk-openapi.uat.webullbroker.com',
  'hk-openapi-events-api.uat.webullbroker.com',
  'api.sandbox.webull.hk',
  'events-api.sandbox.webull.hk',
]);

export function isLegacyHost(host: string): boolean {
  return LEGACY_HOSTS.has(host.toLowerCase());
}

/**
 * Compact JSON identical to Python's json.dumps(separators=(',', ':')) for the
 * payloads we send. The HTTP client must send these exact bytes so the signed
 * body hash matches.
 */
export function compactJson(body: unknown): string {
  return JSON.stringify(body);
}

/**
 * Percent-encoding matching Python's urllib quote(safe='') — everything
 * outside [A-Za-z0-9._~-] is escaped, including !'()* which JS
 * encodeURIComponent leaves bare.
 */
export function strictPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface SignRequestParams {
  appKey: string;
  appSecret: string;
  /** Host header value, e.g. api.sandbox.webull.com (no scheme). */
  host: string;
  /** Request path, e.g. /openapi/auth/token/create. */
  path: string;
  /** Query params; undefined values are omitted. */
  query?: Record<string, string | number | undefined>;
  /** JSON body (already-compact serialization is hashed). */
  body?: unknown;
  accessToken?: string;
  /** Overridable for deterministic tests. */
  timestamp?: string;
  nonce?: string;
}

/** ISO-8601 UTC without milliseconds, e.g. 2026-07-17T14:03:07Z. */
export function isoTimestamp(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Builds the signed header set for one request. Returns all headers needed by
 * the Webull OpenAPI including x-signature.
 */
export function signRequest(params: SignRequestParams): Record<string, string> {
  const legacy = isLegacyHost(params.host);
  const algorithm = legacy ? 'HMAC-SHA1' : 'HMAC-SHA256';
  const timestamp = params.timestamp ?? isoTimestamp();
  const nonce = params.nonce ?? randomUUID();

  const signParams: Record<string, string> = {
    'x-app-key': params.appKey,
    'x-signature-algorithm': algorithm,
    'x-signature-nonce': nonce,
    'x-signature-version': SIGNATURE_VERSION,
    'x-timestamp': timestamp,
    host: params.host,
  };
  for (const [key, value] of Object.entries(params.query ?? {})) {
    if (value !== undefined) signParams[key] = String(value);
  }

  const joined = Object.keys(signParams)
    .sort()
    .map((k) => `${k}=${signParams[k]}`)
    .join('&');

  let stringToSign = `${params.path}&${joined}`;
  if (params.body !== undefined) {
    const bodyHash = createHash(legacy ? 'md5' : 'sha256')
      .update(compactJson(params.body), 'utf8')
      .digest('hex')
      .toUpperCase();
    stringToSign += `&${bodyHash}`;
  }

  const signature = createHmac(
    legacy ? 'sha1' : 'sha256',
    `${params.appSecret}&`,
  )
    .update(strictPercentEncode(stringToSign), 'utf8')
    .digest('base64');

  const headers: Record<string, string> = {
    'x-app-key': params.appKey,
    'x-timestamp': timestamp,
    'x-signature-nonce': nonce,
    'x-signature-version': SIGNATURE_VERSION,
    'x-signature-algorithm': algorithm,
    'x-signature': signature,
    'x-version': API_VERSION,
  };
  if (params.accessToken) headers['x-access-token'] = params.accessToken;
  return headers;
}
