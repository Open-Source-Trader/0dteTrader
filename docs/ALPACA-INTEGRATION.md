# Alpaca Integration

How the Alpaca broker adapter plugs into the existing broker abstraction, and
how it differs from Webull. This is the implementation companion to
`docs/plans/alpaca-provider-plan.md`.

## 1. Where Alpaca lives

```
src/broker/
  broker-gateway.interface.ts        # the seam every client endpoint depends on
  dispatching-broker.gateway.ts      # routes by user.tradingProvider
  webull/  webull-broker.gateway.ts  # unchanged
  alpaca/
    alpaca-endpoints.ts              # hosts + path map + order/query builders
    alpaca-client.ts                 # fetch wrapper (Basic auth, backoff, timeout)
    alpaca-mappers.ts                # Alpaca JSON -> shared DTOs
    alpaca-broker.gateway.ts         # implements BrokerGateway
```

`DispatchingBrokerGateway` implements `BrokerGateway` and forwards every method
to `WebullBrokerGateway` or `AlpacaBrokerGateway` based on the user's
`tradingProvider` (default `webull`). Because the dispatcher satisfies the same
interface, `TradingService`, `MarketDataController`, the WS `StreamGateway`, and
the session controllers are completely unaware of which broker is active.

`BrokerModule` builds both gateways as class-token providers and registers the
dispatcher under the `BROKER_GATEWAY` token.

## 2. Authentication

Alpaca uses **API key + secret over HTTP Basic auth** — no OAuth token, no
token store, no `reauthenticate` dance, no account-id discovery.

| Concern          | Webull                                   | Alpaca                                      |
| ---------------- | ---------------------------------------- | ------------------------------------------- |
| Auth             | OAuth access token (cached, refreshable) | Basic `{apiKey}:{apiSecret}`                |
| Token store      | `BrokerApiToken` (encrypted)             | none                                        |
| Account id       | auto-discovered via account/list         | none — key/secret are account-scoped        |
| `reauthenticate` | drops cache, mints fresh token           | **no-op** (returns the user's trading mode) |

Secrets are stored in the provider-agnostic `BrokerCredential.encSecrets` blob
(see `docs/ARCHITECTURE.md` §5). For Alpaca the decrypted shape is
`{ provider: 'alpaca', apiKey, apiSecret }`.

## 3. Hosts

Configured in `configuration.ts` (`alpaca` block), overridable per environment:

| Purpose        | Config key       | Live default                  | Paper default                       |
| -------------- | ---------------- | ----------------------------- | ----------------------------------- |
| Trading/orders | `tradingBaseUrl` | `https://api.alpaca.markets`  | `https://paper-api.alpaca.markets`  |
| Market data    | `dataBaseUrl`    | `https://data.alpaca.markets` | `https://paper-data.alpaca.markets` |

`live` vs `practice` picks the live vs paper host pair. The auth header is
identical for both; only the base URL differs.

## 4. Endpoint mapping (parity with Webull)

| `BrokerGateway` method | Alpaca call                                                                   |
| ---------------------- | ----------------------------------------------------------------------------- |
| `getQuote` (stock)     | `GET /v2/stocks/snapshots?symbols=`                                           |
| `getQuote` (option)    | `GET /v1beta1/options/snapshots?symbols=` (response nested under `snapshots`) |
| `getCandles`           | `GET /v2/stocks/{symbol}/bars` (or `/v1beta1/options/bars?symbols=`)          |
| `getOptionsChain`      | `GET /v1beta1/options/chains?symbol=&expiration_date=` (real chain endpoint)  |
| `previewOrder`         | resolved client-side; no broker preview call                                  |
| `placeOrder`           | `POST /v2/orders` with deterministic `client_order_id`                        |
| `cancelOrder`          | `DELETE /v2/orders/client:{client_order_id}`                                  |
| `getPositions`         | `GET /v2/positions`                                                           |
| `getOpenOrders`        | `GET /v2/orders?status=open`                                                  |
| `reauthenticate`       | no-op                                                                         |

### OCC parity (critical)

Both adapters emit and parse OCC symbols through the **same**
`formatOccSymbol(symbol, expiration, optionType, strike)` helper in
`contract-resolution.ts`. A Webull-resolved `SPY 250621 C 503` and an
Alpaca-resolved one produce byte-identical OCC (`SPY250621C00503000`), so an
order placed on one broker and inspected on the other is indistinguishable at
the `OrderResult.contractSymbol` level. The Alpaca gateway maps leg-and-expiry
via the same `computeMid` / `estimateBuyingPower` / `parseOccSymbol` helpers as
Webull.

### Differences worth knowing

- **Options chain**: Alpaca hits the real `/v1beta1/options/chains` endpoint (no
  strike-grid probe), so `getOptionsChain` latency matches a single round trip.
- **Idempotency**: `client_order_id` is `md5(environment ‖ ':' ‖ idempotencyKey)`
  — identical derivation to Webull — so retried taps are de-duplicated by the
  broker, not just by our kill-switch.
- **Status polling**: Alpaca fills fast; the gateway polls
  `GET /v2/orders/{id}` once after 1s and emits an `orderUpdate`, same contract
  as Webull.
- **Buying power**: Alpaca has no per-contract buying-power field, so
  `previewOrder` returns the local `estimateBuyingPower` (same model Webull
  uses) plus the 0DTE warning.

## 5. Credentials endpoint

Mobile apps save Alpaca creds through the **generic** endpoint introduced
alongside the legacy Webull one:

```
PUT    /v1/me/broker-credentials   { provider:'alpaca', apiKey, apiSecret, environment? }
DELETE /v1/me/broker-credentials?provider=alpaca&environment=live
```

The legacy `PUT /v1/me/webull-credentials` is retained for the mobile apps
until they switch to the generic endpoint (Phase 3 complete on both platforms;
the legacy routes stay as a compatibility shim).

## 6. Mobile (Phase 3)

Both apps gained, in lockstep:

- A **trading-provider selector** (Webull | Alpaca) bound to `Me.tradingProvider`.
- An **Alpaca credential form** (API key + secret) writing through the generic
  `broker-credentials` endpoint.
- `PATCH /v1/me` now accepts `tradingProvider` (`UpdateMeDto`), so the selector
  persists immediately.
- `Me` gained `tradingProvider` plus `alpacaConfigured` /
  `alpacaPracticeConfigured` / `alpacaAccountId` / `alpacaPracticeAccountId`.

iOS: `ProfileViewModel` + `AlpacaCredentialsForm` + `BrokerProvider` enum +
`AlpacaCredentialsInputDTO` / `BrokerCredentialsSavedDTO` in `DTOs.swift`.
Desktop: `ProfileStore` (provider + Alpaca state), `AlpacaCredentialsForm`, and
`ApiClient.updateTradingProvider` / `putBrokerCredentials` /
`deleteBrokerCredentials`.

## 7. Testing

- `alpaca-broker.gateway.spec.ts` — mapping + OCC parity + idempotency with a
  mocked `fetch`, mirroring `webull-broker.gateway.spec.ts`.
- `dispatching-broker.gateway.spec.ts` — proves every method routes by
  `tradingProvider` to the correct underlying gateway.
- `users.service.spec.ts` / `app.e2e-spec.ts` — `Me` now asserts
  `tradingProvider` + Alpaca flags; `setTradingProvider` is unit-tested.
