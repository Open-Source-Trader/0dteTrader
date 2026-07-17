# API SPEC — 0dteTrader Backend

Base URL: `/v1`. Machine-readable schema: `docs/openapi.yaml`.

Auth: `Authorization: Bearer <accessToken>` on all endpoints except `/v1/auth/*`.
Errors: `{ "error": { "code": string, "message": string } }` with appropriate HTTP status.

## Auth

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/v1/auth/register` | `{ email, password }` | `AuthTokens` |
| POST | `/v1/auth/login` | `{ email, password }` | `AuthTokens` |
| POST | `/v1/auth/refresh` | `{ refreshToken }` | `AuthTokens` (rotated) |
| POST | `/v1/auth/logout` | `{ refreshToken }` | 204 |

`AuthTokens = { accessToken, refreshToken, expiresIn }`

## Profile & Credentials

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/v1/me` | — | `{ id, email, tradingDisabled, webullConfigured }` |
| PUT | `/v1/me/webull-credentials` | `{ appKey, appSecret, accountId }` | `{ webullConfigured: true }` |
| DELETE | `/v1/me/webull-credentials` | — | 204 |

Credentials are never returned in any response.

## Market Data

| Method | Path | Query | Returns |
|---|---|---|---|
| GET | `/v1/market/quote` | `symbol` | `Quote` |
| GET | `/v1/market/candles` | `symbol, interval (1m/5m/15m/1h/1d), from, to` | `Candle[]` |
| GET | `/v1/market/options-chain` | `symbol, expiration?` | `OptionsChain` |
| GET | `/v1/market/futures` | `root` | `FuturesContract[]` |

## Trading

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/v1/orders/preview` | `OrderRequest` | `OrderPreview` |
| POST | `/v1/orders` | `OrderRequest` + `Idempotency-Key` header | `OrderResult` |
| GET | `/v1/orders` | — | `OrderResult[]` (open) |
| DELETE | `/v1/orders/{orderId}` | — | 204 |
| GET | `/v1/positions` | — | `Position[]` |

### OrderRequest

```json
{
  "underlying": "SPY",
  "assetClass": "option" | "future",
  "side": "buy" | "sell",
  "quantity": 1,
  "orderType": "mid" | "market",
  "selection": {
    "mode": "auto_otm" | "explicit",
    "optionType": "call" | "put",        // required for auto_otm + explicit option
    "expiration": "2026-07-17",          // optional; defaults to nearest
    "strike": 503,                       // explicit option only
    "contractSymbol": "MESU26"           // explicit future only
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

## Core Schemas

```yaml
Quote:        { symbol, bid, ask, last, bidSize, askSize, volume, timestamp }
Candle:       { time, open, high, low, close, volume }
OptionContract: { symbol, underlying, expiration, strike, optionType, bid, ask, last }
OptionsChain: { underlying, underlyingPrice, expirations: string[], contracts: OptionContract[] }
FuturesContract: { symbol, root, expiration, frontMonth: bool, bid, ask, last }
Position:     { symbol, assetClass, quantity, avgPrice, markPrice, unrealizedPnl }
OrderPreview: { resolved: { contractSymbol, price, estBuyingPower }, warnings: string[] }
OrderResult:  { orderId, status, contractSymbol, side, quantity, orderType, limitPrice?, filledPrice?, timestamp }
```
