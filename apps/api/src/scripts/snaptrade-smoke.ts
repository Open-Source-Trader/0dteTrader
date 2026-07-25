/**
 * SnapTrade sandbox smoke test (Personal API key mode). This proves Connection
 * Portal URL generation against a real Personal client ID/consumer key, and
 * optionally exercises an existing connected brokerage if
 * SNAPTRADE_SMOKE_CONNECTION_ID / SNAPTRADE_SMOKE_ACCOUNT_ID are provided.
 *
 * There is no server-side registration step under the Personal model — the
 * key pair below must belong to a real SnapTrade Personal customer (create
 * one for free in the SnapTrade Dashboard).
 *
 * Required env:
 *   SNAPTRADE_SMOKE_CLIENT_ID
 *   SNAPTRADE_SMOKE_CONSUMER_KEY
 * Optional env:
 *   SNAPTRADE_SMOKE_MODE         (practice | live; default practice)
 *   SNAPTRADE_SMOKE_CONNECTION_ID
 *   SNAPTRADE_SMOKE_ACCOUNT_ID
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { SnapTradeClient } from '../broker/snaptrade/snaptrade-client';

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

const mode = (process.env.SNAPTRADE_SMOKE_MODE === 'live' ? 'live' : 'practice') as
  'live' | 'practice';
const connectionId = process.env.SNAPTRADE_SMOKE_CONNECTION_ID ?? '';
const accountId = process.env.SNAPTRADE_SMOKE_ACCOUNT_ID ?? '';
const clientId = process.env.SNAPTRADE_SMOKE_CLIENT_ID ?? '';
const consumerKey = process.env.SNAPTRADE_SMOKE_CONSUMER_KEY ?? '';

const client = new SnapTradeClient(
  new ConfigService(process.env as Record<string, string>) as unknown as ConfigService,
);

async function main(): Promise<void> {
  if (!clientId || !consumerKey) {
    throw new Error('Set SNAPTRADE_SMOKE_CLIENT_ID and SNAPTRADE_SMOKE_CONSUMER_KEY.');
  }

  console.log(`SnapTrade smoke test against ${mode} environment (Personal API key)`);

  const auth = await client.authorize(mode, clientId, consumerKey, {
    connectionType: 'trade',
    immediateRedirect: true,
  });
  console.log('authorize.redirectUrl:', auth.redirectUrl);

  if (!connectionId || !accountId) {
    console.log(
      'Skipping connected-account checks; set SNAPTRADE_SMOKE_CONNECTION_ID and SNAPTRADE_SMOKE_ACCOUNT_ID to continue.',
    );
    return;
  }

  const connections = await client.listConnections(mode, clientId, consumerKey);
  console.log('connections:', JSON.stringify(connections, null, 2));

  const accounts = await client.listConnectionAccounts(mode, clientId, consumerKey, connectionId);
  console.log('accounts:', JSON.stringify(accounts, null, 2));

  const openOrders = await client.getOpenOrders(mode, clientId, consumerKey, accountId);
  console.log('openOrders:', JSON.stringify(openOrders, null, 2));
}

main().catch((err) => {
  console.error(`SnapTrade smoke FAILED: ${(err as Error).message}`);
  process.exit(1);
});
