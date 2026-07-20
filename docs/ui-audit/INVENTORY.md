# UI/UX Audit — Inventory Checklist

Audit of every screen in `apps/ios/` and `apps/desktop/` against the Apple × Robinhood × TradingView quality bar.
Derived from navigation code: iOS `apps/ios/0dteTrader/App/RootView.swift` + `Features/Trade/TradeScreenView.swift:77-93`; desktop `apps/desktop/src/RootView.tsx` + `features/trade/TradeScreen.tsx:38-41,271-291`.

## Visual-pass coverage

- **iOS (all screens):** `UNVERIFIED-VISUAL` — this machine is Linux; no Xcode/iOS Simulator. Code-driven layout reconstruction only.
- **Desktop:** real screenshots captured via headless Chrome (430×932 @2x, `docs/ui-audit/shots/`) against the Vite dev server + local API (mock broker). Authenticated screens were reached via a throwaway registered account. Because no Webull credentials were on file, the chart area shows its error state and BUY/SELL stayed disabled — these states are captured as-is (valuable for state-coverage audit), and `OrderConfirmSheet` could not be triggered → `UNVERIFIED-VISUAL`.

| Shot                              | Screen                               | State                                             |
| --------------------------------- | ------------------------------------ | ------------------------------------------------- |
| `shots/01-risk-disclaimer.png`    | Risk disclaimer                      | first-launch                                      |
| `shots/02-login.png`              | Login                                | empty form                                        |
| `shots/03-register.png`           | Register sheet                       | empty form (over login)                           |
| `shots/04-after-register.png`     | Trade screen                         | split layout, chart error state (no broker creds) |
| `shots/05-trade-split.png`        | Trade screen — Layout B (split)      | chart error state, trade panel visible            |
| `shots/06-symbol-search.png`      | Symbol search sheet                  | list populated                                    |
| `shots/07-indicator-settings.png` | Indicator settings sheet             | default settings                                  |
| `shots/08-trade-fullscreen.png`   | Trade screen — Layout A (fullscreen) | floating SELL/BUY, chart error state              |
| `shots/09-profile.png`            | Profile sheet                        | account + Webull API sections                     |
| `shots/10-history.png`            | Trade history sheet                  | empty state                                       |
| `shots/11-buy-disabled.png`       | Trade screen                         | AUTO enabled, BUY disabled (no contract)          |

## iOS screens — `apps/ios/`

- [x] **i1. Session-restore spinner + app-lock overlay** — `0dteTrader/App/RootView.swift` → `screens/ios-root-lock.md`
- [x] **i2. Risk disclaimer** — `Features/Auth/RiskDisclaimerView.swift` → `screens/ios-risk-disclaimer.md`
- [x] **i3. Login** — `Features/Auth/LoginView.swift` → `screens/ios-login.md`
- [x] **i4. Register** — `Features/Auth/RegisterView.swift` → `screens/ios-register.md`
- [x] **i5. Trade screen — Layout A (fullscreen)** — `Features/Trade/TradeScreenView.swift`, `FloatingTradeButtons.swift` → `screens/ios-trade-fullscreen.md`
- [x] **i6. Trade screen — Layout B (split) + divider** — `Features/Trade/TradeScreenView.swift`, `TradePanelView.swift` → `screens/ios-trade-split.md`
- [x] **i7. Trade panel** — `Features/Trade/TradePanelView.swift` → `screens/ios-trade-panel.md`
- [x] **i8. Floating trade buttons** — `Features/Trade/FloatingTradeButtons.swift` → `screens/ios-floating-buttons.md`
- [x] **i9. Positions/orders strip** — `Features/Trade/PositionsStripView.swift` → `screens/ios-positions-strip.md`
- [x] **i10. Order confirm sheet** — `Features/Trade/OrderConfirmSheet.swift` → `screens/ios-order-confirm.md`
- [x] **i11. Trade history** — `Features/Trade/HistoryView.swift` → `screens/ios-history.md`
- [x] **i12. Toast overlay** — `Features/Trade/ToastView.swift` → `screens/ios-toast.md`
- [x] **i13. Chart view + representables** — `Features/Chart/ChartView.swift`, `CandleChartRepresentable.swift`, `IndicatorPaneRepresentable.swift` → `screens/ios-chart.md`
- [x] **i14. Symbol search** — `Features/Chart/SymbolSearchView.swift` → `screens/ios-symbol-search.md`
- [x] **i15. Indicator settings** — `Features/Chart/IndicatorSettingsView.swift` → `screens/ios-indicator-settings.md`
- [x] **i16. Drawing overlay** — `Features/Chart/DrawingOverlayView.swift` → `screens/ios-drawing-overlay.md`
- [x] **i17. Profile + Webull credentials** — `Features/Profile/ProfileView.swift`, `WebullCredentialsForm.swift` → `screens/ios-profile.md`
- [x] **i18. iOS design system** — `DesignSystem/AppColors.swift`, `AppTypography.swift`, `TradeButtons.swift`, `Haptics.swift`, `Formatters.swift` → `screens/ios-design-system.md`

## Desktop screens — `apps/desktop/`

- [x] **d1. Phone shell + status bar + spinner state** — `src/RootView.tsx`, `src/main.tsx`, `design/components/StatusBar.tsx`, `Spinner.tsx` → `screens/desktop-phone-shell.md`
- [x] **d2. Risk disclaimer** — `features/auth/RiskDisclaimerView.tsx` [shot 01] → `screens/desktop-risk-disclaimer.md`
- [x] **d3. Login** — `features/auth/LoginView.tsx` [shot 02] → `screens/desktop-login.md`
- [x] **d4. Register** — `features/auth/RegisterView.tsx` [shot 03] → `screens/desktop-register.md`
- [x] **d5. Trade screen — Layout A (fullscreen)** — `features/trade/TradeScreen.tsx`, `FloatingTradeButtons.tsx` [shot 08] → `screens/desktop-trade-fullscreen.md`
- [x] **d6. Trade screen — Layout B (split) + divider** — `features/trade/TradeScreen.tsx` [shot 05] → `screens/desktop-trade-split.md`
- [x] **d7. Trade panel** — `features/trade/TradePanel.tsx` [shot 05] → `screens/desktop-trade-panel.md`
- [x] **d8. Positions/orders strip** — `features/trade/PositionsStrip.tsx` → `screens/desktop-positions-strip.md`
- [x] **d9. Order confirm sheet** — `features/trade/OrderConfirmSheet.tsx` (UNVERIFIED-VISUAL — needs broker creds) → `screens/desktop-order-confirm.md`
- [x] **d10. Trade history** — `features/trade/HistoryView.tsx` [shot 10] → `screens/desktop-history.md`
- [x] **d11. Toast overlay** — `features/trade/ToastView.tsx` → `screens/desktop-toast.md`
- [x] **d12. Chart view + panes** — `features/chart/ChartView.tsx`, `CandleChart.tsx`, `IndicatorPane.tsx` [shots 05/08 error state] → `screens/desktop-chart.md`
- [x] **d13. Symbol search** — `features/chart/SymbolSearchView.tsx` [shot 06] → `screens/desktop-symbol-search.md`
- [x] **d14. Indicator settings** — `features/chart/IndicatorSettingsView.tsx` [shot 07] → `screens/desktop-indicator-settings.md`
- [x] **d15. Profile + Webull credentials** — `features/profile/ProfileView.tsx`, `WebullCredentialsForm.tsx` [shot 09] → `screens/desktop-profile.md`
- [x] **d16. Drawing layer + toolbar** — `features/chart/DrawingLayer.tsx`, `DrawingToolbar.tsx` → `screens/desktop-drawing.md`
- [x] **d17. Desktop design system** — `design/tokens.css`, `base.css`, `components/components.css`, `icons.tsx`, `design/components/*.tsx` → `screens/desktop-design-system.md`

**Totals:** 18 iOS + 17 desktop = 35 audit units.
