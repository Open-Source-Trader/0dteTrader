# Screen i15: Indicator settings sheet
- **App:** iOS
- **Location:** `apps/ios/0dteTrader/Features/Chart/IndicatorSettingsView.swift` (whole file, 69 lines); presented from `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:85-87`; model at `apps/ios/0dteTrader/Features/Chart/IndicatorSettings.swift:4-44`
- **Visual:** UNVERIFIED-VISUAL — no macOS/Xcode to render the iOS sheet; desktop-clone reference `docs/ui-audit/shots/07-indicator-settings.png` (860×1864 = 430×932 @2x) audited as a pixel proxy. Note: the clone renders this as a **full-page view** (no drag indicator, no detent), which is itself a parity divergence from the iOS `.sheet` presentation at `TradeScreenView.swift:85`.
- **Scores:** Composition 7/10 · Typography 6/10 · Color 6/10 · Density 7/10 · DataViz 6/10 · Motion 4/10 · States 7/10 · Platform 7/10 · A11y 5/10 · Consistency 5/10 → **Overall 60/100**
- **Score justifications:**
  - Composition 7: stock `Form` gives system-true 44pt+ rows, leading margins and safe-area handling for free; but the sheet is full-height for ~370pt of content — the clone shows ~175pt (19% of 932pt) of dead black below the last card, space a `.medium` detent would reclaim while keeping the chart visible.
  - Typography 6: section headers and rows use default dynamic-type styles (good, scales with Dynamic Type); but every numeric value ("Period: 9", "Width: 2.0σ") is proportional SF, ignoring `AppTypography`'s monospaced rule and jittering on 9→10 steps.
  - Color 6: text contrast passes (primary label ~#FFFFFF on #1C1C1E ≈ 15:1; section-header gray ≈ 5.9:1); on-toggle green ≈ 9:1 — but the green is the *system default*, bypassing the documented `appAccent`-for-toggles token (`AppColors.swift:52`) and colliding with buy/profit green semantics.
  - Density 7: two clean grouped sections, 9 toggles + up to 8 steppers, no clutter; MACD crams its params into the label while Stochastic gets 3 rows — uneven depth.
  - DataViz 6: no viz required on this screen and none forced in; misses the TradingView-grade win of color-keyed swatches matching the chart's `overlayColors` (`ChartView.swift:23-26`).
  - Motion 4: conditional parameter rows insert/remove with zero animation; no haptics; only the stock toggle/stepper control animations exist.
  - States 7: instant-apply + persistence via `SettingsStore` is the correct model for a settings sheet — no loading/empty states needed; deductions for no reset-to-defaults and silent persistence failure.
  - Platform 7: `NavigationStack` + inline title + `Done` + `.sheet` are correct idioms; missing detents, drag indicator, haptics — the three things that make iOS sheets feel native.
  - A11y 5: toggles inherit correct labels/traits and Form gives Dynamic Type + ≥44pt rows; but six steppers all announce as "Period" / "Width" with no `accessibilityLabel`/`accessibilityValue`, making VoiceOver navigation ambiguous.
  - Consistency 5: token bypasses (toggle tint, Form background/cells vs `appBackground`/`appSurface`), inline magic ranges (2...200, 5...100, 0.5...4.0), `Format.price` reused for a unitless multiplier, existing `Haptics` helper unused.

## Findings

### [P1] — Sheet has no detents or drag indicator; full-screen modal hides the live chart
- **What/Why:** `.sheet(isPresented:)` at `TradeScreenView.swift:85` presents with the default single large detent, so the sheet covers ~92% of the viewport and the user cannot see the chart react while flipping toggles — killing the single most delightful interaction this screen could have (Robinhood/TradingView instant preview). With ~370pt of content vs 932pt viewport, ~19% is dead space (measured on the reference shot: second card ends ≈757pt of 932pt). Violates Composition + Platform Fidelity. The desktop clone reference shows the same full-page takeover.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:85-87`
- **Exact fix:**
```swift
.sheet(isPresented: $showIndicatorSettings) {
    IndicatorSettingsView(settings: $chartViewModel.indicatorSettings)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
}
```

### [P1] — Toggles use default system green, bypassing the `appAccent` token and colliding with Buy green
- **What/Why:** `Toggle` has no `.tint`, so SwiftUI renders system green (#30D158 dark). `AppColors.swift:52` documents `appAccent` as the token for "links, toggles, selected states", and `TradePanelView.swift:69` already applies `.tint(.appAccent)` to its toggle — so this screen is both off-token and internally inconsistent. Worse, in a trading app green = buy/profit (`buyGreen`, `pnlPositive`); a green "on" toggle smuggles P&L semantics into a neutral settings control. Visible in the reference shot: EMA/VWAP/Volume toggles are green while "Done" is accent blue. Violates Color&Contrast (semantic misuse) + Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Chart/IndicatorSettingsView.swift:11` (apply once to the whole `Form`)
- **Exact fix:** add after the `Form { ... }` closing brace (line 59), before `.navigationTitle`:
```swift
            .tint(.appAccent)
```

### [P1] — Conditional parameter rows pop in with zero animation
- **What/Why:** `if settings.smaEnabled { Stepper(...) }` (lines 14-16, 19-21, 28-36, 41-43, 48-52, 55-57) inserts/removes rows on a plain binding write with no `.animation`, so rows snap in instantly — a jarring, un-Apple discontinuity in the middle of a `Form`. The bar is a 120–250ms eased row insertion (system `List` row animation). Violates Motion&Micro-interactions.
- **Location:** `apps/ios/0dteTrader/Features/Chart/IndicatorSettingsView.swift:59`
- **Exact fix:** add alongside the `.tint` modifier (IndicatorSettings is `Equatable`, so the whole value is a valid animation trigger):
```swift
            .animation(.snappy(duration: 0.25), value: settings)
```

### [P1] — VoiceOver: six steppers announce as indistinguishable "Period" / "Width" rows
- **What/Why:** Stepper labels are "Period: \(…)" for SMA, EMA, Bollinger, RSI and ATR (lines 15, 20, 29, 42, 56) and "%K Period" / "%D Period" for Stochastic (lines 49, 51). A VoiceOver user swiping the form hears "Period: 9, adjustable" five times with no owning-indicator context, and the toggle is a separate rotor stop — the association between a toggle and its steppers is lost. Violates Accessibility (labels/focus order).
- **Location:** `apps/ios/0dteTrader/Features/Chart/IndicatorSettingsView.swift:15,20,29,30-35,42,49-51,56`
- **Exact fix:** apply to every `Stepper`, e.g.:
```swift
Stepper("Period: \(settings.smaPeriod)", value: $settings.smaPeriod, in: 2...200)
    .accessibilityLabel("SMA period")
    .accessibilityValue("\(settings.smaPeriod)")
```
```swift
Stepper("Width: \(Format.price(settings.bollingerMultiplier, fractionDigits: 1))σ", ...)
    .accessibilityLabel("Bollinger Bands width")
    .accessibilityValue("\(Format.price(settings.bollingerMultiplier, fractionDigits: 1)) sigma")
```
(Repeat per indicator: "EMA period", "RSI period", "Stochastic %K period", "Stochastic %K smoothing", "Stochastic %D period", "ATR period".)

### [P2] — Form ignores the app's surface tokens; iOS will render off-palette vs the desktop clone
- **What/Why:** A plain `Form` in dark mode renders `systemGroupedBackground` (pure black) with `secondarySystemGroupedBackground` cells (#1C1C1E). The app tokens are `appBackground` = rgb(0.043, 0.047, 0.063) ≈ #0B0C10 and `appSurface` = rgb(0.102, 0.110, 0.141) ≈ #1A1C24 (`AppColors.swift:8-23`) — noticeably bluer than the neutral #1C1C1E. The desktop reference shot renders cards at #1A1C24 (i.e. the token), so the iOS sheet will visibly mismatch both the surrounding iOS screens (`ChartView.swift:110` uses `.background(Color.appBackground)`) and the desktop clone. Violates Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Chart/IndicatorSettingsView.swift:11-59`
- **Exact fix:**
```swift
Form {
    Section("Price Overlays") { /* ... */ }
        .listRowBackground(Color.appSurface)
    Section("Sub-Panes") { /* ... */ }
        .listRowBackground(Color.appSurface)
}
.tint(.appAccent)
.scrollContentBackground(.hidden)
.background(Color.appBackground)
```

### [P2] — All parameter ranges/steps are inline magic numbers; 2...200 stepper has no fast path
- **What/Why:** `in: 2...200` (line 15), `2...200` (20), `5...100` (29), `0.5...4.0, step: 0.5` (33-34), `2...50` (42), `5...50` / `1...10` / `1...10` (49-51), `2...50` (56) are literal constants embedded in the view, divorced from the model that owns them (`IndicatorSettings.swift`). Functionally, reaching SMA 200 from the default 20 is 180 stepper taps (hold-to-repeat helps, but TradingView offers preset values + direct numeric entry — that's the bar). Violates Consistency (magic numbers) + Motion (friction).
- **Location:** `apps/ios/0dteTrader/Features/Chart/IndicatorSettingsView.swift:15,20,29,31-34,42,49-51,56`
- **Exact fix:** move ranges onto the model and use them in the view:
```swift
// IndicatorSettings.swift
extension IndicatorSettings {
    static let maPeriodRange = 2...200
    static let bollingerPeriodRange = 5...100
    static let bollingerMultiplierRange = 0.5...4.0
    static let oscillatorPeriodRange = 2...50
    static let stochKPeriodRange = 5...50
    static let stochSmoothRange = 1...10
}
// IndicatorSettingsView.swift:15
Stepper("Period: \(settings.smaPeriod)", value: $settings.smaPeriod, in: IndicatorSettings.maPeriodRange)
```

### [P2] — Stepper values use proportional digits; labels jitter when stepping 9 → 10 → 100
- **What/Why:** "Period: \(settings.smaPeriod)" interpolates a proportional-width numeral into the row label; as the value changes digit count the label width changes and text visibly reflows. The design system exists precisely to prevent this: `AppTypography.swift:3-4` documents monospaced digits "so ticking quotes don't shift layout". Violates Typography + Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Chart/IndicatorSettingsView.swift:15,20,29,31,42,49-51,56`
- **Exact fix:** add `.monospacedDigit()` to each `Stepper`:
```swift
Stepper("Period: \(settings.smaPeriod)", value: $settings.smaPeriod, in: IndicatorSettings.maPeriodRange)
    .monospacedDigit()
```

### [P2] — No haptic feedback despite an existing `Haptics` helper
- **What/Why:** `DesignSystem/Haptics.swift:9-11` provides `Haptics.selection()`, and the README advertises haptics as part of the design system, yet toggling nine indicators and stepping eight parameters is completely silent. Apple/Robinhood-grade sheets give a light selection tick on every control change. Violates Platform Fidelity + Motion.
- **Location:** `apps/ios/0dteTrader/Features/Chart/IndicatorSettingsView.swift:59`
- **Exact fix:** (iOS 17 API, matches deployment target — replaces the need to touch each control)
```swift
            .sensoryFeedback(.selection, trigger: settings)
```

### [P2] — MACD parameters are hardcoded into the label and not editable, unlike every peer
- **What/Why:** `Toggle("MACD (12, 26, 9)", ...)` (line 45) is the only parameterized indicator with no steppers — Stochastic gets three (lines 49-51), Bollinger two (29-35). The parenthetical is also a magic string that silently lies if the engine defaults ever change, and it makes the row the longest label in the section (visible in the reference shot: it wraps closest to the toggle). Violates Consistency + Density.
- **Location:** `apps/ios/0dteTrader/Features/Chart/IndicatorSettingsView.swift:45`
- **Exact fix:** shorten the label and disclose the fixed parameters as section footer text:
```swift
Toggle("MACD", isOn: $settings.macdEnabled)
// ...
Section("Sub-Panes") {
    // toggles...
} footer: {
    Text("MACD uses standard 12 / 26 / 9 parameters.")
}
```

### [P3] — No "Reset to defaults" escape hatch
- **What/Why:** `IndicatorSettings.default` exists (`IndicatorSettings.swift:24-43`) but the UI offers no way back after experimentation. TradingView's indicator dialog has "Defaults" for exactly this. Violates State Coverage (no recovery path).
- **Location:** `apps/ios/0dteTrader/Features/Chart/IndicatorSettingsView.swift:62-66`
- **Exact fix:**
```swift
.toolbar {
    ToolbarItem(placement: .topBarLeading) {
        Button("Reset") { settings = .default }
            .disabled(settings == .default)
    }
    ToolbarItem(placement: .topBarTrailing) {
        Button("Done") { dismiss() }
    }
}
```

### [P3] — No color swatches keying each toggle to its chart line color
- **What/Why:** The chart already assigns fixed colors per overlay — sma = systemOrange, ema = systemCyan, vwap = systemPurple (`ChartView.swift:23-26`) — but the settings rows are plain text, so the user must memorize which toggle drives which line. An 8pt color dot next to each label is the TradingView "holy shit" touch and costs five lines. Violates DataViz (legend discipline) at nit level.
- **Location:** `apps/ios/0dteTrader/Features/Chart/IndicatorSettingsView.swift:13,18,23` (swatches); `ChartView.swift:23-26` (color source of truth to lift)
- **Exact fix:**
```swift
Toggle(isOn: $settings.smaEnabled) {
    HStack(spacing: 8) {
        Circle().fill(Color(uiColor: .systemOrange)).frame(width: 8, height: 8)
        Text("SMA")
    }
}
```
For a durable fix, lift `ChartView.overlayColors` into a shared `IndicatorStyle` enum in `DesignSystem/` and have both `ChartView.swift:23` and this view read from it, instead of duplicating literals.

### [P3] — `Format.price` misused to format a unitless Bollinger multiplier
- **What/Why:** `"Width: \(Format.price(settings.bollingerMultiplier, fractionDigits: 1))σ"` (line 31) calls a formatter documented as "Shared display formatting for prices, strikes and P&L" (`Formatters.swift:3`) for a sigma multiplier. It produces the right digits today only because `price()` is a bare `String(format:)`; the moment someone localizes currency into `Format.price`, this label breaks. Violates Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Chart/IndicatorSettingsView.swift:31`; `apps/ios/0dteTrader/DesignSystem/Formatters.swift:5`
- **Exact fix:** add to `Format` and use it:
```swift
/// Unitless ratios/multipliers, e.g. Bollinger width `2.0`.
static func multiplier(_ value: Double, fractionDigits: Int = 1) -> String {
    String(format: "%.\(fractionDigits)f", value)
}
// line 31:
"Width: \(Format.multiplier(settings.bollingerMultiplier))σ"
```

### [P3] — Off-state toggle track ≈ 1.6:1 against the cell; persistence failures are silent
- **What/Why:** (a) In the reference shot the off-toggle track (#39393D family) on the #1A1C24 card measures ≈ 1.6:1, under WCAG 1.4.11's 3:1 for component boundaries — the white knob (~10:1) rescues identifiability, but a `.medium`-detent sheet on `appBackground` will darken the surround and worsen this. (b) `SettingsStore` decode falls back to defaults on corruption (`SettingsStore.swift:50-53`) with no user signal — acceptable, but a one-line footer ("Settings are saved automatically") would close the reassurance gap. Both are nits against Color&Contrast / State Coverage.
- **Location:** `apps/ios/0dteTrader/Features/Chart/IndicatorSettingsView.swift:11-59`; `apps/ios/0dteTrader/Core/Storage/SettingsStore.swift:50-53`
- **Exact fix:** (a) no code change needed on iOS — system toggles are Apple's component; verify after applying the `appSurface` row background from the P2 token fix that off-track vs #1A1C24 stays ≥ the current 1.6:1 (it does: #39393D vs #1A1C24 ≈ 1.9:1). (b) Add to the "Sub-Panes" section:
```swift
} footer: {
    Text("MACD uses standard 12 / 26 / 9 parameters. Settings save automatically.")
}
```

## Quick wins vs structural work

**Landable in <1 hour (all in `IndicatorSettingsView.swift` + one line in `TradeScreenView.swift`):**
- `.presentationDetents([.medium, .large])` + `.presentationDragIndicator(.visible)` (P1)
- `.tint(.appAccent)` on the Form (P1)
- `.animation(.snappy(duration: 0.25), value: settings)` (P1)
- `.sensoryFeedback(.selection, trigger: settings)` (P2)
- `.monospacedDigit()` on all steppers (P2)
- `.scrollContentBackground(.hidden)` + `.background(Color.appBackground)` + `.listRowBackground(Color.appSurface)` per section (P2)
- `accessibilityLabel`/`accessibilityValue` on all steppers (P1)
- "Reset" toolbar button (P3)
- MACD label → footer text (P2)

**Structural (refactor required):**
- Lift `ChartView.overlayColors` into a shared `DesignSystem/IndicatorStyle` so swatches and chart lines share one source of truth (P3)
- Move parameter ranges/steps onto `IndicatorSettings` constants; replace long-range steppers with preset menus or direct numeric entry (P2)
- Editable MACD fast/slow/signal periods — requires model + `IndicatorEngine` + persistence-migration changes (P2)
- Project-wide spacing/radius/motion token system — this screen mostly escapes it because `Form` self-layouts, but the missing detent/animation values (`0.25`, `snappy`) are exactly what motion tokens should own
