import {
  compactJson,
  isLegacyHost,
  signRequest,
  strictPercentEncode,
} from './webull-signer';

// Official worked example from developer.webull.com/apis/docs/authentication/
// signature.md — "If your output matches kvlS6opdZDhEBo5jq40nHYXaLvM=, your
// implementation is correct."
const DOCS_VECTOR = {
  appKey: '776da210ab4a452795d74e726ebd74b6',
  appSecret: '0f50a2e853334a9aae1a783bee120c1f',
  host: 'api.webull.com',
  path: '/trade/place_order',
  query: { a1: 'webull', a2: '123', a3: 'xxx', q1: 'yyy' },
  body: {
    k1: 123,
    k2: 'this is the api request body',
    k3: true,
    k4: { foo: [1, 2] },
  },
  timestamp: '2022-01-04T03:55:31Z',
  nonce: '48ef5afed43d4d91ae514aaeafbc29ba',
};

describe('signRequest', () => {
  it('reproduces the official docs test vector (legacy HMAC-SHA1 host)', () => {
    const headers = signRequest(DOCS_VECTOR);
    expect(headers['x-signature']).toBe('kvlS6opdZDhEBo5jq40nHYXaLvM=');
    expect(headers['x-signature-algorithm']).toBe('HMAC-SHA1');
    expect(headers['x-app-key']).toBe(DOCS_VECTOR.appKey);
    expect(headers['x-timestamp']).toBe(DOCS_VECTOR.timestamp);
    expect(headers['x-signature-nonce']).toBe(DOCS_VECTOR.nonce);
    expect(headers['x-signature-version']).toBe('1.0');
    expect(headers['x-version']).toBe('v2');
  });

  it('never includes the app secret in any header', () => {
    const headers = signRequest(DOCS_VECTOR);
    for (const value of Object.values(headers)) {
      expect(value).not.toContain(DOCS_VECTOR.appSecret);
    }
  });

  it('uses HMAC-SHA256 for the sandbox host and is deterministic', () => {
    const params = { ...DOCS_VECTOR, host: 'api.sandbox.webull.com' };
    const a = signRequest(params);
    const b = signRequest(params);
    expect(a['x-signature-algorithm']).toBe('HMAC-SHA256');
    expect(a['x-signature']).toBe(b['x-signature']);
    expect(a['x-signature']).not.toBe('kvlS6opdZDhEBo5jq40nHYXaLvM=');
  });

  it('includes x-access-token only when a token is given', () => {
    expect(signRequest(DOCS_VECTOR)['x-access-token']).toBeUndefined();
    expect(
      signRequest({ ...DOCS_VECTOR, accessToken: 'tok' })['x-access-token'],
    ).toBe('tok');
  });

  it('changes the signature when the body changes', () => {
    const a = signRequest(DOCS_VECTOR);
    const b = signRequest({ ...DOCS_VECTOR, body: { k1: 124 } });
    expect(a['x-signature']).not.toBe(b['x-signature']);
  });
});

describe('strictPercentEncode', () => {
  it('escapes the characters encodeURIComponent leaves bare', () => {
    expect(strictPercentEncode("!'()*")).toBe('%21%27%28%29%2A');
  });

  it('keeps the unreserved set intact', () => {
    expect(strictPercentEncode('Az09._~-')).toBe('Az09._~-');
  });

  it('encodes separators like the docs example', () => {
    expect(strictPercentEncode('/trade/place_order&a1=webull')).toBe(
      '%2Ftrade%2Fplace_order%26a1%3Dwebull',
    );
  });
});

describe('isLegacyHost', () => {
  it('classifies production as legacy and sandbox as upgraded', () => {
    expect(isLegacyHost('api.webull.com')).toBe(true);
    expect(isLegacyHost('api.sandbox.webull.com')).toBe(false);
  });

  it('signs market-data hosts with HMAC-SHA256 (per the official SDK)', () => {
    expect(isLegacyHost('data-api.webull.com')).toBe(false);
    expect(isLegacyHost('data-api.sandbox.webull.com')).toBe(false);
  });
});

describe('compactJson', () => {
  it('serializes without whitespace, matching the signed body hash bytes', () => {
    expect(compactJson(DOCS_VECTOR.body)).toBe(
      '{"k1":123,"k2":"this is the api request body","k3":true,"k4":{"foo":[1,2]}}',
    );
  });
});
