# API SPEC — 0dteTrader Backend

Base URL: `/v1`. Machine-readable schema: `docs/openapi.yaml`.

Auth: `Authorization: Bearer <accessToken>` on all endpoints except `/v1/auth/*`.
Errors: `{ "error": { "code": string, "message": string } }` with appropriate HTTP status.

## Auth

| Method | Path                | Body                  | Returns                |
| ------ | ------------------- | --------------------- | ---------------------- |
| POST   | `/v1/auth/register` | `{ email, password }` | `AuthTokens`           |
| POST   | `/v1/auth/login`    | `{ email, password }` | `AuthTokens`           |
| POST   | `/v1/auth/refresh`  | `{ refreshToken }`    | `AuthTokens` (rotated) |
| POST   | `/v1/auth/logout`   | `{ refreshToken }`    | 204                    |

`AuthTokens = { accessToken, refreshToken, expiresIn }`

## Profile & Credentials

| Method | Path                                     | Body                                             | Returns                                                                                                                             |
| ------ | ---------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/me`                                 | —                                                | `{ id, email, tradingDisabled, tradingMode, webullConfigured, webullPracticeConfigured, webullAccountId, webullPracticeAccountId }` |
| PATCH  | `/v1/me`                                 | `{ tradingMode: 'live' \| 'practice' }`          | updated `Me`                                                                                                                        |
| PUT    | `/v1/me/webull-credentials`              | `{ appKey, appSecret, accountId, environment? }` | `{ webullConfigured: true, environment }`                                                                                           |
| DELETE | `/v1/me/webull-credentials?environment=` | —                                                | 204                                                                                                                                 |
| POST   | `/v1/me/webull-session/refresh`          | —                                                | `{ refreshed: true, environment }`                                                                                                  |

`tradingMode` is a per-user server-side setting selecting the Webull
environment (live production vs practice/paper sandbox) used for quotes and
orders. `webullConfigured` reflects stored **live** credentials;
`webullPracticeConfigured` reflects stored **practice** credentials.
`webullAccountId` / `webullPracticeAccountId` are the auto-discovered account
IDs (via `GET /openapi/account/list` after first authentication); `null` until
the first successful connection. The optional `environment` (`'live'` default,
or `'practice'`) selects which credential set a PUT/DELETE applies to. Practice
mode with no stored practice credentials falls back to the server's built-in
practice app credentials (`WEBULL_PRACTICE_*`).

Credentials are never returned in any response.

`POST /v1/me/webull-session/refresh` drops the cached Webull client/token for
the caller's **current** trading mode and mints a fresh access token using the
stored credentials — the "Reconnect" escape hatch when a token goes stale, so
users don't have to re-enter their app key/secret.

## Market Data

| Method | Path                           | Query                                                 | Returns                    |
| ------ | ------------------------------ | ----------------------------------------------------- | -------------------------- |
| GET    | `/v1/market/quote`             | `symbol`                                              | `Quote`                    |
| GET    | `/v1/market/candles`           | `symbol, interval (1m/5m/15m/30m/1h/4h/1d), from, to` | `Candle[]`                 |
| GET    | `/v1/market/options-chain`     | `symbol, expiration?`                                 | `OptionsChain`             |
| GET    | `/v1/market/options-analytics` | `symbol, expiration` (required exact match)           | `OptionsAnalyticsSnapshot` |

Options analytics are fact-first. Call and put gamma are unsigned magnitudes,
gross gamma is their sum, and delta fields describe long-holder option delta.
The optional `callPutDealerProxy` is an explicitly labeled call-minus-put OI
scenario; it is not observed dealer inventory. Gamma exposure is always USD
delta change per a 1% underlying move. Marked OI is open interest times the
current option mark and contract multiplier; it is not traded premium or flow.

The required expiration is never replaced by another date. Invalid
optional layers are `null` with `quality.status: partial` and warnings. A fully
unusable exact snapshot returns an API error instead of fabricated values.

Crypto symbols (e.g. `BTC`, `ETH`) are routed to the Coinbase public API for
quotes and candles — no Webull credentials needed.

## Trading

| Method | Path                   | Body                                      | Returns                |
| ------ | ---------------------- | ----------------------------------------- | ---------------------- |
| POST   | `/v1/orders/preview`   | `OrderRequest`                            | `OrderPreview`         |
| POST   | `/v1/orders`           | `OrderRequest` + `Idempotency-Key` header | `OrderResult`          |
| GET    | `/v1/orders`           | —                                         | `OrderResult[]` (open) |
| GET    | `/v1/orders/history`   | —                                         | `TradeHistory`         |
| DELETE | `/v1/orders/{orderId}` | —                                         | 204                    |
| GET    | `/v1/positions`        | —                                         | `Position[]`           |

### OrderRequest

```json
{
  "underlying": "SPY",
  "assetClass": "option",
  "side": "buy" | "sell",
  "quantity": 1,
  "orderType": "mid" | "market",
  "selection": {
    "mode": "auto_otm" | "explicit",
    "optionType": "call" | "put",        // required for auto_otm + explicit option
    "expiration": "2026-07-17",          // optional; defaults to nearest
    "strike": 503                        // explicit option only
  }
}
```

Server behavior:

- `auto_otm`: server recomputes the +1 OTM strike from the live quote + chain at submission time.
- `mid`: server recomputes `(bid+ask)/2` from the live quote; falls back to validation error if
  the spread is crossed/locked abnormally.
- Kill switch on → `403 TRADING_DISABLED`. Duplicate `Idempotency-Key` → prior `OrderResult`.

## WebSocket

`GET /v1/stream?token=<accessToken>` (upgrade).

Client → server:

```json
{ "type": "subscribe",   "symbols": ["SPY"] }
{ "type": "unsubscribe", "symbols": ["SPY"] }
```

Server → client:

```json
{ "type": "quote",      "data": Quote }
{ "type": "orderUpdate","data": OrderResult }
{ "type": "error",      "error": { "code": "...", "message": "..." } }
```

## Health

| Method | Path         | Auth          | Returns                                                           |
| ------ | ------------ | ------------- | ----------------------------------------------------------------- |
| GET    | `/v1/health` | none (public) | `{ status: 'ok'\|'degraded', db: 'ok'\|'error', uptime: number }` |

## Core Schemas

```yaml
Quote:            { symbol, bid, ask, last, bidSize, askSize, volume, timestamp }
Candle:           { time, open, high, low, close, volume }
OptionContract:   { symbol, underlying, expiration, strike, optionType, bid, ask, last }
OptionsChain:     { underlying, underlyingPrice, expirations: string[], contracts: OptionContract[] }
Position:         { symbol, assetClass, quantity, avgPrice, markPrice, unrealizedPnl, multiplier }
OrderPreview:     { resolved: { contractSymbol, price, estBuyingPower }, warnings: string[] }
OrderResult:      { orderId, status, contractSymbol, side, quantity, orderType, limitPrice?, filledPrice?, filledQuantity?, timestamp }
TradeHistoryEntry: OrderResult & { realizedPnl: number | null }
TradeHistory:     { entries: TradeHistoryEntry[], totalRealizedPnl: number }
OptionsAnalyticsSnapshot:
  {
    scope: { symbol, rootSymbol, settlementStyle, expiration, observedAt, settlementAt, spot, forward },
    exposureUnit: '$ delta change per 1% underlying move',
    quality: { quoteAsOf?, greeksAsOf?, oiEffectiveDate?, feedMode, coverage, status, warnings, calculationVersion, cacheStatus },
    structure: { callGammaExposure: number|null, putGammaExposure: number|null, grossGammaExposure: number|null, callDeltaNotional: number|null, putDeltaNotional: number|null, callWall: number|null, putWall: number|null, grossGammaConcentration: number|null, maxOpenInterestStrike: number|null },
    scenarios: { callPutDealerProxy? },
    impliedRange?,
    strikes: OptionsAnalyticsStrike[]
  }
OptionsAnalyticsStrike:
  { strike, call?, put?, grossGammaExposure, totalOpenInterest }
OptionsAnalyticsStrikeLeg:
  { openInterest, volume, impliedVolatility, delta, gamma, gammaExposure, deltaNotional, markedOiValue?, relativeSpread?, roundTripCost?, bidSize, askSize, multiplier }
```

The optional `scenarios.callPutDealerProxy` object owns its signed
`strikeGammaExposures`; signed dealer-proxy values never appear in the fact-first
strike rows.

When a valid two-sided quote cannot support local IV inversion, its OI, volume,
marked-OI value, sizes, and spread remain available. The leg's IV/Greek/notional
fields and any unavailable per-strike gamma layer are `null`; coverage and
warnings disclose the modeling loss. If no leg can be modeled, the snapshot
still returns those observed layers, all modeled structure totals are `null`,
and the implied range and dealer proxy are `null`.

`AssetClass` is `'option'` only in v1 (futures support is deferred).
