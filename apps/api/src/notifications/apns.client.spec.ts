import { generateKeyPairSync, verify } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ApnsClient, isDeadToken } from './apns.client';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function configFor(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    'notifications.apnsEnabled': true,
    'notifications.apnsKeyId': 'ABC123DEFG',
    'notifications.apnsTeamId': 'TEAM456789',
    'notifications.apnsKey': pem,
    'notifications.apnsKeyPath': '',
    'notifications.apnsTopic': 'com.0dtetrader.app',
    // .invalid never resolves — a test that accidentally sends must fail fast.
    'notifications.apnsHost': 'https://apns.invalid',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const decodeSegment = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, 'base64url').toString()) as Record<string, unknown>;

describe('ApnsClient provider token', () => {
  it('mints an ES256 JWS with the key id and team id', () => {
    const client = new ApnsClient(configFor());
    const now = 1_754_000_000_000;
    const token = client.providerToken(now);
    const [header, claims] = token.split('.');
    expect(decodeSegment(header)).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(decodeSegment(claims)).toEqual({ iss: 'TEAM456789', iat: Math.floor(now / 1000) });
  });

  it('signs in the raw r||s form the JWS spec wants, verifiable with the public key', () => {
    const client = new ApnsClient(configFor());
    const token = client.providerToken();
    const [header, claims, signature] = token.split('.');
    const valid = verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
    expect(valid).toBe(true);
    // Raw ECDSA P-256 signatures are exactly 64 bytes — DER would vary.
    expect(Buffer.from(signature, 'base64url')).toHaveLength(64);
  });

  it('caches the token inside the refresh window and re-mints after it', () => {
    const client = new ApnsClient(configFor());
    const start = 1_754_000_000_000;
    const first = client.providerToken(start);
    expect(client.providerToken(start + 44 * 60_000)).toBe(first);
    expect(client.providerToken(start + 46 * 60_000)).not.toBe(first);
  });

  it('reports a missing key as a failed send, never a throw', async () => {
    const client = new ApnsClient(configFor({ 'notifications.apnsKey': '' }));
    const result = await client.send('a'.repeat(64), { title: 't', body: 'b' });
    expect(result.status).toBe(0);
    expect(result.reason).toMatch(/APNs key not configured/);
  });
});

describe('isDeadToken', () => {
  it('prunes on 410 and the dead-token reasons', () => {
    expect(isDeadToken({ status: 410, reason: 'Unregistered' })).toBe(true);
    expect(isDeadToken({ status: 400, reason: 'ExpiredToken' })).toBe(true);
  });

  it('keeps a BadDeviceToken, which is routing-ambiguous rather than dead', () => {
    // Apple returns it for a malformed token, a token from the OTHER APNs
    // environment, or the wrong topic. A debug build's sandbox token sent to
    // the production host produces exactly this, and deleting on it silently
    // unregisters a device that was working.
    expect(isDeadToken({ status: 400, reason: 'BadDeviceToken' })).toBe(false);
  });

  it('keeps the token on success and transient failures', () => {
    expect(isDeadToken({ status: 200 })).toBe(false);
    expect(isDeadToken({ status: 500, reason: 'InternalServerError' })).toBe(false);
    expect(isDeadToken({ status: 0, reason: 'timeout' })).toBe(false);
  });
});
