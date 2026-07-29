# Plan: SnapTrade as execution + account-data broker (provider toggle)

Status: **Planning — not yet implemented.** Full reference: `docs/SNAPTRADE-INTEGRATION.md`.
Last updated: 2026-07-20.

## Confirmed decisions (2026-07-20)

1. **Scope = execution + accounts only.** SnapTrade handles order placement/cancel, positions,
   open orders, and order-status webhooks for the user's _connected brokerage_. Market data
   (candles, quotes, options chain + Greeks) **stays on the existing Webull + Tradier layers**.
   Rationale: SnapTrade's API has no bulk options-chain or candles endpoint and its option
   coverage is brokerage-dependent — so using it for market data would mean re-synthesizing
   chains and sourcing candles elsewhere, for no benefit over the current hybrid model.
2. **Auth = Commercial / multi-user — per-app-user, not global.** Each app user gets their
   own SnapTrade `userId` + `userSecret` (minted by our server via `registerUser`); the user
   connects _their own_ brokerage through SnapTrade's OAuth Connection Portal. No SnapTrade
   identity or connection is shared across users. The only server-level (non-per-user) values
   are the `clientId`/`consumerKey` env vars that let our server act as a SnapTrade
   integrator — these never identify or scope a user's data.
   > Not a Personal API key (which is scoped to one owner account and only covers one user).
   > The per-user identity is stored encrypted in `broker_credentials` keyed by
   > `(userId, provider='snaptrade', environment)` — exactly one row per user per environment.
   > Connection metadata (OAuth connectionId, accountIds) lives in `broker_connections` keyed
   > by `(userId, provider)` — also one row per user per provider.
   > Webull and Alpaca follow the same per-user shape; SnapTrade is no different.
3. **Additive, third provider.** `'snaptrade'` joins `'webull'` / `'alpaca'` behind the existing
   `DispatchingBrokerGateway` (routes by `user.tradingProvider`). Webull/Alpaca users are 100%
   unaffected. `tradingProvider` stays default `'webull'`.
4. **Market-data delegation seam.** Introduce a thin `MarketDataProvider` (getQuote/getCandles/
   getOptionsChain) implemented by `WebullBrokerGateway`; the `SnapTradeBrokerGateway` forwards
   the 3 data methods to it and implements the 6 execution/account methods natively. Long-term
   `MarketDataProvider` + `ExecutionBroker` split is future cleanup, out of scope here.
5. **Webhook-driven order status.** `TRADE_UPDATE`/`TRADE_DETECTION` webhooks feed
   `OrderEventsService` (WS `orderUpdate`), replacing the poll-until-terminal loop used by the
   Webull/Alpaca gateways for SnapTrade orders.

## Why this is tractable

The `BrokerGateway` seam + dispatcher already exist and Alpaca proved a third provider drops in.
SnapTrade differs only in (a) OAuth connection instead of user-entered secrets and (b) no
market-data — both handled by a connection service + the `MarketDataProvider` forward. The
official `snaptrade-typescript-sdk` handles request signing (HMAC-SHA256 canonical JSON), so we
avoid re-implementing a signer like `webull-signer.ts`.

## Target shape

```ts
// shared-types: union grows
type BrokerProvider = 'webull' | 'alpaca' | 'snaptrade';

// NEW thin seam (3 methods) — Webull implements it; SnapTrade consumes it
interface MarketDataProvider {
  getQuote(userId, symbol): Promise<Quote>;
  getCandles(userId, symbol, req): Promise<Candle[]>;
  getOptionsChain(userId, symbol, exp?): Promise<OptionsChain>;
}
// WebullBrokerGateway implements BrokerGateway AND MarketDataProvider.
// SnapTradeBrokerGateway implements BrokerGateway; data methods forward to MarketDataProvider.

// prisma — additive model (no drops)
model BrokerConnection {
  userId           String;
  provider         String;            // 'snaptrade'
  connectionId     String;
  accountIds       String[];          // accounts under this connection
  selectedAccountId String?;          // trading account
  status           String;            // active | broken | pending
  @@unique([userId, provider])
}

// per-user SnapTrade identity (encrypted blob, server-minted — NOT user-entered)
SnapTradeSecrets = { provider:'snaptrade'; snaptradeUserId; snaptradeUserSecret;
                     accountId?; connectionId? }
```

## Phasing

- **Phase 0 — Pre-req:** SnapTrade Commercial account + API key; register webhook URL in
  Dashboard; note Daily vs Real-time tier.
- **Phase 1 — Schema + types + config (non-breaking):** `BrokerConnection` migration;
  `'snaptrade'` in union; `SnapTradeSecrets` + `Me` flags; `snaptrade` config block;
  `CredentialsService` identity persistence. SnapTrade not yet routable.
- **Phase 2 — Gateway + connection:** `snaptrade-client` (SDK wrapper), `endpoints`, `mappers`,
  `snaptrade-broker.gateway`, `MarketDataProvider` seam, dispatcher branch,
  `snaptrade-connection.service`, connection controllers (authorize/reconnect/list/delete/select).
- **Phase 3 — Webhooks:** `snaptrade-webhook.controller` (signature verify + `TRADE_UPDATE` →
  `OrderEventsService`).
- **Phase 4 — Mobile (iOS + desktop as a pair):** provider selector + "Connect brokerage" (OAuth)
  flow + account picker; persist `tradingProvider: 'snaptrade'`.
- **Phase 5 — Verification:** `npm run smoke:snaptrade` in SnapTrade **Sandbox** (registerUser →
  authorize → connection → place practice order → `TRADE_UPDATE` webhook → reconcile); then a real
  brokerage in `practice` mode.

## Open risks (verify during build — full list in SNAPTRADE-INTEGRATION.md §6)

- Option `BUY_TO_OPEN` support for the _connected_ brokerage (brokerage-dependent).
- Exact SnapTrade **cancel-order** endpoint path.
- No `client_order_id` idempotency → rely on app kill-switch + ephemeral `tradeId`.
- `TRADE_UPDATE` is beta → keep reconcile + light poll fallback until proven.
- Free plan = Daily account data; Real-time needs Pay-as-you-Go.
- Soft rate limit 1 trade/sec/account → serialize order placement; honor `Retry-After`.
- Multi-account → persist + let user pick trading account.
- Practice vs Live maps to SnapTrade Sandbox vs Production key.
