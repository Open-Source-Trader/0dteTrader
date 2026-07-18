/* eslint-disable no-console */
/**
 * Webull sandbox smoke test (docs/RUNBOOK.md). Exercises the real OpenAPI end
 * to end with credentials from the environment — never committed:
 *
 *   WEBULL_APP_KEY=...    WEBULL_APP_SECRET=...
 *   (or the WEBULL_SMOKE_APP_KEY / WEBULL_SMOKE_APP_SECRET overrides)
 *   npm run smoke:webull            # market data + account, read-only
 *   npm run smoke:webull -- --trade # also place + cancel a far-OTM SPY order
 *
 * Base URL comes from WEBULL_API_BASE_URL (default sandbox). This script is
 * where the "verify during implementation" items from the P4 plan get
 * resolved: response field shapes and error bodies.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatOccSymbol } from '../broker/contract-resolution';
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
    // No .env — rely on the shell environment.
  }
}

loadDotEnv();

const APP_KEY =
  process.env.WEBULL_SMOKE_APP_KEY ?? process.env.WEBULL_APP_KEY ?? '';
const APP_SECRET =
  process.env.WEBULL_SMOKE_APP_SECRET ?? process.env.WEBULL_APP_SECRET ?? '';
const BASE_URL = process.env.WEBULL_API_BASE_URL || 'https://api.sandbox.webull.com';
const TRADE = process.argv.includes('--trade');

if (!APP_KEY || !APP_SECRET) {
  console.error(
    'Set WEBULL_APP_KEY and WEBULL_APP_SECRET (shell env or .env).',
  );
  process.exit(1);
}

let accessToken: string | undefined;

async function call(
  method: 'GET' | 'POST',
  path: string,
  opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<unknown> {
  const url = new URL(path, BASE_URL);
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) {
      url.searchParams.set(k, String(v));
      query[k] = String(v);
    }
  }
  const headers = {
    ...signRequest({
      appKey: APP_KEY,
      appSecret: APP_SECRET,
      host: url.host,
      path: url.pathname,
      query,
      body: opts.body,
      accessToken,
    }),
    'content-type': 'application/json',
  };
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return parsed;
}

function show(label: string, value: unknown): void {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2)?.slice(0, 2_000));
}

async function main(): Promise<void> {
  console.log(`Webull smoke test against ${BASE_URL} (trade steps: ${TRADE})`);

  const token = (await call('POST', '/openapi/auth/token/create', {
    body: {},
  })) as { token?: string; access_token?: string; status?: string };
  accessToken = token.token ?? token.access_token;
  show('token/create', { status: token.status, hasToken: Boolean(accessToken) });
  if (!accessToken) throw new Error('No token in token/create response');

  const accounts = (await call('GET', '/openapi/account/list')) as unknown;
  show('account/list', accounts);
  const accountId =
    (Array.isArray(accounts) ? accounts : (accounts as { accounts?: unknown[] })?.accounts ?? [])
      .map((a) => (a as { account_id?: string }).account_id)
      .find(Boolean) ?? '';
  if (!accountId) throw new Error('No account_id found — check account/list shape');
  console.log(`account_id: ${accountId}`);

  show('assets/balance', await call('GET', '/openapi/assets/balance', {
    query: { account_id: accountId },
  }));

  show('stock/snapshot AAPL', await call('GET', '/openapi/market-data/stock/snapshot', {
    query: { symbols: 'AAPL', category: 'US_STOCK' },
  }));

  show('stock/bars AAPL M1', await call('GET', '/openapi/market-data/stock/bars', {
    query: { symbol: 'AAPL', category: 'US_STOCK', timespan: 'M1', count: 5 },
  }));

  const spy = (await call('GET', '/openapi/market-data/stock/snapshot', {
    query: { symbols: 'SPY', category: 'US_STOCK' },
  })) as unknown;
  const spyPrice = Number(
    ((Array.isArray(spy) ? spy[0] : spy) as { price?: unknown })?.price ?? 0,
  );
  const atm = Math.round(spyPrice);
  const today = new Date().toISOString().slice(0, 10);
  const occs = [atm, atm + 1, atm + 2].map((strike) =>
    formatOccSymbol('SPY', today, 'call', strike),
  );
  show(`option/snapshot SPY 0DTE (${occs.join(',')})`, await call(
    'GET',
    '/openapi/market-data/option/snapshot',
    { query: { symbols: occs.join(','), category: 'US_OPTION' } },
  ));

  if (!TRADE) {
    console.log('\nSkipping order placement (re-run with -- --trade).');
    return;
  }

  const farOtmStrike = atm + 20;
  const clientOrderId = `smoke${Date.now().toString(36)}`;
  const newOrder = {
    client_order_id: clientOrderId,
    combo_type: 'NORMAL',
    entrust_type: 'QTY',
    market: 'US',
    side: 'BUY',
    order_type: 'LIMIT',
    limit_price: '0.01',
    quantity: '1',
    time_in_force: 'DAY',
    instrument_type: 'OPTION',
    symbol: 'SPY',
    option_strategy: 'SINGLE',
    position_intent: 'BUY_TO_OPEN',
    legs: [
      {
        symbol: 'SPY',
        strike_price: String(farOtmStrike),
        option_expire_date: today,
        option_type: 'CALL',
      },
    ],
  };
  show('trade/order/preview', await call('POST', '/openapi/trade/order/preview', {
    body: { account_id: accountId, new_orders: [newOrder] },
  }));
  show('trade/order/place (far-OTM 0.01 limit)', await call(
    'POST',
    '/openapi/trade/order/place',
    { body: { account_id: accountId, new_orders: [newOrder] } },
  ));
  show('trade/order/open', await call('GET', '/openapi/trade/order/open', {
    query: { account_id: accountId, page_size: 20 },
  }));
  show('trade/order/cancel', await call('POST', '/openapi/trade/order/cancel', {
    body: { account_id: accountId, client_order_id: clientOrderId },
  }));

  console.log('\nSmoke test completed.');
}

main().catch((err) => {
  console.error(`\nSmoke test FAILED: ${(err as Error).message}`);
  process.exit(1);
});
