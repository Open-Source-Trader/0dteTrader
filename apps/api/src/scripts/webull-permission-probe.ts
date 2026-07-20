/** Probe: which Webull market-data endpoints does this app's key have access to? */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signRequest } from '../broker/webull/webull-signer';

function loadDotEnv(): void {
  try {
    const raw = readFileSync(resolve(__dirname, '../../../../.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2];
      }
    }
  } catch {
    /* rely on shell env */
  }
}
loadDotEnv();

const APP_KEY = process.env.WEBULL_APP_KEY ?? '';
const APP_SECRET = process.env.WEBULL_APP_SECRET ?? '';
const BASE_URL = 'https://api.webull.com';

let accessToken: string | undefined;

async function call(
  label: string,
  path: string,
  query: Record<string, string | number> = {},
): Promise<void> {
  const url = new URL(path, BASE_URL);
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, String(v));
    q[k] = String(v);
  }
  const headers = {
    ...signRequest({
      appKey: APP_KEY,
      appSecret: APP_SECRET,
      host: url.host,
      path: url.pathname,
      query: q,
      body: undefined,
      accessToken,
    }),
    'content-type': 'application/json',
  };
  try {
    const res = await fetch(url, { method: 'GET', headers });
    const text = await res.text();
    const preview = text.slice(0, 220).replace(/\s+/g, ' ');
    console.log(`${res.ok ? 'OK ' : 'ERR'} ${res.status} ${label}: ${preview}`);
  } catch (err) {
    console.log(`ERR --- ${label}: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const url = new URL('/openapi/auth/token/create', BASE_URL);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...signRequest({
        appKey: APP_KEY,
        appSecret: APP_SECRET,
        host: url.host,
        path: url.pathname,
        query: {},
        body: {},
      }),
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const token = (await res.json()) as { token?: string; access_token?: string; status?: string };
  accessToken = token.token ?? token.access_token;
  console.log(`token/create: HTTP ${res.status}, status=${token.status}`);

  await call('stock/snapshot SPY', '/openapi/market-data/stock/snapshot', {
    symbols: 'SPY',
    category: 'US_STOCK',
  });
  await call('stock/bars SPY M1', '/openapi/market-data/stock/bars', {
    symbol: 'SPY',
    category: 'US_STOCK',
    timespan: 'M1',
    count: 3,
  });
  await call('stock/bars SPY D', '/openapi/market-data/stock/bars', {
    symbol: 'SPY',
    category: 'US_STOCK',
    timespan: 'D',
    count: 3,
  });
  await call('option/snapshot SPY', '/openapi/market-data/option/snapshot', {
    symbols: 'SPY260718C00600000',
    category: 'US_OPTION',
  });

  // option/bars param-shape variants
  await call('obars symbol singular', '/openapi/market-data/option/bars', {
    symbol: 'SPY260718C00600000',
    category: 'US_OPTION',
    timespan: 'M1',
    count: 3,
  });
  await call('obars symbols plural', '/openapi/market-data/option/bars', {
    symbols: 'SPY260718C00600000',
    category: 'US_OPTION',
    timespan: 'M1',
    count: 3,
  });
}

main().catch((err) => {
  console.error(`probe FAILED: ${(err as Error).message}`);
  process.exit(1);
});
