/**
 * Deep-redacts security-sensitive fields from objects before they are logged.
 * Covers Webull credential fields, passwords, and tokens (docs/SECURITY.md §2/§7).
 */

const SENSITIVE_KEYS = new Set([
  'appkey',
  'appsecret',
  'accountid',
  'password',
  'passwordhash',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'token',
  'secret',
]);

const REDACTED = '[REDACTED]';

export function redact<T>(input: T, depth = 0): T {
  if (depth > 8 || input === null || input === undefined) return input;
  if (Buffer.isBuffer(input)) return REDACTED as unknown as T;
  if (Array.isArray(input)) {
    return input.map((item) => redact(item, depth + 1)) as unknown as T;
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redact(value, depth + 1);
    }
    return out as unknown as T;
  }
  return input;
}
