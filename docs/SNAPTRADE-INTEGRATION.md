# SnapTrade Integration — 0dteTrader

> **Status:** Planning. Not yet implemented. Companion tracking file:
> `docs/plans/snaptrade-provider-plan.md`.
>
> **Confirmed scope (2026-07-20):** SnapTrade owns **trade execution + account data**
> (order placement, cancel, positions, open orders, order-status webhooks) for the user's
> _connected brokerage_. Market data (candles, quotes, options chain + Greeks) **stays on the
> existing Webull + Tradier layers**. Auth model: **Commercial / multi-user** — each app user
> gets a SnapTrade user (`userId` + `userSecret`) minted by our server, then connects their own
> brokerage through SnapTrade's OAuth Connection Portal.

## 1. What SnapTrade is (and isn't)

SnapTrade is a **brokerage aggregator**, not a broker. It normalizes ~20+ retail brokerages
(Robinhood, Schwab, Fidelity, Questrade, etc.) behind one API. The end user authorizes
SnapTrade to access _their own_ brokerage account via an OAuth-style Connection Portal; our
server then trades/reads through SnapTrade, which proxies to the underlying broker.

This is fundamentally different from Webull (a direct broker with app-key/secret) and Alpaca
(a direct broker with API-key/secret). For 0dteTrader it means:

- **No user-entered API keys.** Instead a server-side `clientId`/`consumerKey` (ours) plus a
  per-user `userId`/`userSecret` (minted by us) and an OAuth _connection_ the user performs
  in a browser.
- **Per-account everything.** Every trading/positions/orders call requires an `accountId`
  chosen from the user's connected accounts.
- **Execution + account data only.** SnapTrade has equity/option _quotes_ (per account) and
  account/positions/orders, but **no bulk options-chain endpoint and no candles/bars**. Its
  option coverage is brokerage-dependent. This is exactly why market data stays external.

### Capability mapping

| 0dteTrader need             | SnapTrade capability                                                                                                       | Confidence      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------- |
| User auth to broker         | Commercial `registerUser` → `userId`/`userSecret`; user connects brokerage via Connection Portal (`connectionType: trade`) | verified (docs) |
| Connect a brokerage (OAuth) | `POST /snapTrade/authorize/` → Connection Portal redirect URL; webhooks `CONNECTION_ADDED`/`CONNECTION_BROKEN`             | verified (docs) |
| Place equity order          | `POST /snapTrade/orders/force` (`placeForceOrder`) or impact→`placeOrder` (`tradeId`)                                      | verified (docs) |
| Place **option** order      | `POST /snapTrade/options/place` (`placeMlegOrder`), 1–4 legs; single-leg = one leg                                         | verified (docs) |
| Cancel order                | SnapTrade cancel endpoint (confirm exact path in Trading reference — not in the doc index)                                 | **verify**      |
| Positions                   | `GET /snapTrade/accounts/{accountId}/positions` (`getAllAccountPositions`)                                                 | verified (docs) |
| Open orders                 | `GET /snapTrade/accounts/{accountId}/orders` / `.../recent-orders` (last 24h)                                              | verified (docs) |
| Order status (live)         | Webhooks `TRADE_UPDATE` (beta) + `TRADE_DETECTION` (subscription) → push; replaces polling                                 | verified (docs) |
| Preview / buying power      | `POST /snapTrade/orders/impact` (equity) + `POST /snapTrade/options/impact` (option, ≤4 legs)                              | verified (docs) |
| Quotes (per account)        | Equity `GET /snapTrade/accounts/{accountId}/quotes` (≤10 symbols); Option `GET .../options/{symbol}` (OCC)                 | verified (docs) |
| **Candles / bars**          | **Not provided by SnapTrade** → sourced from Webull (current)                                                              | n/a (external)  |
| **Options chain + Greeks**  | **Not provided by SnapTrade** → sourced from Tradier (current)                                                             | n/a (external)  |
| Webhook authenticity        | `Signature` header = HMAC-SHA256(canonical body, `consumerKey`), base64; replay guard via `eventTimestamp`                 | verified (docs) |
| Sandbox (paper)             | SnapTrade Sandbox = simulated brokerage for end-to-end testing; maps to `tradingMode: 'practice'`                          | verified (docs) |

## 2. Architecture: how SnapTrade plugs in

The backend already has the key seam (`BrokerGateway` interface + `BROKER_GATEWAY` token +
`DispatchingBrokerGateway` routing by `user.tradingProvider`). Alpaca already proves a third
provider drops in cleanly. SnapTrade follows the **same pattern** with two additions forced by
its aggregator nature: a **market-data delegation** seam and a **connection/OAuth** service.

> **Per-user boundary (non-negotiable).** SnapTrade identities (`userId`/`userSecret`),
> OAuth connections (`connectionId`), and selected accounts (`accountId`) are **per app
> user**, stored encrypted in `broker_credentials` and `broker_connections` keyed by
> `(userId, provider)`. They are never pooled, shared, or stored in server config. The
> only non-per-user SnapTrade values in `AppConfig` are `clientId`/`consumerKey` (our
> server's integrator credentials — they authenticate our server to SnapTrade's API, they
> never identify or scope a user's data). This matches the Webull pattern exactly:
> server holds one set of Webull API keys in `AppConfig`; each user stores their own
> credentials encrypted in `broker_credentials` keyed by `(userId, provider, env)`.

### 2.1 Provider dispatch (mirror Alpaca)

Add `'snaptrade'` to `BrokerProvider`. `DispatchingBrokerGateway.gatewayFor(userId)` gains a
`snaptrade` branch. Nothing about Webull/Alpaca changes.

```
BrokerProvider = 'webull' | 'alpaca' | 'snaptrade'   // shared-types
```

### 2.2 Market-data delegation (the one new seam)

SnapTrade cannot supply candles or a full options chain, so the `SnapTradeBrokerGateway` must
not source market data from SnapTrade. Introduce a **small `MarketDataProvider` seam** = the 3
data methods (`getQuote`, `getCandles`, `getOptionsChain`), implemented by the existing
`WebullBrokerGateway` (which already reaches Tradier for the chain + Greeks underneath). The
SnapTrade gateway depends on `MarketDataProvider` for those 3 calls and implements the 6
execution/account methods natively.

```
interface MarketDataProvider {            // NEW, thin — 3 methods only
  getQuote(userId, symbol): Promise<Quote>;
  getCandles(userId, symbol, req): Promise<Candle[]>;
  getOptionsChain(userId, symbol, exp?): Promise<OptionsChain>;
}
// WebullBrokerGateway implements BOTH BrokerGateway AND MarketDataProvider.
// AlpacaBrokerGateway keeps implementing the full BrokerGateway (unchanged).
// SnapTradeBrokerGateway implements BrokerGateway; data methods forward to injected MarketDataProvider.
```

Why this shape (not a big refactor): it keeps Webull/Alpaca 100% unchanged, confines the
SnapTrade market-data gap to a single forward inside one gateway, and is additive. The long-term
ideal — promoting _every_ provider to the `MarketDataProvider` + `ExecutionBroker` split — is
noted as future cleanup but is **out of scope** for this plan.

### 2.3 Auth / connection model (the big difference)

```
┌─────────────┐   clientId/consumerKey     ┌──────────────────────────┐
│ 0dteTrader │──────────────────────────►  │ SnapTrade (Commercial)    │
│  server     │◄─────────────────────────── │  - registerUser          │
│             │   userId/userSecret         │  - authorize (portal URL)│
│             │   + Connection Portal URL    │  - accounts / trading     │
└──────┬──────┘                             └───────────┬──────────────┘
       │ 1. enable SnapTrade                       │ 3. user OAuth-connects
       │    → registerUser (mint id/secret)       │    their brokerage
       │ 2. authorize → portal redirect URL       │
       ▼                                            ▼
┌─────────────┐                              ┌──────────────────────────┐
│ Mobile/Web  │   opens portal (in-app      │ User's brokerage         │
│ client      │   browser / popup)          │ (Robinhood, Schwab, …) │
└─────────────┘                              └──────────────────────────┘
       4. CONNECTION_ADDED webhook → store connectionId + accountId(s)
```

- **Server config** (env, not per-user): `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY`,
  prod + sandbox base URLs, and `SNAPTRADE_WEBHOOK_CONSUMER_KEY` (used to verify incoming
  webhooks; can equal `consumerKey`).
- **Per-user identity**: `POST /snapTrade/registerUser/` mints `{ userId, userSecret }`. We
  persist these (encrypted) and reuse them for every subsequent call — there is no per-request
  user-entered secret like Alpaca.
- **Connection (OAuth)**: `POST /snapTrade/authorize/` with `connectionType: 'trade'`, optional
  `brokerage` preselect, and `immediateRedirect` + `callback` deep-link params → returns a
  Connection Portal URL the client opens. On success SnapTrade fires `CONNECTION_ADDED`.
- **Account selection**: a connection can expose multiple `accountId`s. We persist them and let
  the user pick a trading account (`selectedAccountId`); every SnapTrade trading call needs it.
- **`reauthenticate(userId)`**: SnapTrade has no token to refresh. Overload semantics: it
  returns the user's `tradingMode` for interface parity **and** the gateway exposes a dedicated
  `POST /v1/me/broker-connections/snaptrade/reconnect` that returns a fresh portal URL for a
  `CONNECTION_BROKEN`/expired connection (`connectionType: 'trade'`, `reconnect: <id>`).

## 3. Endpoint / call mapping (SnapTrade → `BrokerGateway`)

| `BrokerGateway` method  | SnapTrade call                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `getQuote`              | **Delegated** to `MarketDataProvider` (Webull → Webull/Tradier). Not SnapTrade.                |
| `getCandles`            | **Delegated** to `MarketDataProvider`. Not SnapTrade.                                          |
| `getOptionsChain`       | **Delegated** to `MarketDataProvider` (Tradier chain + Greeks). Not SnapTrade.                 |
| `previewOrder` (equity) | `POST /snapTrade/orders/impact` (`getOrderImpact`) → `Trade` + `tradeId` + est. cost/fees      |
| `previewOrder` (option) | `POST /snapTrade/options/impact` (`getOptionImpact`, ≤4 legs)                                  |
| `placeOrder` (equity)   | `POST /snapTrade/orders/force` (`placeForceOrder`) — validate client-side, then place directly |
| `placeOrder` (option)   | `POST /snapTrade/options/place` (`placeMlegOrder`), single leg for 0DTE buys                   |
| `cancelOrder`           | SnapTrade cancel endpoint — **verify exact path** in Trading reference                         |
| `getPositions`          | `GET /snapTrade/accounts/{accountId}/positions`                                                |
| `getOpenOrders`         | `GET /snapTrade/accounts/{accountId}/orders` (or `.../recent-orders`), filtered to open        |
| `reauthenticate`        | No-op token refresh; returns `tradingMode`. Reconnect handled by dedicated endpoint (§2.3).    |
| live order status       | **Webhook `TRADE_UPDATE`/`TRADE_DETECTION` → `OrderEventsService`** (no polling)               |

### Order payload shapes (from SnapTrade docs)

- **Equity** (`placeForceOrder`): `account_id`, `symbol` (brokerage symbol), `action`
  (`BUY`/`SELL`), `order_type` (`Market`/`Limit`/`Stop`/`StopLimit`), `time_in_force`
  (`Day`/`GTC`), `units` (shares) or `notional_value`, optional `trading_session: "EXTENDED"`.
- **Options** (`placeMlegOrder`, single-leg for 0DTE): `account_id`, `order_type`,
  `time_in_force`, `price_effect` (`DEBIT`/`CREDIT`), and a `legs[]` with
  `instrument.symbol` = **OCC 21-char** (e.g. `AAPL 251114C00240000`),
  `action` (`BUY_TO_OPEN`/`BUY_TO_CLOSE`/`SELL_TO_OPEN`/`SELL_TO_CLOSE`), `units` (contracts).
- **Idempotency note:** SnapTrade has no documented `client_order_id` like Webull/Alpaca. We
  keep our app-side kill-switch dedupe, and for checked orders we consume the ephemeral `tradeId`
  (expires in minutes). Flagged as a risk in §6.

### OCC parity (critical, reused)

Both existing gateways emit/parse OCC through `formatOccSymbol` / `parseOccSymbol` in
`contract-resolution.ts`. SnapTrade's option `instrument.symbol` is the **21-char OCC** exactly
(`SPY 250621C00503000`). The SnapTrade gateway resolves the contract from the existing
Tradier-sourced chain (via `MarketDataProvider.getOptionsChain`), then hands the 21-char OCC to
SnapTrade — so no option-chain pull from SnapTrade is ever required, and contract symbols stay
byte-identical across brokers.

## 4. Webhooks (order status + connection lifecycle)

New `POST /v1/webhooks/snaptrade` controller (register its URL in the SnapTrade Dashboard).

1. **Verify** the `Signature` header: HMAC-SHA256 over the **raw canonical JSON body** keyed by
   `consumerKey`, base64 — compare to the header. Reject on mismatch. Replay guard: drop if
   `eventTimestamp` is older than ~300s (per SnapTrade's own example).
2. **Connection lifecycle:** `CONNECTION_ADDED` → persist `connectionId` + `accountId`(s), mark
   `snaptradeConfigured`. `CONNECTION_BROKEN` → flag reconnect needed. `NEW_ACCOUNT_AVAILABLE` →
   append the new `accountId`.
3. **Order status (the payoff):** `TRADE_UPDATE` (beta) and `TRADE_DETECTION` (subscription)
   carry the current order with `legs[].status` (`EXECUTED`/`PARTIALLY_FILLED`/`CANCELLED`/…),
   `execution_price`, and `brokerage_order_id`. Map leg status → app `OrderStatus`
   (`filled`/`partially_filled`/`cancelled`/`rejected`), extract `filledPrice`, and **emit through
   `OrderEventsService`** (the WS `orderUpdate` channel). This removes the poll-until-terminal
   loop that Webull/Alpaca gateways use.
4. **Idempotent + 2xx:** SnapTrade retries webhooks with exponential backoff (30 min start, 3
   tries), so the handler must be idempotent and always return 2xx.

## 5. Files to create / modify

### New — `apps/api/src/broker/snaptrade/`

| File                              | Responsibility (mirrors `alpaca/`)                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snaptrade-endpoints.ts`          | Hosts (prod/sandbox), endpoint-key map, order/leg builders, OCC formatting, account resolution.                                                         |
| `snaptrade-client.ts`             | Wraps the official `snaptrade-typescript-sdk` (signing + typing + base-path switch); backoff, timeout, error mapping to `brokerErrors`.                 |
| `snaptrade-mappers.ts`            | SnapTrade `Trade`/`Position`/`Order` → shared DTOs (`OrderResult`, `Position`, `OptionsChain` via delegated chain); 21-char OCC ↔ app OCC.              |
| `snaptrade-broker.gateway.ts`     | Implements `BrokerGateway`. 6 exec/account methods native; 3 data methods forward to injected `MarketDataProvider`. No status polling (webhook-driven). |
| `snaptrade-connection.service.ts` | `registerUser` (mint + persist `userId`/`userSecret`), `authorize` (portal URL), `listConnections`/`listAccounts`, `deleteConnection`, `reconnect`.     |
| `snaptrade-webhook.controller.ts` | Webhook receiver + signature verification + `OrderEventsService` emission (§4).                                                                         |
| `*.spec.ts`                       | Client/mapper parity, dispatcher `snaptrade` branch, connection service, webhook signature + status mapping.                                            |

### Modify

- `apps/api/src/broker/broker-gateway.interface.ts` — add `MarketDataProvider` (3 methods).
- `apps/api/src/broker/dispatching-broker.gateway.ts` — `snaptrade` branch; inject `MarketDataProvider`.
- `apps/api/src/broker/webull/webull-broker.gateway.ts` — also `implements MarketDataProvider`.
- `apps/api/src/broker/broker.module.ts` — register `SnapTradeBrokerGateway`, `SnapTradeConnectionService`, webhook controller; add `snaptrade` to dispatcher; provide `MarketDataProvider` (Webull).
- `packages/shared-types/src/index.ts` — `'snaptrade'` in `BrokerProvider`; add `SnapTradeSecrets`
  (`{ provider:'snaptrade'; snaptradeUserId; snaptradeUserSecret; accountId?; connectionId? }`),
  extend `BrokerSecrets` union; add `Me` flags (`snaptradeConfigured`, `snaptradeAccountId`,
  `snaptradeConnectionStatus`).
- `apps/api/src/config/configuration.ts` — `snaptrade` block (`clientId`, `consumerKey`,
  `prodBaseUrl`, `sandboxBaseUrl`, `webhookConsumerKey`).
- `apps/api/prisma/schema.prisma` — **additive** `BrokerConnection` model
  (`userId`, `provider`, `connectionId`, `accountIds String[]`, `selectedAccountId?`, `status`)
  keyed on `(userId, provider)`; no drops. (The `userId`/`userSecret` live encrypted in
  `broker_credentials.encSecrets` as today; `BrokerConnection` tracks the OAuth connection(s)
  - accounts so webhooks can update them.)
- `apps/api/src/credentials/credentials.service.ts` — add `snaptrade` branch to `toSecrets`;
  add `saveSnapTradeIdentity` / `getSnapTradeIdentity` (server-minted, **not** via the generic
  user-entered `PUT /broker-credentials`).
- `apps/api/src/credentials/credentials.controller.ts` + `webull-session.controller.ts` —
  new SnapTrade connection routes (see §5.1). Do **not** route these through the generic
  `broker-credentials` PUT (those expect user-entered secrets).
- Mobile **iOS + desktop as a pair** (per AGENTS.md): add `snaptrade` to the provider selector;
  replace the "enter API key" form with a **"Connect brokerage"** button → `authorize` → open
  Connection Portal in an in-app browser (iOS `ASWebAuthenticationSession` /
  `SFSafariViewController`; desktop popup/redirect); show connection status + account picker from
  `GET`; persist `tradingProvider: 'snaptrade'`.
- `.env.example` / `.env` — add `SNAPTRADE_*` vars + a note to register the webhook URL in the
  SnapTrade Dashboard.
- Docs: this file + `docs/plans/snaptrade-provider-plan.md`; update `ARCHITECTURE.md`,
  `ROADMAP.md`, `openapi.yaml`.

### 5.1 New API routes (SnapTrade connection lifecycle)

```
POST   /v1/me/broker-connections/snaptrade/authorize   → { redirectUrl }   (registerUser + authorize)
GET    /v1/me/broker-connections/snaptrade             → { connections[], accounts[], status }
DELETE /v1/me/broker-connections/snaptrade             → disconnect (revoke connection)
POST   /v1/me/broker-connections/snaptrade/reconnect  → { redirectUrl }   (broken/expired → fresh portal URL)
POST   /v1/me/broker-connections/snaptrade/select     → { accountId }     (pick trading account)
POST   /v1/webhooks/snaptrade                          → 200 (webhook receiver, §4)
```

## 6. Risks / open questions (verify before/while building)

1. **Option support is brokerage-dependent.** A 0DTE single-leg `BUY_TO_OPEN` must be supported
   by the _connected_ brokerage via SnapTrade. Check the SnapTrade brokerage support matrix for the
   target broker(s) (Robinhood/Schwab/Fidelity) before launch. (`getOptionImpact` is "only
   supported for certain enabled brokerages.")
2. **Order cancellation endpoint.** The doc index did not surface the cancel endpoint; confirm the
   exact path/method in the Trading reference and map `cancelOrder` to it.
3. **No `client_order_id` idempotency.** Unlike Webull/Alpaca, SnapTrade has no stable
   client-side order id; rely on app kill-switch dedupe + ephemeral `tradeId`. Flagged.
4. **`TRADE_UPDATE` is beta.** Also reconcile via `getUserAccountRecentOrders` after placement
   (as SnapTrade recommends) and keep a lightweight poll fallback until webhook reliability is proven
   in production.
5. **Data freshness / plan tier.** Free plan returns _Daily_ account data; _Real-time_ requires
   Pay-as-you-Go. Affects position/order latency for SnapTrade-sourced account data.
6. **Webhook delivery + signature.** Handler must verify HMAC, reject replays (>300s), be
   idempotent, and return 2xx (SnapTrade retries with 30-min exponential backoff, 3 tries).
7. **Soft rate limit: 1 trade/sec/account.** Serialize/queue order placement per account; honor
   `Retry-After` (map 429 → `BROKER_RATE_LIMITED`).
8. **Multi-account.** A connection can expose several accounts; persist + let the user pick the
   trading account (`selectedAccountId`).
9. **Practice vs Live.** SnapTrade Sandbox ≈ `practice`; Production key ≈ `live`. Two API
   keys/hosts; `tradingMode` selects. Sandbox is the vehicle for the end-to-end smoke test.
10. **Market-data stays external by design.** SnapTrade is never asked for candles or a bulk chain;
    if a future requirement needs SnapTrade-sourced quotes, scope it separately (single-OCC
    `getUserAccountOptionQuotes` exists; bulk chain does not).

## 7. Phasing (mirrors Alpaca's 4 phases + verification)

- **Phase 0 — Pre-req:** Create SnapTrade Commercial account; generate API key; register the
  webhook URL in the Dashboard; note client tier (Daily vs Real-time).
- **Phase 1 — Schema + types + config (non-breaking):** `BrokerConnection` model + migration;
  `'snaptrade'` in `BrokerProvider`; `SnapTradeSecrets`/`Me` flags; `snaptrade` config block;
  `CredentialsService` identity persistence. SnapTrade not yet routable.
- **Phase 2 — Gateway + connection:** `snaptrade-client` (SDK wrapper), `endpoints`, `mappers`,
  `snaptrade-broker.gateway` (6 native exec/account methods + 3 delegated data methods),
  `MarketDataProvider` seam, dispatcher `snaptrade` branch, `snaptrade-connection.service`, and the
  authorize/reconnect/list/delete/select controllers.
- **Phase 3 — Webhooks:** `snaptrade-webhook.controller` (signature verify + `TRADE_UPDATE` →
  `OrderEventsService`). Removes polling for SnapTrade orders.
- **Phase 4 — Mobile (iOS + desktop as a pair):** provider selector + "Connect brokerage"
  (OAuth) flow + account picker; persist `tradingProvider: 'snaptrade'`.
- **Phase 5 — Verification:** `npm run smoke:snaptrade` against SnapTrade **Sandbox** —
  registerUser → authorize → sandbox connection → place a practice order → confirm `TRADE_UPDATE`
  webhook → reconcile via `getOpenOrders`. Then promote to a real brokerage in `practice` mode.

### Exit criteria

- `npm run test` (API) green; `npm run lint` clean; `npm run build` succeeds.
- `snaptrade-broker.gateway.spec.ts`, `dispatching-broker.gateway.spec.ts` (snaptrade branch),
  `snaptrade-connection.service.spec.ts`, `snaptrade-webhook.controller.spec.ts` (signature +
  status mapping) all pass.
- Sandbox smoke test places + cancels an order and receives a verified `TRADE_UPDATE` webhook.
- Webull/Alpaca users remain 100% unaffected (additive change).
