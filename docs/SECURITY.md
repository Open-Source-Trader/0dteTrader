# SECURITY — 0dteTrader

## 1. Threat Model

| Asset                   | Threat                            | Mitigation                                                                                              |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Webull app key/secret   | Extracted from app bundle         | Never shipped to the app; stored server-side only                                                       |
| Webull creds at rest    | DB breach                         | AES-256-GCM per-field encryption; data key from env/KMS, never in repo or DB                            |
| Webull creds in transit | MITM                              | TLS 1.2+ everywhere; cert pinning app→backend                                                           |
| Passwords               | DB breach                         | Argon2id hashing                                                                                        |
| JWTs                    | Theft/replay                      | 15-min access tokens; rotating refresh tokens (reuse revokes the chain); refresh stored in iOS Keychain |
| Orders                  | Fat-finger, replay, double submit | Arm-then-confirm UI; idempotency keys; server-side re-validation; rate limits                           |
| Account                 | Rogue trading after compromise    | Per-user kill switch (`trading_disabled`), honored by every order path; full audit log                  |

## 2. Credential Encryption

- Algorithm: AES-256-GCM, 12-byte random IV per write, auth tag stored alongside ciphertext.
- Key: 32-byte data key from `CRED_ENCRYPTION_KEY` (base64). Production: load from a KMS/secret
  manager; rotate by decrypt-with-old/re-encrypt-with-new migration.
- Decryption happens only in memory, only when a request needs to call Webull, and plaintext is
  never logged (logger redaction list includes `appKey`, `appSecret`, `accountId`).

## 3. AuthN/Z

- Passwords: Argon2id (memory 64 MiB, time 3, parallelism 4).
- Access JWT: 15 min, signed with `JWT_ACCESS_SECRET`, contains `sub` (user id) only.
- Refresh JWT: 14 days, hashed (SHA-256) before DB storage; rotation on every use; detecting a
  presented token whose DB row is already revoked revokes the whole family.
- Every `/v1/*` route except `/auth/*` requires a valid access token. All trading routes load the
  user and check `tradingDisabled` before touching the broker gateway.

## 4. Order Safety Controls

1. **Idempotency** — `Idempotency-Key` header required on `POST /v1/orders`. Key + user unique in
   `OrderAudit`; a replay returns the original result without re-submitting.
2. **Server-side re-validation** — auto-OTM strike and mid price are recomputed server-side from
   live data at submission; client values are advisory only.
3. **Rate limiting** — stricter limits on `/v1/orders*` (e.g. 10/min per user) than read routes.
4. **Kill switch** — `trading_disabled` returns `403 TRADING_DISABLED` and is audit-logged.
5. **Audit log** — every preview/place/cancel attempt records user, request, response, status,
   timestamp. Never contains credentials.

## 5. iOS

- TLS with certificate/public-key pinning to the backend domain.
- Access token in memory; refresh token in Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
- Optional FaceID gate on app foreground (LocalAuthentication).
- ATS defaults (no arbitrary loads). No third-party analytics SDKs.

## 6. Compliance Notes (for later, not v1)

- Personal/TestFlight use: no special distribution requirements beyond a normal Apple Developer
  account. Do not distribute trading functionality to others' live brokerage accounts casually —
  that moves you toward introducing-broker territory.
- Public App Store: Apple requires apps offering trading to be submitted by the financial
  institution or to demonstrate proper licensing/agreements (App Review Guideline 3.2.1(viii) /
  financial reporting). Webull's own OpenAPI terms may restrict redistribution — review their
  developer agreement before any public release.
- This app never gives investment advice and must display a risk disclaimer on first launch.

## 7. Operational

- Secrets only via environment; `.env` is gitignored; `.env.example` documents names only.
- DB backups exclude nothing but are themselves sensitive (encrypted creds + hashed tokens) —
  treat backup media as secret.
- Logs: structured (pino), no auth headers, no credential fields, order logs carry ids not secrets.
