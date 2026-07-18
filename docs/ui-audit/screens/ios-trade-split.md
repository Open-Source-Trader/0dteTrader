# Screen i6: Trade screen — Layout B (split) + draggable divider
- **App:** iOS
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift` — split branch `:174-197`, divider `:221-250`; tokens `apps/ios/0dteTrader/DesignSystem/AppColors.swift`, `AppTypography.swift`; persistence `apps/ios/0dteTrader/Core/Storage/SettingsStore.swift:41-48`; panel `apps/ios/0dteTrader/Features/Trade/TradePanelView.swift`
- **Visual:** screenshot `docs/ui-audit/shots/05-trade-split.png` (desktop 430×932 clone; iOS layout UNVERIFIED-VISUAL — no macOS/Xcode, desktop clone used as pixel reference; geometry cross-checked by math)
- **Scores:** Composition 6/10 · Typography 7/10 · Color 6/10 · Density 7/10 · DataViz 6/10 · Motion 5/10 · States 5/10 · Platform 5/10 · A11y 4/10 · Consistency 5/10 → **Overall 56/100**
- **Score justifications:**
  - Composition 6 — default split 0.34 is close to golden 0.382 and the screenshot confirms ~62/38 chart/panel rhythm, but the grabber band is 18pt with a 48×5pt pill (6.5pt vertical padding — off the 4pt grid) and panel min clamp (120pt) is divorced from actual panel content height (~380pt).
  - Typography 7 — this chrome introduces almost no text; toolbar is SF Symbols only, and prices inside the panel inherit the monospaced `priceMedium` tokens. No Dynamic Type hazards at this level, but nothing here earns higher.
  - Color 6 — divider pill uses `appBorder` = `UIColor.separator` on `appSurface` (#1A1C24 dark): measured roughly 1.3:1, well under the 3:1 UI-component minimum; everything else (background/surface) uses tokens correctly.
  - Density 7 — chart keeps ~60% of viewport, panel packs 6 control rows into ~34% without clipping at default fraction; matches TradingView-style density. Loses points because density collapses at fraction 0.25 (content overflow, see P1-1).
  - DataViz 6 — out of scope for the split chrome itself (chart is screen i5), but the screenshot shows the split layout leaves the chart's error state ("No Webull credentials…") as dead centered text with no recovery action in the visible layout.
  - Motion 5 — toast gets a correct 0.2s easeInOut (`:76`); layout toggle is an instant hard cut with no transition, divider drag has no spring/snap, no press state, and no reduced-motion accommodation.
  - States 5 — toast overlay is designed; the split layout itself has no treatment for panel overflow at small fractions, no loading skeleton hand-off, and the only visible error state is non-actionable gray text.
  - Platform 5 — safe areas and SF Symbols are right, and `Haptics.selection()` fires on layout toggle, but the divider's hit target is 18pt tall vs the 44pt HIG minimum, and drag end has no haptic.
  - A11y 4 — divider has `accessibilityLabel("Resize trade panel")` (`:249`) but no `accessibilityValue` and no `accessibilityAdjustableAction`, so VoiceOver users literally cannot resize the panel; fullscreen layout's floating buttons are also unreachable equivalents.
  - Consistency 5 — every dimension is an inline magic number (18, 48, 5, 2.5, 120, 100, 0.25/0.5, 4, 10, 12); the project has zero spacing/radius/motion tokens, so this screen is a case study in the systemic gap.

## Findings

### [P0] — Divider hit target is 18pt tall, less than half the 44pt HIG minimum
- **What/Why:** Platform Fidelity / Accessibility. The only draggable resize affordance on the primary trading screen is a `contentShape(Rectangle())` over a `dividerHeight = 18` band (`:223`). HIG requires ≥44×44pt for any touch target. On a screen where users resize to expose Buy/Sell under time pressure, a 18pt target is a functional failure, not polish.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:223,230,232`
- **Exact fix:** Keep the visual at 18pt but expand the hit area to 44pt without shifting layout:
  ```swift
  private let dividerHeight: CGFloat = 18

  private func divider(totalHeight: CGFloat) -> some View {
      RoundedRectangle(cornerRadius: 2.5)
          .fill(Color.appSurfaceElevated)
          .frame(width: 48, height: 5)
          .frame(maxWidth: .infinity)
          .frame(height: dividerHeight)
          .background(Color.appSurface)
          .contentShape(Rectangle().inset(by: -13)) // 18 + 2×13 = 44pt vertical target
          .gesture( /* unchanged DragGesture */ )
  ```
  Verify the 13pt overflow doesn't swallow chart crosshair touches; if it does, use `-8` (34pt) and add `.padding(.vertical, 4)` above/below inside a 26pt band as a compromise.

### [P1] — Panel min height (120pt / fraction 0.25) is far below TradePanelView's content height → content overflows over the divider
- **What/Why:** Composition / State Coverage. `TradePanelView` is a fixed `VStack` with **no `ScrollView`** (verified: `TradePanelView.swift:14-305` — six rows: asset-class picker, Call/Put+AUTO, expiration, qty, Mid/Market, Buy/Sell, ≈ 360–420pt tall). The split branch clamps `panelHeight = max(totalHeight * splitFraction, 120)` (`:178`) and the drag clamp allows `splitFraction` down to `0.25` (`:242`) → ~213pt panel on an 852pt viewport. `.frame(height:)` doesn't clip in SwiftUI, so at fractions below ~0.45 the Buy/Sell buttons draw *outside* the frame, overlapping the divider and chart — a broken state the user can drag into and persist.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:178,192,242`; `apps/ios/0dteTrader/Features/Trade/TradePanelView.swift:14`
- **Exact fix:** Make the panel scroll instead of overflowing, and clip the frame:
  ```swift
  // TradeScreenView.swift:183-192
  TradePanelView(/* unchanged args */)
      .frame(height: panelHeight)
      .clipped()
  ```
  ```swift
  // TradePanelView.swift — wrap the root VStack
  ScrollView(.vertical, showsIndicators: false) {
      VStack(spacing: 8) { /* existing rows */ }
          .padding(.horizontal, 12)
          .padding(.top, 4)
  }
  ```
  Additionally raise the floor so the default experience never starts clipped: change the drag clamp at `:242` to `min(0.5, max(0.32, start + delta))` and the getter floor in `SettingsStore.swift:45` to `max(0.32, stored)`.

### [P1] — VoiceOver users cannot resize the panel: no adjustable trait, no value
- **What/Why:** Accessibility. The divider exposes only `.accessibilityLabel("Resize trade panel")` (`:249`). Without `accessibilityAdjustableAction` the rotor swipe does nothing, so the entire Layout B resize feature — including reaching Buy/Sell buttons clipped by a small panel — is unavailable to VoiceOver users. Zero `accessibilityAdjustableAction` exists anywhere in `apps/ios` (grep-verified).
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:249`
- **Exact fix:**
  ```swift
  .accessibilityLabel("Resize trade panel")
  .accessibilityValue("\(Int((splitFraction * 100).rounded())) percent of screen")
  .accessibilityAdjustableAction { direction in
      let step = 0.05
      switch direction {
      case .increment: splitFraction = min(0.5, splitFraction + step)
      case .decrement: splitFraction = max(0.25, splitFraction - step)
      @unknown default: break
      }
      settingsStore.splitFraction = splitFraction
      Haptics.selection()
  }
  ```

### [P1] — Layout toggle is an instant hard cut; divider drag has no spring, press state, or end haptic
- **What/Why:** Motion & Micro-interactions. `toggleLayout()` (`:276-280`) flips `layout` with no `withAnimation` — the entire screen re-composes in one frame (chart jumps from fullscreen to ~60%). Robinhood-grade motion would crossfade/slide. The divider gives no visual feedback while touched (grabber doesn't darken/scale), no snap easing on release, and no haptic at drag end — while `toggleLayout` does fire `Haptics.selection()`, proving the pattern exists and was forgotten here.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:233-248,276-280`
- **Exact fix:**
  ```swift
  private func toggleLayout() {
      Haptics.selection()
      withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
          layout = layout == .fullscreen ? .split : .fullscreen
      }
      settingsStore.layoutMode = layout
  }
  ```
  In the divider gesture's `.onEnded`, add `Haptics.selection()` before persisting, and add a pressed state:
  ```swift
  @GestureState private var isDraggingDivider = false
  // on the pill:
  .fill(isDraggingDivider ? Color.appAccent : Color.appSurfaceElevated)
  .scaleEffect(isDraggingDivider ? 1.15 : 1)
  .animation(.easeInOut(duration: 0.15), value: isDraggingDivider)
  // in the gesture: .updating($isDraggingDivider) { _, state, _ in state = true }
  ```

### [P2] — Grabber contrast ~1.3:1 on its surface; separator color is not a UI-control color
- **What/Why:** Color & Contrast. The pill is filled with `Color.appBorder` = `UIColor.separator` (`:227`, `AppColors.swift:61`) over `appSurface` dark (#1A1C24). Separator is designed for hairlines, not interactive controls; measured contrast is roughly 1.3:1 vs the 3:1 WCAG non-text minimum — and this is the only visible cue that the panel is draggable. In the desktop screenshot the pill is barely discernible against the panel background.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:227`; `apps/ios/0dteTrader/DesignSystem/AppColors.swift:61`
- **Exact fix:** Use the elevated surface token (dark #282B35 ≈ 2.4:1 on #1A1C24) plus a stroke, or fall back to a semantic gray:
  ```swift
  RoundedRectangle(cornerRadius: 2.5)
      .fill(Color(uiColor: .tertiaryLabel)) // ≈3.4:1 on appSurface dark
      .frame(width: 48, height: 5)
  ```

### [P2] — Every dimension is an inline magic number; no spacing/radius/motion tokens exist
- **What/Why:** Consistency. This screen alone hardcodes `18` (`:223`), `48`/`5`/`2.5` (`:226-228`), `120`/100 (`:178,181`), `0.25`/`0.5` (`:242`), toast `padding(.top, 4)` (`:71`), fullscreen `spacing: 10` + `padding(.bottom, 12)` (`:165,171`). The DesignSystem folder has colors and fonts only — no `AppSpacing`/`AppRadius`/`AppMotion`, so the same values will (and do) drift across screens. The 18pt band with a 5pt pill yields 6.5pt internal padding — off the 4pt grid.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:71,165,171,178,181,223-228,242`
- **Exact fix:** Add `apps/ios/0dteTrader/DesignSystem/AppLayout.swift`:
  ```swift
  import CoreGraphics
  enum AppSpacing { static let xs: CGFloat = 4; static let sm: CGFloat = 8; static let md: CGFloat = 12; static let lg: CGFloat = 16 }
  enum AppRadius { static let grabber: CGFloat = 2.5 }
  enum AppMotion { static let quick = 0.2; static let layout = 0.35 }
  ```
  then replace literals: `dividerHeight` → `AppSpacing.lg + 2` (or restructure to a 20pt band: 20 = 5pt pill + 7.5pt… no — use pill 4pt, band 20pt: `(20-4)/2 = 8pt` padding, fully on-grid: `.frame(width: 48, height: 4)` and `dividerHeight = 20`), `padding(.top, 4)` → `AppSpacing.xs`, `spacing: 10` → `AppSpacing.md - 2` → just `AppSpacing.sm` (8) or `md` (12) — pick 8 to keep the floating buttons tight, `0.2` → `AppMotion.quick`.

### [P2] — Chart min-height clamp (100pt) + panel min (120pt) + divider (18pt) can exceed total height
- **What/Why:** Composition robustness. `chartView.frame(height: max(totalHeight - panelHeight - dividerHeight, 100))` (`:181`) plus `panelHeight = max(..., 120)` means for any `totalHeight < 238` the VStack's children sum to more than `totalHeight` and the stack overflows its own frame. iPhone-only portrait makes this rare (task-switcher compact sizes, Stage-Manager-style windows on iPad if ever enabled), but the clamps are mutually inconsistent.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:178-194`
- **Exact fix:** Derive both from one budget:
  ```swift
  let panelHeight = min(max((totalHeight * splitFraction).rounded(), 120), totalHeight - 118) // chart ≥100 + divider 18
  ```

### [P3] — Default split 0.34 vs golden-ratio 0.382; grabber 48×5pt vs standard 36×5 grabber proportions
- **What/Why:** Composition nit at the "holy shit" bar. Default `splitFraction = 0.34` (`SettingsStore.swift:44`) puts chart/panel at 0.66/0.34; the golden split is 0.618/0.382 → default `0.38` gives the chart its ideal share while adding ~34pt of breathing room to the panel (which also mitigates P1-1). The 48×5pt pill is wider than the iOS-standard sheet grabber (36×5), reading slightly heavy at 48pt against a 430pt-wide screen.
- **Location:** `apps/ios/0dteTrader/Core/Storage/SettingsStore.swift:44`; `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:228`
- **Exact fix:** `guard stored > 0 else { return 0.38 }` and `.frame(width: 36, height: 5)`.

## Quick wins vs structural work
**<1 hour:**
- Expand divider hit area via `contentShape` inset (P0) — 3 lines.
- Add `accessibilityValue` + `accessibilityAdjustableAction` (P1-3) — ~12 lines.
- Grabber color → `.tertiaryLabel`, width 48→36 (P2-contrast, P3) — 2 lines.
- `withAnimation(.spring(response: 0.35, dampingFraction: 0.85))` in `toggleLayout` + end-drag haptic + pressed-state pill (P1-motion) — ~15 lines.
- Default fraction 0.34→0.38 (P3) — 1 line.
- Reconcile chart/panel min clamps (P2-overflow) — 1 line.

**Structural:**
- Wrap `TradePanelView` in a `ScrollView` and re-floor the drag range so Buy/Sell can never be dragged out of reach (P1-1) — touches panel layout and requires re-testing qty steppers/expiry sheet inside a scroll container.
- Introduce `AppLayout.swift` spacing/radius/motion tokens and sweep all screens (P2-consistency) — design-system decision, then a repo-wide migration.
- Designed, actionable chart error state visible in split mode (button deep-linking to Profile credentials) — cross-screen work with ChartView/ProfileView.
