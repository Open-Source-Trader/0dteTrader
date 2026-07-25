# 0dteTrader iOS

SwiftUI iPhone app for rapid 0DTE options trading against the
0dteTrader backend (see `../../docs/PRD.md`, `../../docs/API-SPEC.md`).

- iOS 17+, SwiftUI, Swift Concurrency (`async/await`, `@MainActor` view models)
- Candlestick charts: [DanielGindi/Charts](https://github.com/danielgindi/Charts) (SwiftPM, pinned to major version 5)
- Project generated with [XcodeGen](https://github.com/yonsm/XcodeGen) — **do not edit the `.xcodeproj` directly**; edit `project.yml` and regenerate

## Prerequisites

- macOS with Xcode 15+
- XcodeGen: `brew install xcodegen`
- The backend — production on Railway (`https://caring-prosperity-production.up.railway.app`), or locally via `npm run dev` (`http://localhost:3000`)
- SwiftLint: `brew install swiftlint` (lint runs automatically during Xcode builds and in CI)

## Generate, run, test

```bash
cd apps/ios
xcodegen                 # generates 0dteTrader.xcodeproj from project.yml
open 0dteTrader.xcodeproj
```

Run on the iOS 17 simulator (Cmd+R). First launch shows the risk disclaimer,
then register an account (e.g. `dev@example.com` / `password123`).

Run the unit tests:

```bash
xcodebuild test -scheme 0dteTrader -destination "platform=iOS Simulator,id=$(xcrun simctl list devices available -j | python3 -c 'import json,sys;print(next(d["udid"] for v in json.load(sys.stdin)["devices"].values() for d in v))')"
```

(or Cmd+U in Xcode.)

Tests need a real simulator, so the destination is resolved from whatever is
installed rather than hard-coded. A pinned name like `name=iPhone 16` is
matched against `OS:latest` and fails when that model exists only on an older
runtime — `xcrun simctl list devices available` shows what you actually have.

## Linting

SwiftLint runs automatically as a pre-build script in Xcode and in CI. To run it manually:

```bash
cd apps/ios
swiftlint lint
```

Configuration is in `.swiftlint.yml`. The rules are intentionally pragmatic for the current codebase (e.g., structural rules like `function_body_length` and `cyclomatic_complexity` are disabled to avoid noise in complex indicator math and SwiftUI views). You can tighten them as the code is refactored.

## Configuration

Environment configuration is split across two files:

- **`Configurations/*.xcconfig`** — per-build-configuration settings (Debug / Staging / Release). Each xcconfig sets the Swift compilation flags (`DEBUG`, `STAGING`) and ATS local-networking permission.
- **`0dteTrader/App/AppEnvironment.swift`** — typed `AppEnvironment` enum that maps each build configuration to its endpoints, stream URL, and pinning hashes.
- **`0dteTrader/App/AppConfig.swift`** — thin wrapper that exposes `AppEnvironment.current` values as `static let` constants. The public API is unchanged.

### Build configurations

| Configuration | Swift flag | Default base URL                                      | ATS local networking |
| ------------- | ---------- | ----------------------------------------------------- | -------------------- |
| **Debug**     | `DEBUG`    | `http://localhost:3000`                               | Allowed              |
| **Staging**   | `STAGING`  | `https://caring-prosperity-staging.up.railway.app`    | Disabled             |
| **Release**   | _(none)_   | `https://caring-prosperity-production.up.railway.app` | Disabled             |

### API base URL source

`API_BASE_URL` is generated at build time by `scripts/generate-env.sh`. The script reads the top-level `.env` first, then falls back to the build environment, then defaults to `http://localhost:3000`. Change the URI in `.env` to point the app at a different backend.

### Certificate pinning

`pinnedPublicKeyHashes` — SPKI SHA-256 hashes (base64) for TLS public-key
pinning (`Core/Networking/CertificatePinning.swift`). Empty disables pinning,
which is the right setting for local HTTP development; populate the staging
and production entries in `AppEnvironment.swift` when the backend is deployed
behind TLS (docs/SECURITY.md §5).

## Layout

Follows docs/ARCHITECTURE.md §4:

```
0dteTrader/
  Configurations/       Debug, Staging, Release xcconfig files (base, per-env settings)
  App/                  ZeroDTETraderApp (@main), AppEnvironment, AppConfig, AppContainer (DI), RootView (coordinator)
  Core/
    Networking/         APIClient (typed REST, JWT attach, refresh-and-retry once on 401),
                        QuoteSocketClient (WS, subscribe/unsubscribe, exponential-backoff reconnect),
                        SessionStore (token lifecycle), CertificatePinning
    Storage/            KeychainStore (refresh token), SettingsStore (UserDefaults)
    Models/             DTOs (exact openapi.yaml shapes), domain models, date parsing
  DesignSystem/         dark-first palette (light mode supported), typography, Buy/Sell buttons, haptics
  Features/
    Auth/               LoginView, RegisterView, AuthViewModel, RiskDisclaimerView
    Profile/            ProfileView, WebullCredentialsForm (write-only), AppLockManager (FaceID)
    Chart/              ChartView, ChartViewModel, CandleChartRepresentable, IndicatorPaneRepresentable,
                        IndicatorEngine (pure functions), IndicatorSettingsView, SymbolSearchView,
                        Twc/ (TWC Heatmap V5 indicator), OptionsAnalytics/ (Options Structure snapshot overlay)
    Trade/              TradeScreenView (Layout A/B + drag divider), TradePanelView, OrderConfirmSheet,
                        PositionsStripView, TradeViewModel, OptionsChainViewModel, AutoContractSelector,
                        PriceMath, FloatingTradeButtons, ToastView
0dteTraderTests/        IndicatorEngine, AutoContractSelector, mid-price, DTO decoding, Options Structure contract/presentation tests
```

## Notes & assumptions

- **Module name**: targets are named `0dteTrader` (so the scheme is
  `0dteTrader`), but Swift module names cannot start with a digit — the
  generated module is `ZeroDTETrader` via `PRODUCT_MODULE_NAME`, and tests use
  `@testable import ZeroDTETrader`.
- **Charts version**: pinned to `majorVersion: 5.1.0` (v5 renamed the module
  to `DGCharts`; v4 does not compile on current toolchains).
- **Options only**: the app trades options exclusively — no futures UI or code
  (the backend is likewise options-only).
- **Symbol search** is a curated watchlist + free text because the API has no
  search endpoint (FR-9 is satisfied client-side).
- **Order flow**: Buy/Sell arms a ticket (idempotency key = UUID generated at
  arm time) → confirmation sheet shows the server preview
  (`POST /v1/orders/preview`) → Confirm submits (`POST /v1/orders` with
  `Idempotency-Key`). Retries and double taps reuse the same key.
- **Option flatten** resolves the position symbol against the currently loaded
  chain (the API's explicit-option selection needs strike/expiration/type,
  which a bare `Position` doesn't carry). If the chain for that underlying
  isn't loaded, the app asks you to open that chart first.
- **VWAP** is computed over the loaded candle range; the app loads ~400 bars of
  the current interval ending now, so on intraday intervals this is the
  standard session VWAP.
