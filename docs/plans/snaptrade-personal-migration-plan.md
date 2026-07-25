# SnapTrade: Commercial → Personal Migration Plan

> **Status:** Planning. Supersedes the auth model in `docs/SNAPTRADE-INTEGRATION.md` §2.3/§6,
> which explicitly chose **Commercial / multi-user** (server mints one SnapTrade `userId` +
> `userSecret` per app user, signed with one server-side `clientId`/`consumerKey`).
>
> **Why:** Commercial makes the operator the SnapTrade customer of record for every connected
> end user — subject to KYC on production keys, a per-connected-user billing agreement, and an
> implied compliance obligation ("your application's own user confirmation and compliance flow
> before submitting orders") that this app doesn't implement. The actual goal is "give each
> person a standalone tool that talks to SnapTrade under their own identity" — each user brings
> their **own** SnapTrade Personal client ID + consumer key, the same way they bring their own
> Alpaca or Webull API keys today. The operator never mints, stores as "ours," or is responsible
> for any user's SnapTrade identity.

## 1. What actually changes (confirmed via SDK source, not docs prose)

Personal and Commercial are not two flags on the same calls — they are **structurally different
request shapes**. Verified by downloading and inspecting `snaptrade-typescript-sdk` from npm
directly (not just docs):

- **v10.0.18 (current pin in `apps/api/package.json`)**: one flat `Snaptrade` client, no
  `AuthMode` typing. Every method requires `userId: string` and `userSecret: string` as plain
  required fields. **There is no compile-time Personal-mode support in this version at all.**
- **v11.0.1 (current npm latest)**: introduces `PersonalApiKeyAuth` / `CommercialApiKeyAuth`
  mode classes and a generic `Snaptrade<TAuth>` client. Each method exposes two parallel
  request types keyed by auth mode:
  ```ts
  type XxxCommercialApiKeyRequest = XxxBase & {
    readonly userId: string;
    readonly userSecret: string;
  };
  type XxxPersonalApiKeyRequest = XxxBase & {
    readonly userId?: never;
    readonly userSecret?: never;
  };
  ```
  Construction:
  ```ts
  const snaptrade = new Snaptrade({
    auth: SnaptradeAuth.personalApiKey({ consumerKey, clientId }),
  });
  ```
- **`authentication.registerSnapTradeUser` has no `personalApiKey` variant at all** in v11 — it's
  Commercial-only, enforced by the type system (calling it on a `Snaptrade<PersonalApiKeyAuth>`
  client is a compile error, not just a docs violation). This matches the Personal-mode rule
  "never call the user registration endpoint" with a stronger, compiler-checked guarantee.
- Every other method used today (`loginSnapTradeUser`, `getOrderImpact`, `placeForceOrder`,
  `placeMlegOrder`, `cancelOrder`, `getAllAccountPositions`, `getUserAccountOrders`, etc.) has
  **both** a Commercial and a Personal variant — same method names, `userId`/`userSecret` simply
  absent from the Personal request shape.
- Confirmed unchanged: `cancelOrder` is the real v10 method name (not `cancelUserAccountOrder`,
  which only appears in v11+ and was a red herring from initial research against the wrong SDK
  version) — the current gateway's call site is already correct for this migration's target SDK
  behavior.

**Required dependency change:** bump `snaptrade-typescript-sdk` from `^10.0.18` to `^11.x`. This
is a major version bump — audit the full changelog for breaking changes beyond the auth surface
before merging (not done as part of this plan's research; flagged as Phase 0 work).

### Architectural consequence: no more shared client

Commercial mode: one `Snaptrade` client constructed once per request (server's `clientId`/
`consumerKey`), `userId`/`userSecret` passed per-call to route to the right end user on that
shared client.

Personal mode: **there is no app-level user identity in SnapTrade's model at all.** A user's own
`(clientId, consumerKey)` pair _is_ their whole identity. This means:

- A new `Snaptrade<PersonalApiKeyAuth>` client must be constructed **per app user**, using that
  user's own stored `(clientId, consumerKey)` — not one shared server client.
- No `userId`/`userSecret` params anywhere in the call chain. Delete them entirely rather than
  passing empty strings.
- Mapping "which of my app's users does this belong to" becomes purely our own database's job
  (`(appUserId) → (clientId, consumerKey)`), same as Alpaca's `apiKey`/`apiSecret` today.

## 2. Open questions to resolve before/during implementation (do not guess)

1. **Webhook identity.** Commercial-mode webhook payloads carry `userId` (the app-managed SnapTrade
   user) alongside `accountId`/`brokerageAuthorizationId`. **It is not documented what a
   Personal-mode webhook payload contains, or whether `userId` is populated/omitted/meaningless
   without an app-managed user.** This is the single biggest unresolved gap. Do not assume
   `event['userId']` still identifies our app user — plan to identify the app user via
   `accountId`/`brokerageAuthorizationId` cross-referenced against a table we maintain
   (`appUserId ↔ known accountIds/authorizationIds`, populated when we first see them via
   `listConnections`/`listAccounts` for that user). **Verify against SnapTrade sandbox with a real
   Personal key before relying on any assumption; ask SnapTrade support directly if sandbox
   behavior is ambiguous.**
2. **Sandbox/practice-mode support for Personal keys.** Not found in any fetched doc page. Verify
   a Personal client ID can be scoped to SnapTrade's sandbox environment the same way Commercial
   keys are today (current code selects `sandboxBaseUrl` vs `prodBaseUrl` by `TradingMode`) —
   confirm this still works per-user, since each user's Personal key may only exist in one
   environment (their own SnapTrade Dashboard account, not ours).
3. **Request signing internals**, if we ever need to hand-roll signing outside the SDK's built-in
   axios interceptor: confirmed same HMAC-SHA256-over-canonical-JSON algorithm for both modes,
   but the header set differs (`PersonalClientId`/`PersonalTimestamp`, no user fields, vs
   `PartnerClientId`/`PartnerTimestamp` + `userId`/`userSecret` for Commercial). We are not
   hand-rolling this — the SDK does it — so this is informational only unless the SDK's signing
   breaks for some reason.
4. **Full v10→v11 changelog audit.** Only the auth/type surface was inspected. Confirm no other
   breaking changes affect the mapper/endpoint code before bumping the dependency.
5. **Rate limits.** Confirmed asymmetry: "Account-level rate limiting is only enforced for
   Personal users... an additional 10 req/min per-account limit" on ~9 endpoints (holdings,
   balances, positions, orders, quotes). Since every app user now hits SnapTrade under their own
   Personal key, this cap applies **per user**, which is more forgiving for us at scale than
   Commercial's shared customer-level bucket — but confirm bucket isolation per key is real (not
   explicitly stated in docs) before relying on it for concurrent-user headroom.

## 3. Code changes, by file

### 3.1 Dependency

- `apps/api/package.json`: `"snaptrade-typescript-sdk": "^10.0.18"` → `"^11.x"` (pin exact
  version after changelog audit, Phase 0).

### 3.2 `packages/shared-types/src/index.ts`

Replace the SnapTrade secret/credential shapes — same fields as Alpaca's pattern, renamed for
SnapTrade's Personal key pair:

```ts
// Before
export interface SnapTradeSecrets {
  provider: 'snaptrade';
  snaptradeUserId: string;
  snaptradeUserSecret: string;
}
export interface SnapTradeCredentialsInput {
  provider: 'snaptrade';
  snaptradeUserId: string;
  snaptradeUserSecret: string;
  environment?: TradingMode;
}

// After
export interface SnapTradeSecrets {
  provider: 'snaptrade';
  clientId: string;
  consumerKey: string;
}
export interface SnapTradeCredentialsInput {
  provider: 'snaptrade';
  clientId: string;
  consumerKey: string;
  environment?: TradingMode;
}
```

`SnapTradeCredentialsInput` is no longer "server-minted; not user-entered" — update the comment
to match Alpaca's ("user-entered, write-only").

`Me` DTO flags (`snaptradeConfigured`, `snaptradeAccountId`, etc.) — keep the shape, they already
mean "has this provider configured for this environment," which still holds.

### 3.3 `apps/api/src/broker/snaptrade/snaptrade-client.ts` — full rewrite of construction + calls

- **Constructor**: stop reading `snaptrade.clientId`/`snaptrade.consumerKey` from `ConfigService`.
  Every method takes the user's `clientId`/`consumerKey` as explicit params (mirrors how
  `AlpacaBrokerGateway` takes per-user `AlpacaSecrets`, not a server-config secret).
- **`sdk(mode, clientId, consumerKey)`**: construct `new Snaptrade({ auth: SnaptradeAuth.personalApiKey({ clientId, consumerKey }), basePath })` per call (or cache per-user-per-mode
  like `AlpacaBrokerGateway.clientFor` already does with a fingerprint-keyed `Map`).
- **Delete `registerUser` entirely.** No Personal variant exists; this method has no purpose in
  the new model.
- **Every remaining method** (`authorize`, `listConnections`, `listConnectionAccounts`,
  `deleteConnection`, `refreshConnection`, `getAllAccountPositions`, `getOpenOrders`,
  `previewEquityOrder`, `previewOptionOrder`, `placeEquityOrder`, `placeOptionOrder`,
  `cancelOrder`, `getAccountQuotes`, `getAccountOptionQuotes`): drop the `userId`/`userSecret`
  parameters, add `clientId`/`consumerKey` (used only to construct/select the per-user SDK
  client, not passed into the call body).

### 3.4 `apps/api/src/broker/snaptrade/snaptrade-connection.service.ts` — simplify significantly

- **Delete `registerUser` and `ensureIdentity`.** There is no identity to mint or ensure — the
  user's stored `(clientId, consumerKey)` (from `CredentialsService`, same path as Alpaca) is the
  full identity.
- Every method (`authorize`, `listConnections`, `listAccounts`, `deleteConnection`, `reconnect`,
  `selectAccount`) changes its lookup from `ensureIdentity(userId, mode)` (which auto-registered)
  to a direct `credentials.getDecrypted(userId, 'snaptrade', mode)` call (the exact pattern
  `AlpacaBrokerGateway.credentialsFor` already uses) — **and must throw a clear "no SnapTrade
  credentials configured" error if none exist**, rather than silently minting one. This is the
  load-bearing behavioral change: connecting a brokerage now requires the user to have entered
  their own SnapTrade key first, same as Alpaca requires an API key before any call.

### 3.5 `apps/api/src/broker/snaptrade/snaptrade-broker.gateway.ts`

- Replace `identityFor(userId)` (currently resolves `{ mode, secrets, accountId }` via the
  server-minted identity) with a `credentialsFor(userId, mode)` that reads the user-entered
  `SnapTradeSecrets` (`clientId`/`consumerKey`) via `CredentialsService`, mirroring
  `AlpacaBrokerGateway.credentialsFor`/`clientFor` exactly.
- Every call site (`getPositions`, `getOpenOrders`, `previewOrder`, `placeOrder`, `cancelOrder`,
  `reauthenticate`) drops `userId`/`userSecret` args to the client, uses the resolved
  `clientId`/`consumerKey` instead.
- `listAccounts`/`selectAccount` stubs (added during the `main` rebase to satisfy the
  `BrokerGateway` interface) stay as-is — SnapTrade account selection still goes through
  `SnapTradeConnectionService`, not this generic seam.

### 3.6 `apps/api/src/broker/snaptrade/snaptrade-webhook.controller.ts`

- **Cannot trust `event['userId']` to resolve our app's user** (see Open Question #1). Replace
  the lookup: extract `accountId`/`brokerageAuthorizationId` from the payload, look up
  `brokerConnection` rows by `connectionId`/`accountIds` instead of by `userId` directly — i.e.
  invert the current `where: { userId, provider: 'snaptrade' }` pattern to
  `where: { provider: 'snaptrade', connectionId }` (connectionId/accountId are globally unique
  per SnapTrade connection regardless of which of our users owns it, so this is a safe lookup
  key once verified against real sandbox payloads).
- Flag this file as the one requiring live sandbox verification before shipping (per Open
  Question #1) — don't merge this file's changes without a manual sandbox test confirming the
  new lookup actually resolves the right app user.

### 3.7 `apps/api/src/credentials/credentials.service.ts`

- **Delete `saveSnapTradeIdentity`/`getSnapTradeIdentity`** (the special-case, "server-minted, not
  via the generic user-entered PUT" path called out in the old plan §5).
- Add a `snaptrade` branch to the existing generic `toSecrets` switch (same shape as the existing
  `alpaca` branch at line 157-159), so SnapTrade credentials flow through the **same** generic
  `PUT /v1/broker-credentials` path Alpaca already uses. No SnapTrade-specific credential storage
  code should remain.

### 3.8 `apps/api/src/credentials/credentials.controller.ts` / `webull-session.controller.ts`

- Remove any SnapTrade-specific credential routes the old plan added (register/authorize
  identity minting) that assumed server-minted identity. `authorize` (Connection-Portal-URL
  generation), `list`, `delete`, `reconnect`, `select` all remain as dedicated
  `/v1/me/broker-connections/snaptrade/*` routes (they're connection-lifecycle actions, not
  credential storage) — only the **credential entry** (`clientId`/`consumerKey`) moves to the
  generic broker-credentials PUT, mirroring exactly how Alpaca's API key entry is generic while
  its connection/session behavior is not.

### 3.9 `apps/api/src/config/configuration.ts`

- Delete the `snaptrade.clientId`/`snaptrade.consumerKey`/`snaptrade.webhookConsumerKey` server
  config entirely — there is no server-side SnapTrade integrator identity anymore under Personal
  mode. Keep only `prodBaseUrl`/`sandboxBaseUrl` (these are SnapTrade's own fixed hosts, not
  secrets).
- **Webhook signature verification changes** as a consequence: the current webhook controller
  verifies `HMAC-SHA256(body, consumerKey)` using a single server-side `consumerKey`, but under
  Personal mode there is no single consumer key — each user's webhook events are signed with
  _their own_ Personal consumer key. This means webhook signature verification must look up the
  right user's `consumerKey` **before** it knows which user the event is for — a chicken-and-egg
  problem given Open Question #1. Likely resolution: verify signature per-candidate using
  `accountId`/`connectionId` to find the owning user's stored `consumerKey` first, then verify.
  **This needs explicit design attention during implementation, not just a mechanical rename** —
  flag as a Phase 2 design task, not a straightforward file edit.

### 3.10 `apps/api/prisma/schema.prisma`

- No schema change needed for `BrokerConnection` (still keyed `(userId, provider)`, still tracks
  `connectionId`/`accountIds`/`selectedAccountId`/`status` — this was always meant to be per-app-user
  bookkeeping, which is still correct under Personal mode).
- `broker_credentials.encSecrets` already stores an arbitrary encrypted JSON blob per
  `(userId, provider, environment)` — no migration needed, just a different JSON shape inside
  (`{ clientId, consumerKey }` instead of `{ snaptradeUserId, snaptradeUserSecret }`).

### 3.11 Desktop UI (`apps/desktop/src/features/profile/`)

Mirror `renderAlpacaSection` (`ProfileView.tsx:214`) exactly, renamed for SnapTrade:

- `ProfileStore.ts`: add `canSaveSnapTradeKey(environment)`, `setSnapTradeKeyField`,
  `setSnapTradeKeyEditing`, `saveSnapTradeKey`, `deleteSnapTradeKey` — same shape as the existing
  `canSaveAlpaca`/`setAlpacaField`/`saveAlpacaCredentials`/`deleteAlpacaCredentials`, operating on
  `clientId`/`consumerKey` fields instead of `apiKey`/`apiSecret`.
- Keep the existing `connections`/`accounts`/`status`/`isConnecting`/`isDisconnecting`/
  `isReconnecting` SnapTrade connection state as-is (Connection Portal flow is unchanged — only
  identity/credential entry changes).
- `ProfileView.tsx`: add a `renderSnapTradeKeySection(environment, configured)` above the
  existing SnapTrade connection section — same layout as `renderAlpacaSection` (masked input
  fields, Save/Edit/Delete buttons, configured/not-configured states) — so the user enters their
  own Personal client ID + consumer key **before** the "Connect brokerage" button becomes usable.
  Gate the Connection Portal button on `configured` the same way trading is gated on
  `activeProviderConfigured` in `TradeScreen.tsx`.

### 3.12 iOS UI (`apps/ios/0dteTrader/Features/Profile/`)

Per CLAUDE.md ("Always update the iOS and Electron app as a pair"): mirror the same change in
`ProfileViewModel.swift`/`ProfileView.swift` — find the existing Alpaca key-entry fields (added
alongside `e0d4979 feat(desktop): Alpaca profile UI...` per git history) and replicate the same
masked-field/save/delete pattern for SnapTrade's `clientId`/`consumerKey`, removing any
SnapTrade-specific "connect" UI that assumed no key entry was needed.

## 4. Compliance/consent gaps carried over from the prior audit

Independent of the Personal/Commercial rearchitecture, the prior audit's UX gap still applies:
**no SnapTrade-specific disclosure or consent screen exists before a user connects a real
brokerage.** Personal mode removes the operator's KYC/billing exposure, but the user is still
authorizing order execution on their own real brokerage account through a third-party aggregator
— a brief in-app disclosure ("You're connecting via SnapTrade; 0dteTrader never sees or stores
your brokerage login") before the first `connectSnapTrade()` call is still worth adding as part
of this work, even though it's no longer a SnapTrade contractual requirement once the operator
isn't the Commercial customer of record.

## 5. Phasing

- **Phase 0 — Dependency + changelog audit.** Bump `snaptrade-typescript-sdk` to `^11.x`, review
  the full changelog for breaking changes beyond auth, update `.spec.ts` mocks accordingly.
- **Phase 1 — Types + config.** `shared-types` SnapTrade shape rename; delete server-side
  `snaptrade.clientId`/`consumerKey`/`webhookConsumerKey` from `configuration.ts`;
  `credentials.service.ts` generic `snaptrade` branch replacing the special-cased identity
  methods.
- **Phase 2 — Client + connection service + gateway rewrite.** `snaptrade-client.ts` per-user
  client construction; delete `registerUser`/`ensureIdentity`; gateway `credentialsFor` mirroring
  Alpaca. Design and implement the webhook signature-verification chicken-and-egg fix (§3.9) —
  this is the one piece of this phase that isn't a mechanical rename.
- **Phase 3 — Webhook identity resolution.** Rewrite `snaptrade-webhook.controller.ts` to resolve
  app users via `accountId`/`connectionId` instead of `userId`. **Do not merge without a live
  sandbox test** confirming Personal-mode webhook payload contents (Open Question #1).
- **Phase 4 — Desktop + iOS UI (as a pair).** Add SnapTrade key-entry section mirroring Alpaca's;
  gate Connection Portal button on configured state; add the brief disclosure line from §4.
- **Phase 5 — Verification.**
  - `npm run test` (API) green, `npm run lint` clean, `npm run build` succeeds.
  - Manual sandbox test: enter a real Personal client ID/consumer key (sandbox-scoped, pending
    Open Question #2), connect a brokerage via Connection Portal, place + cancel a practice
    order, confirm webhook delivery resolves to the correct app user.
  - Confirm Webull/Alpaca users remain 100% unaffected (additive/isolated change, same as the
    original plan's exit criterion).

### Exit criteria

- No code path anywhere calls `sdk.authentication.registerSnapTradeUser` or stores a
  server-side SnapTrade `clientId`/`consumerKey` as "ours."
- Every SnapTrade credential is user-entered, stored via the same generic `broker_credentials`
  path as Alpaca, and the app can state truthfully that it never mints or is responsible for any
  user's SnapTrade identity.
- Webhook user-resolution verified against live sandbox behavior, not assumed.
