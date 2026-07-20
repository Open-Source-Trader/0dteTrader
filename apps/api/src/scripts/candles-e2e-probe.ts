/** E2E check: register a probe user, save env Webull creds via the API, then
 *  verify /v1/market/candles returns ascending, well-formed candles. Never
 *  prints credentials. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const API = 'http://localhost:3000';
const email = `probe-e2e-${Date.now()}@example.com`;

async function api(path: string, opts: RequestInit = {}, token?: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main(): Promise<void> {
  const reg = await api('/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'ProbePass123!' }),
  });
  const token = reg.body?.accessToken;
  if (!token) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);

  const save = await api(
    '/v1/me/webull-credentials',
    {
      method: 'PUT',
      body: JSON.stringify({
        appKey: process.env.WEBULL_APP_KEY,
        appSecret: process.env.WEBULL_APP_SECRET,
        // Market-data calls don't use account_id; a placeholder is fine here.
        accountId: process.env.WEBULL_ACCOUNT_ID ?? 'probe',
      }),
    },
    token,
  );
  console.log(
    'save creds:',
    save.status,
    save.status === 200 || save.status === 204 ? 'ok' : JSON.stringify(save.body)?.slice(0, 200),
  );

  // Bucket alignment per interval: epoch-floored, except weekly (Monday 00:00
  // UTC). 1d is exempt from alignment checks (Webull stamps session dates).
  const bucketSeconds: Record<string, number> = { '30m': 1800, '4h': 14400 };
  for (const interval of ['1d', '30m', '4h', '1w']) {
    const candles = await api(`/v1/market/candles?symbol=SPY&interval=${interval}`, {}, token);
    if (candles.status !== 200) {
      console.log(
        `candles[${interval}] ERROR:`,
        candles.status,
        JSON.stringify(candles.body)?.slice(0, 300),
      );
      continue;
    }
    const rows = candles.body as {
      time: string;
      open: number;
      high: number;
      low: number;
      close: number;
    }[];
    console.log(`candles[${interval}]: ${rows.length} rows`);
    console.log('first:', JSON.stringify(rows[0]));
    console.log('last :', JSON.stringify(rows[rows.length - 1]));
    let ascending = true;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].time <= rows[i - 1].time) {
        ascending = false;
        break;
      }
    }
    console.log('ascending:', ascending);
    const sane = rows.every((r) => r.open > 100 && r.close > 100 && r.high >= r.low);
    console.log('values sane:', sane);
    const seconds = bucketSeconds[interval];
    if (seconds) {
      const aligned = rows.every((r) => (Date.parse(r.time) / 1000) % seconds === 0);
      console.log('bucket-aligned:', aligned);
    }
    if (interval === '1w') {
      const mondays = rows.every((r) => new Date(r.time).getUTCDay() === 1);
      console.log('weekly bars start on Monday:', mondays);
    }
  }

  const quote = await api('/v1/market/quote?symbol=SPY', {}, token);
  console.log('quote:', quote.status, JSON.stringify(quote.body)?.slice(0, 200));

  // Index symbols route via Tradier; skip when no token is configured.
  if (process.env.TRADIER_API_TOKEN) {
    for (const symbol of ['SPX', 'NDX', 'VIX']) {
      const q = await api(`/v1/market/quote?symbol=${symbol}`, {}, token);
      console.log(`index quote[${symbol}]:`, q.status, JSON.stringify(q.body)?.slice(0, 160));
    }
    for (const interval of ['15m', '30m', '4h', '1d', '1w']) {
      const c = await api(`/v1/market/candles?symbol=SPX&interval=${interval}`, {}, token);
      console.log(
        `SPX candles[${interval}]:`,
        c.status,
        Array.isArray(c.body) ? `${c.body.length} rows` : JSON.stringify(c.body)?.slice(0, 200),
      );
    }
  } else {
    console.log('index probe skipped: TRADIER_API_TOKEN not set');
  }
}

main().catch((err) => {
  console.error(`e2e FAILED: ${(err as Error).message}`);
  process.exit(1);
});
