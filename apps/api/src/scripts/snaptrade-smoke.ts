/**
 * SnapTrade sandbox smoke test. This is intentionally conservative: it proves
 * server-side registration + portal URL generation against the configured
 * SnapTrade environment, and optionally exercises an existing connected
 * brokerage if SNAPTRADE_SMOKE_CONNECTION_ID / SNAPTRADE_SMOKE_ACCOUNT_ID are
 * provided.
 *
 * Required env:
 *   SNAPTRADE_CLIENT_ID
 *   SNAPTRADE_CONSUMER_KEY
 * Optional env:
 *   SNAPTRADE_SMOKE_USER_ID      (defaults to smoke-<timestamp>)
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
const userId = process.env.SNAPTRADE_SMOKE_USER_ID ?? `smoke-${Date.now().toString(36)}`;
const connectionId = process.env.SNAPTRADE_SMOKE_CONNECTION_ID ?? '';
const accountId = process.env.SNAPTRADE_SMOKE_ACCOUNT_ID ?? '';

const client = new SnapTradeClient(
  new ConfigService(process.env as Record<string, string>) as unknown as ConfigService,
);

async function main(): Promise<void> {
  if (!process.env.SNAPTRADE_CLIENT_ID || !process.env.SNAPTRADE_CONSUMER_KEY) {
    throw new Error('Set SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY.');
  }

  console.log(`SnapTrade smoke test against ${mode} environment`);
  console.log(`userId: ${userId}`);

  const identity = await client.registerUser(mode, userId);
  const snaptradeUserId = identity.userId ?? userId;
  const snaptradeUserSecret = identity.userSecret ?? '';
  if (!snaptradeUserSecret) {
    throw new Error('registerUser did not return a userSecret.');
  }
  console.log('registerUser:', JSON.stringify(identity, null, 2));

  const auth = await client.authorize(mode, snaptradeUserId, snaptradeUserSecret, {
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

  const connections = await client.listConnections(mode, snaptradeUserId, snaptradeUserSecret);
  console.log('connections:', JSON.stringify(connections, null, 2));

  const accounts = await client.listConnectionAccounts(
    mode,
    snaptradeUserId,
    snaptradeUserSecret,
    connectionId,
  );
  console.log('accounts:', JSON.stringify(accounts, null, 2));

  const openOrders = await client.getOpenOrders(
    mode,
    snaptradeUserId,
    snaptradeUserSecret,
    accountId,
  );
  console.log('openOrders:', JSON.stringify(openOrders, null, 2));
}

main().catch((err) => {
  console.error(`SnapTrade smoke FAILED: ${(err as Error).message}`);
  process.exit(1);
});
