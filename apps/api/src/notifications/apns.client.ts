import { readFileSync } from 'node:fs';
import { connect } from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Outcome of one APNs send; non-2xx carries Apple's reason string, transport
 *  failures come back as status 0 rather than throwing. */
export interface ApnsSendResult {
  status: number;
  reason?: string;
}

/** The payload this app sends: a plain alert push. */
export interface ApnsAlert {
  title: string;
  body: string;
}

/**
 * Reasons (and the 410) that mean the device token is dead — prune it.
 *
 * `BadDeviceToken` is deliberately NOT here. Apple returns it for a token
 * that is malformed, registered against the other APNs environment, or sent
 * with the wrong topic — and a debug build's sandbox token sent to the
 * production host produces exactly that. Deleting on it throws away
 * registrations that are perfectly valid on the other endpoint, and the user
 * silently stops getting fill alerts. `Unregistered` and `ExpiredToken` are
 * Apple's unambiguous "the app is gone from this device" signals; a bad
 * token costs one wasted round trip per push until one of those arrives.
 */
const DEAD_TOKEN_REASONS = new Set(['Unregistered', 'ExpiredToken']);

export function isDeadToken(result: ApnsSendResult): boolean {
  return (
    result.status === 410 || (result.reason !== undefined && DEAD_TOKEN_REASONS.has(result.reason))
  );
}

/** Apple wants provider tokens refreshed between 20 and 60 minutes of age. */
const PROVIDER_TOKEN_TTL_MS = 45 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

const base64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

/**
 * Token-based APNs sender over Node's own http2 + crypto — no dependency.
 *
 * The provider token is an ES256 JWS over `{alg, kid}.{iss, iat}`. JWS wants
 * the signature in raw r||s form, which `dsaEncoding: 'ieee-p1363'` produces
 * directly — never hand-convert the DER form. Sends open one HTTP/2 session
 * per push: fills are rare events, and a pooled session is state to get wrong
 * for no measurable win at this volume.
 */
@Injectable()
export class ApnsClient {
  private readonly logger = new Logger(ApnsClient.name);
  private key: KeyObject | null = null;
  private cachedToken: { value: string; mintedAt: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return this.config.get<boolean>('notifications.apnsEnabled') === true;
  }

  /** The cached ES256 provider JWT, re-minted after PROVIDER_TOKEN_TTL_MS. */
  providerToken(now = Date.now()): string {
    if (this.cachedToken && now - this.cachedToken.mintedAt < PROVIDER_TOKEN_TTL_MS) {
      return this.cachedToken.value;
    }
    const keyId = this.config.get<string>('notifications.apnsKeyId') ?? '';
    const teamId = this.config.get<string>('notifications.apnsTeamId') ?? '';
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
    const claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
    const signingInput = `${header}.${claims}`;
    const signature = sign('sha256', Buffer.from(signingInput), {
      key: this.privateKey(),
      dsaEncoding: 'ieee-p1363',
    });
    const token = `${signingInput}.${base64url(signature)}`;
    this.cachedToken = { value: token, mintedAt: now };
    return token;
  }

  private privateKey(): KeyObject {
    if (this.key) return this.key;
    const inline = this.config.get<string>('notifications.apnsKey') ?? '';
    const path = this.config.get<string>('notifications.apnsKeyPath') ?? '';
    let pem = inline;
    if (pem === '' && path !== '') pem = readFileSync(path, 'utf8');
    if (pem === '') throw new Error('APNs key not configured (APNS_KEY or APNS_KEY_PATH)');
    this.key = createPrivateKey(pem);
    return this.key;
  }

  /** Sends one alert push. Resolves for every outcome; never rejects. */
  send(deviceToken: string, alert: ApnsAlert): Promise<ApnsSendResult> {
    const host = this.config.get<string>('notifications.apnsHost') ?? '';
    const topic = this.config.get<string>('notifications.apnsTopic') ?? '';
    let providerToken: string;
    try {
      providerToken = this.providerToken();
    } catch (err) {
      return Promise.resolve({ status: 0, reason: (err as Error).message });
    }

    return new Promise((resolve) => {
      let settled = false;
      const session = connect(host);
      const finish = (result: ApnsSendResult): void => {
        if (settled) return;
        settled = true;
        // destroy(), not close(): close() waits for open streams, so a
        // timed-out request whose stream never ends would leak the session
        // and its socket. Every path through here already has its answer.
        session.destroy();
        resolve(result);
      };
      session.on('error', (err: Error) => finish({ status: 0, reason: err.message }));

      const request = session.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${providerToken}`,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'content-type': 'application/json',
      });
      request.setTimeout(REQUEST_TIMEOUT_MS, () => finish({ status: 0, reason: 'timeout' }));
      let status = 0;
      let body = '';
      request.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        let reason: string | undefined;
        if (body !== '') {
          try {
            reason = (JSON.parse(body) as { reason?: string }).reason;
          } catch {
            reason = body;
          }
        }
        finish({ status, reason });
      });
      request.on('error', (err: Error) => finish({ status: 0, reason: err.message }));
      request.end(
        JSON.stringify({
          aps: { alert: { title: alert.title, body: alert.body }, sound: 'default' },
        }),
      );
    });
  }
}
