# Follow-up: show only the active trading environment in Profile

> **Status:** Noted, not started. Raised during the SnapTrade Personal-mode
> migration (Phase 4, desktop UI) but applies to Webull and Alpaca too — out
> of scope for that migration, tracked here for later.

## The observation

`ProfileView` (desktop) and the iOS `ProfileViewModel` equivalent currently
render **both** the Live and Practice credential/connection cards for
whichever provider is active, permanently, side by side. Only one of the two
(`Me.tradingMode`) is ever the environment actually used for trading at a
given time — the other card is inert UI that still takes up a full section
of the profile sheet.

This was flagged as a scalability question ("shouldn't render live AND
practice signals at the same time — that's doubling calls for no benefit").
**Checked and clarified:** today this does not literally double network
calls — `ProfileStore.load()` is a single `apiClient.me()` request that
populates both cards' `configured` flags at once, and SnapTrade connection
data (`loadSnapTradeConnections`) only fetches on explicit user actions
(connect/reconnect/select/disconnect), not on a render or a timer. So the
current cost is UI clutter and unnecessary section real estate, not literal
duplicated polling — but it's still worth fixing, and would matter more if
any future per-environment data ever did become live/polled.

## The proposed direction

Show only the card for `Me.tradingMode` (the environment currently in use
for trading), with an explicit switch/toggle to view or edit the other
environment's credentials — rather than both permanently visible. This
would apply uniformly to:

- Webull credentials section (`renderCredentialsSection` / `WebullCredentialsSection`)
- Alpaca credentials section (`renderAlpacaSection` / `AlpacaSection`)
- SnapTrade key + connection sections (`SnapTradeKeySection`,
  `SnapTradeConnectionSection`) — added during the Personal-mode migration

## Why it wasn't done as part of the SnapTrade migration

The SnapTrade Personal-mode migration's job was adding a `clientId`/
`consumerKey` entry step ahead of the existing Connection Portal flow. The
live/practice side-by-side display is pre-existing app-wide UX that
predates that work and affects two other providers — reworking it belongs
in its own change, not bundled into an unrelated migration's diff.

## Notes for whoever picks this up

- `environment` is passed as a direct prop today (not context) precisely
  because both environments render simultaneously — there's no single
  ambient "current environment" value to provide. If this redesign lands
  (only one environment ever rendered at a time per screen), an
  `EnvironmentContext` scoped to the visible card would then make sense,
  since at that point there actually is one ambient value per render.
- `ProfileStoreContext` (`apps/desktop/src/features/profile/ProfileStoreContext.tsx`)
  already exists and is the model to extend if adding a scoped
  `EnvironmentContext` later.
- iOS (`ProfileViewModel.swift`) has the same live/practice side-by-side
  pattern and would need the same treatment, per CLAUDE.md's "update iOS
  and Electron as a pair" rule.
