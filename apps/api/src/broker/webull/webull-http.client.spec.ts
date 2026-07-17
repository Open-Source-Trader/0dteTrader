import { ConfigService } from '@nestjs/config';
import { BrokerError } from '../../common/broker-error';
import { mapWebullError, WebullHttpClient } from './webull-http.client';

const CREDS = { appKey: 'key', appSecret: 'secret' };

function makeClient(): WebullHttpClient {
  const config = {
    get: (key: string) =>
      key === 'webull.apiBaseUrl' || key === 'webull.marketDataBaseUrl'
        ? 'https://api.sandbox.webull.com'
        : undefined,
  } as unknown as ConfigService;
  return new WebullHttpClient(config);
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers,
  });
}

describe('WebullHttpClient', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('signs requests and parses JSON responses', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const result = await makeClient().request({
      method: 'GET',
      path: '/openapi/account/list',
      ...CREDS,
      accessToken: 'tok',
    });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.sandbox.webull.com/openapi/account/list');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-app-key']).toBe('key');
    expect(headers['x-signature']).toBeDefined();
    expect(headers['x-access-token']).toBe('tok');
    expect(JSON.stringify(headers)).not.toContain('secret');
  });

  it('retries 429 with Retry-After and then succeeds', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 1 }));
    const result = await makeClient().request({
      method: 'GET',
      path: '/openapi/assets/balance',
      ...CREDS,
    });
    expect(result).toEqual({ ok: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('maps exhausted 429 retries to BROKER_RATE_LIMITED', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(429, {}, { 'retry-after': '0' }));
    await expect(
      makeClient().request({ method: 'GET', path: '/x', ...CREDS }),
    ).rejects.toMatchObject({ code: 'BROKER_RATE_LIMITED', httpStatus: 503 });
  });

  it('maps 401 to BROKER_AUTH_FAILED', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(401, { code: 'UNAUTHORIZED' }));
    await expect(
      makeClient().request({ method: 'GET', path: '/x', ...CREDS }),
    ).rejects.toMatchObject({ code: 'BROKER_AUTH_FAILED', httpStatus: 401 });
  });

  it('maps 417 business errors by code', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(417, {
        code: 'INSUFFICIENT_BUYING_POWER',
        message: 'not enough buying power',
      }),
    );
    await expect(
      makeClient().request({ method: 'POST', path: '/x', body: {}, ...CREDS }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BUYING_POWER' });
  });

  it('retries a 5xx once before surfacing the error', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const result = await makeClient().request({
      method: 'GET',
      path: '/x',
      ...CREDS,
    });
    expect(result).toEqual({ ok: true });
  });

  it('maps network failures to BROKER_UNAVAILABLE', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(
      makeClient().request({ method: 'GET', path: '/x', ...CREDS }),
    ).rejects.toMatchObject({ code: 'BROKER_UNAVAILABLE', httpStatus: 503 });
  });

  it('sends the exact compact-JSON bytes it signed', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, {}));
    await makeClient().request({
      method: 'POST',
      path: '/x',
      body: { a: 1, b: 'two' },
      ...CREDS,
    });
    expect(fetchSpy.mock.calls[0][1].body).toBe('{"a":1,"b":"two"}');
  });
});

describe('mapWebullError', () => {
  const cases: [number, string, string, string][] = [
    [401, '', '', 'BROKER_AUTH_FAILED'],
    [429, '', '', 'BROKER_RATE_LIMITED'],
    [417, 'OPENAPI_NO_NIGHT_TRADING_TIME', '', 'MARKET_CLOSED'],
    [417, '', 'insufficient buying power', 'INSUFFICIENT_BUYING_POWER'],
    [417, 'SOME_REJECT', 'bad order', 'ORDER_REJECTED'],
  ];
  it.each(cases)('maps %i %s %s → %s', (status, code, message, expected) => {
    const err = mapWebullError(status, code, message);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.code).toBe(expected);
  });
});
