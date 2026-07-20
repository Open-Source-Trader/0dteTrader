# Screen i7: Trade panel (chain/futures selector, qty, price, Buy/Sell)

- **App:** iOS
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradePanelView.swift` (whole file; key refs :14, :200, :283, :294) · `Features/Trade/TradeViewModel.swift:34` · `Features/Trade/OptionsChainViewModel.swift:10` · `Features/Trade/PositionsStripView.swift` · `Features/Trade/TradeScreenView.swift:174-196` (host, fixed-height frame) · `DesignSystem/TradeButtons.swift` (TradeActionButton/QuickChipButton) · `DesignSystem/AppColors.swift`, `AppTypography.swift`, `Formatters.swift`
- **Visual:** UNVERIFIED-VISUAL — no macOS/Xcode to render iOS SwiftUI; layout reconstructed from code (frames/paddings/stack spacing) and cross-checked against the desktop-clone reference pixels in `docs/ui-audit/shots/05-trade-split.png` and `11-buy-disabled.png` (430×932pt phone frame @2x; panel top edge at y≈1236px/2 ≈ 618pt → panel ≈ 314pt ≈ 34% of 932pt; row pitch ≈ 42pt; horizontal inset ≈ 12pt — all match the code).
- **Scores:** Composition 6/10 · Typography 5/10 · Color 6/10 · Density 7/10 · DataViz 5/10 · Motion 3/10 · States 4/10 · Platform 6/10 · A11y 4/10 · Consistency 6/10 → **Overall 55/100**
- **Score justifications:**
  - Composition 6 — clean column rhythm (8pt gaps, symmetric SELL/BUY), but 12pt side margins (not 16/20 HIG), content vertically centered in a fixed frame so buttons float mid-panel at large fractions, and the split default ~66/34 misses the golden-ratio ~62/38.
  - Typography 5 — `.priceMedium` monospaced used for qty/strike, but every live quote (bid×ask line, both `≈ mid` readouts) uses proportional `.caption`; `.chipLabel` renders dates/strikes in rounded proportional 12pt.
  - Color 6 — semantic tokens used throughout and P&L carries `+`/`-` signs (not color-only), but white headline on `buyGreen` measures ≈2.6:1 (fails even WCAG 3:1 large-text) and the disabled state is 35%-opacity fill only.
  - Density 7 — correct hierarchy: giant arm buttons primary, caption quote context secondary; loses points for omitting estimated notional (qty × mid) — the one number a 0DTE trader wants before arming.
  - DataViz 5 — only data display is the bid×ask/mid quote line; it's proportional-font (jitters on ticks) and has no skeleton/placeholder shimmer while the chain loads.
  - Motion 3 — zero animations in the panel: asset-class and AUTO toggles swap whole rows instantly, buttons have no press state; only the toast (0.2s easeInOut, in TradeScreenView:76) animates.
  - States 4 — AUTO loading spinner, "No contract"/"—" placeholders and error toasts exist, but `chainViewModel.errorMessage` is never rendered, disabled BUY/SELL never explains itself, no skeletons, no offline state.
  - Platform 6 — haptics on arm/chips, SF Symbols, confirm via sheet, draggable divider; but stepper/chip hit targets are 28–34pt (< 44pt HIG) and the divider grab area is 18pt.
  - A11y 4 — some labels present (`accessibilityLabel` on arm buttons, AUTO toggle); −/+ steppers unlabeled, qty not an adjustable value, menu icons not `.accessibilityHidden`, and fixed-height panel + Dynamic Type = guaranteed clipping.
  - Consistency 6 — color/type tokens reused faithfully; spacing (4/8/10/12), radius (8/10/12/capsule) and hit-area numbers are all inline magic values with no token layer.

## Findings

### [P0] — Fixed-height panel with no ScrollView: content is clipped at small split fractions and whenever positions exist

- **What/Why:** The host pins the panel to `panelHeight = totalHeight × splitFraction`, clamped to 0.25–0.5 with a floor of 120pt (`TradeScreenView.swift:178,192`), while the panel body is a plain `VStack` with no scroll container (`TradePanelView.swift:13-51`). Measured content height at default text size: asset picker 32 + options section (32+8+34=74) + qty row 30 + order-type row 32 + arm buttons 52 + 6×8 stack spacing + 4 top padding ≈ **272pt**. At the PRD-allowed minimum fraction 0.25 on an 844pt device (usable ≈ 750pt after nav bar) the panel is ≈ 187pt — **~85pt of the ticket, including the BUY/SELL buttons, is clipped**. Add one positions-strip row (+~50pt) and even the default ~0.34 fraction (≈255pt) clips. Violates State Coverage, Platform Fidelity, Composition. With larger Dynamic Type sizes it breaks at every fraction.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:178` (`let panelHeight = max((totalHeight * splitFraction).rounded(), 120)`) and `:192` (`.frame(height: panelHeight)`); `TradePanelView.swift:13-51`
- **Exact fix:** In `TradePanelView.swift`, wrap the root stack in a scroll view and pin actions to the bottom:
  ```swift
  var body: some View {
      ScrollView(.vertical) {
          VStack(spacing: 8) {
              positionsStrip
              // ... existing pickers / sections / quantityRow / orderTypeRow ...
              HStack(spacing: 12) {
                  TradeActionButton(title: "SELL", color: .sellRed, isEnabled: canTrade) { onArm(.sell) }
                  TradeActionButton(title: "BUY", color: .buyGreen, isEnabled: canTrade) { onArm(.buy) }
              }
          }
          .padding(.horizontal, 12)
          .padding(.top, 4)
          .padding(.bottom, 8)
          .frame(maxWidth: .infinity)
      }
      .scrollIndicators(.hidden)
      .scrollBounceBehavior(.basedOnSize)
      .background(Color.appBackground)
      .task { /* unchanged */ }
  }
  ```
  And in `TradeScreenView.swift:242` raise the drag clamp floor so the ticket can never be dragged below its content: `splitFraction = min(0.5, max(0.32, start + delta))` (0.32 × 750pt ≈ 240pt, still scrollable rather than clipped), and drop the meaningless 120pt floor on `:178` to `max((totalHeight * splitFraction).rounded(), 200)`.

### [P1] — White BUY/SELL label on `buyGreen` fails contrast: ≈2.6:1, needs ≥3:1 (large text) / 4.5:1

- **What/Why:** `TradeActionButton` renders white `.headline` on `.buyGreen` dark variant `rgb(0.098, 0.722, 0.357)` (`AppColors.swift:38`). Relative luminance of the fill ≈ 0.353 → contrast vs white = 1.05 / 0.403 ≈ **2.6:1** — fails WCAG AA even at the 3:1 large-text threshold. The SELL red (`rgb(0.882,0.227,0.263)`) measures ≈4.3:1 (passes 3:1, fails 4.5:1). On the two most important controls in the app, the verb must be unmissable. Violates Color&Contrast. (Reference pixels in `11-buy-disabled.png` confirm the washed-out look in the disabled 0.35-opacity state.)
- **Location:** `apps/ios/0dteTrader/DesignSystem/AppColors.swift:35-41`, consumed at `DesignSystem/TradeButtons.swift:16-20`
- **Exact fix:** Darken the dark-mode `buyGreen` to luminance ≈ 0.17 (contrast ≈ 4.7:1 with white):
  ```swift
  static let buyGreen = Color(
      uiColor: UIColor { traits in
          traits.userInterfaceStyle == .dark
              ? UIColor(red: 0.060, green: 0.520, blue: 0.260, alpha: 1) // ≈ #0F8542, 4.7:1 vs white
              : UIColor(red: 0.078, green: 0.612, blue: 0.302, alpha: 1)
      }
  )
  ```
  and `sellRed` dark to `UIColor(red: 0.780, green: 0.180, blue: 0.220, alpha: 1)` (≈4.6:1). Verify both in a contrast checker after applying.

### [P1] — Hit targets below the 44pt HIG minimum across the ticket's most-tapped controls

- **What/Why:** Quantity steppers are `30×30pt` circles (`TradePanelView.swift:210,224`); `QuickChipButton` is ~28pt tall (8pt vertical padding around 12pt caption — `TradeButtons.swift:43-46`); menu chips are ~34pt tall (8pt padding + caption — `TradePanelView.swift:303-304`); the divider grab area is 18pt (`TradeScreenView.swift:223`). All under the 44×44pt minimum; on a speed-critical 0DTE ticket this is a mis-tap generator. Violates Platform Fidelity / Accessibility.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradePanelView.swift:206-228`, `:294-308`; `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:40-47`; `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:223-230`
- **Exact fix:**
  - Steppers (`TradePanelView.swift:210`, `:224`): `.frame(width: 44, height: 44)` and keep the visual circle at 32pt via `.background(Circle().fill(Color.appSurfaceElevated).frame(width: 32, height: 32))` inside the 44pt frame, plus `.contentShape(Rectangle())`.
  - `QuickChipButton` (`TradeButtons.swift:43-44`): `.padding(.horizontal, 14).padding(.vertical, 12).frame(minHeight: 44)`.
  - `chipLabel` (`TradePanelView.swift:303-304`): `.padding(.horizontal, 12).padding(.vertical, 11).frame(minHeight: 44, maxWidth: .infinity)`.
  - Divider (`TradeScreenView.swift:223`): `private let dividerHeight: CGFloat = 44`, keep the visible 5pt pill unchanged.

### [P1] — Chain-load errors are written to `errorMessage` and never displayed; BUY/SELL just silently disable

- **What/Why:** `OptionsChainViewModel.load`/`ensureContracts` set `errorMessage` (`OptionsChainViewModel.swift:112-118, 189-195`) but nothing in `TradePanelView` (or anywhere) reads it — Grep confirms zero consumers. On failure the user sees placeholder chips ("Expiration", "Strike" / "No contract") and dead, 35%-opacity BUY/SELL buttons with no cause and no retry path. Same hole for futures: `loadFuturesContracts` failure leaves an empty contract menu (`TradeViewModel.swift:99-103`). Violates State Coverage (actionable errors) and Color (disabled state unexplained).
- **Location:** `apps/ios/0dteTrader/Features/Trade/OptionsChainViewModel.swift:10,112-118`; `apps/ios/0dteTrader/Features/Trade/TradePanelView.swift:55-83,283-290`
- **Exact fix:** Add an inline error row at the top of `optionsSection` (and mirror for futures using a new `@Published private(set) var futuresError: String?` set in `loadFuturesContracts`'s catch):
  ```swift
  if let message = chainViewModel.errorMessage {
      HStack(spacing: 6) {
          Image(systemName: "exclamationmark.triangle.fill")
              .foregroundStyle(Color.pnlNegative)
          Text(message)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(2)
          Spacer()
          Button("Retry") { Task { await chainViewModel.load(underlying: underlying) } }
              .font(.chipLabel)
              .foregroundStyle(Color.appAccent)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .background(Color.appSurface)
      .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
  }
  ```

### [P1] — No press states on any custom control: everything is `.buttonStyle(.plain)`

- **What/Why:** `TradeActionButton` (`TradeButtons.swift:24`), `QuickChipButton` (`TradeButtons.swift:49`), steppers (`TradePanelView.swift:214,228`), position chips (`PositionsStripView.swift:96`) — all `.plain`, so touch-down produces zero visual change. Haptics fire, but on a trading ticket the finger needs instantaneous visual confirmation; Robinhood/iOS-system buttons all darken/scale on press. Violates Motion&Micro-interactions.
- **Location:** `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:24,49`; `apps/ios/0dteTrader/Features/Trade/TradePanelView.swift:214,228`
- **Exact fix:** Add one shared style in `TradeButtons.swift` and apply it in place of every `.plain`:
  ```swift
  struct PressableButtonStyle: ButtonStyle {
      func makeBody(configuration: Configuration) -> some View {
          configuration.label
              .opacity(configuration.isPressed ? 0.65 : 1)
              .scaleEffect(configuration.isPressed ? 0.97 : 1)
              .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
      }
  }
  ```
  `.buttonStyle(PressableButtonStyle())`. (0.12s ease-out is inside the 120–250ms bar; `.plain`-equivalent semantics otherwise.)

### [P2] — Asset-class and AUTO switches swap rows abruptly; options (2 rows) vs futures (1 row) changes panel height with no animation

- **What/Why:** `optionsSection` is two rows (Call/Put+AUTO, expiration+strike) while `futuresSection` is one (`TradePanelView.swift:23-27,55-83,154-196`). Switching the segmented picker adds/removes ~42pt inside the fixed-height frame instantly — the whole ticket jumps. Toggling AUTO likewise swaps `strikeMenu` ↔ `autoContractLabel` (`:76-80`) with no transition. Violates Motion&Micro-interactions and Composition.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradePanelView.swift:23-27,64-71,76-80`
- **Exact fix:** Add at the root of the panel VStack:
  ```swift
  .animation(.snappy(duration: 0.22, extraBounce: 0), value: tradeViewModel.assetClass)
  .animation(.snappy(duration: 0.22, extraBounce: 0), value: chainViewModel.isAutoMode)
  ```
  and give `futuresSection` a second fixed-height row (move the `≈ mid` readout out of the chip row into its own 34pt row matching `autoContractLabel`'s `minHeight: 34`) so both asset classes occupy identical heights and nothing reflows. Honor Reduce Motion by gating with `@Environment(\.accessibilityReduceMotion) var reduceMotion` and passing `reduceMotion ? nil : .snappy(...)`.

### [P2] — All live prices render in proportional `.caption`; ticking quotes jitter the layout

- **What/Why:** The design system already defines monospaced-digit `.priceSmall` (`AppTypography.swift:8`) and documents why ("ticking quotes don't shift layout"), yet the three live-price readouts ignore it: bid×ask quote line (`TradePanelView.swift:247-249`), AUTO contract mid (`:137-139`), futures mid (`:191-193`). Proportional digits make the text width change on every tick — exactly what `.priceSmall` exists to prevent. Violates Typography (tabular figures for ALL prices) and DataViz.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradePanelView.swift:137-139,191-193,247-249`
- **Exact fix:** Replace `.font(.caption)` with `.font(.priceSmall)` at all three sites; keep `.foregroundStyle(.secondary)`. If the price line is too wide next to the Mid/Market picker, add `.lineLimit(1).minimumScaleFactor(0.8).layoutPriority(1)` to the quote `Text`.

### [P2] — Panel content floats vertically centered in the fixed frame; dead space above and below at larger fractions

- **What/Why:** `.frame(height: panelHeight)` centers the (shorter) VStack, so at 0.5 fraction (~375pt vs ~272pt content) there are ~50pt voids above the positions strip and below BUY/SELL, and the arm buttons — the primary action — drift away from the thumb zone at the bottom edge. Reference pixels (`05-trade-split.png`) already show the buttons ending ~35pt above the home indicator with uneven margins. Violates Composition&Proportion.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:192`; `apps/ios/0dteTrader/Features/Trade/TradePanelView.swift:40-43`
- **Exact fix:** After the BUY/SELL `HStack` (`TradePanelView.swift:39`) add `Spacer(minLength: 0)` _before_ it (i.e., between `orderTypeRow` and the buttons) so the ticket top-aligns and the arm buttons pin to the bottom edge, and add `.padding(.bottom, 8)` after `.padding(.top, 4)` (`:42`).

### [P2] — Estimated notional (qty × mid) missing from the ticket

- **What/Why:** The panel shows unit bid×ask and mid but never the number the trader actually risks: quantity × mid. For a 10-lot MES order that's the difference between ~$50 and ~$500 of premium — the user must do mental math at 0DTE speed. Violates Information Density (primary decision data absent).
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradePanelView.swift:254-262` (`quoteLine`)
- **Exact fix:** Extend `quoteLine`:
  ```swift
  private var quoteLine: String? {
      guard let pair = selectedQuotePair else { return nil }
      var line = "\(Format.price(pair.bid)) × \(Format.price(pair.ask))"
      if let mid = indicativeMid {
          line += " · ≈ \(Format.price(mid)) · Est. \(Format.price(mid * Double(tradeViewModel.quantity)))"
      }
      return line
  }
  ```
  (Uses only existing values; keeps the mid shown for market orders too since it's already computed.)

### [P2] — VoiceOver gaps: unlabeled steppers, non-adjustable quantity, decorative menu icons read aloud

- **What/Why:** The −/+ steppers are icon-only `Image(systemName:)` buttons with no label (`TradePanelView.swift:206-228`); VoiceOver falls back to "minus"/"plus" with no context of what they change, and the quantity value is a plain `Text` that isn't exposed as an adjustable value. `chipLabel`'s SF Symbols (`:296`) are decorative but will be announced. Violates Accessibility (labels, focus order, adjustable values).
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradePanelView.swift:200-235,294-301`
- **Exact fix:**
  ```swift
  // minus button (:214)  → .accessibilityLabel("Decrease quantity")
  // plus  button (:228)  → .accessibilityLabel("Increase quantity")
  // quantity text (:216) → .accessibilityLabel("Quantity").accessibilityValue("\(tradeViewModel.quantity)")
  // chipLabel image (:296) → .accessibilityHidden(true)
  ```
  Better: make the whole qty group one adjustable element with `.accessibilityAdjustableAction { $0 == .increment ? tradeViewModel.addQuantity(1) : tradeViewModel.addQuantity(-1) }`.

### [P2] — Magic numbers everywhere; no spacing/radius/hit-area tokens

- **What/Why:** The brief confirms no spacing/radius/motion tokens exist; this screen alone hardcodes spacing 8/10/12 (`TradePanelView.swift:14,56,57,73,155,201,239`), padding 4/8/10/12/14 (`:41-42,147,303-304`; `TradeButtons.swift:43-44`), radii 8/10/12 + capsule (`:149,307`; `TradeButtons.swift:21,46`; `PositionsStripView.swift:90,122`), frames 30/34/36/44/52 (`:146,210,218`; `TradeButtons.swift:19`). A one-off radius or spacing change requires touching five files. Violates Consistency.
- **Location:** see refs above
- **Exact fix:** Add `apps/ios/0dteTrader/DesignSystem/AppMetrics.swift`:
  ```swift
  import CoreFoundation
  enum AppMetrics {
      static let spaceXS: CGFloat = 4, spaceS: CGFloat = 8, spaceM: CGFloat = 12, spaceL: CGFloat = 16
      static let radiusS: CGFloat = 8, radiusM: CGFloat = 10, radiusL: CGFloat = 12
      static let hitTarget: CGFloat = 44
      static let actionButtonHeight: CGFloat = 52
  }
  ```
  and mechanically substitute: `spacing: 8` → `spacing: AppMetrics.spaceS`, `cornerRadius: 8` → `AppMetrics.radiusS`, etc.

### [P3] — −/+ steppers lack the haptic that the adjacent +1/+5/+10 chips have

- **What/Why:** `QuickChipButton` fires `Haptics.selection()` (`TradeButtons.swift:37`) but the steppers right next to them call `tradeViewModel.addQuantity` bare (`TradePanelView.swift:206-228`). Same gesture class, different feedback — read as a bug, not a choice. Violates Consistency / Motion.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradePanelView.swift:206-228`
- **Exact fix:** Add `Haptics.selection()` as the first line of both stepper button closures, mirroring `TradeButtons.swift:36-38`.

### [P3] — Futures row squeezes three flexible items into one line; symbol chips will truncate

- **What/Why:** `futuresSection` puts two `maxWidth: .infinity` chips plus a mid readout in one `HStack` (`TradePanelView.swift:155-195`) inside 366pt of usable width. With a symbol like `MESU26` and the `≈ 6,742.50` readout, `lineLimit(1)` in `chipLabel` (`:300`) truncates the contract symbol to `MES…` — the one string that must never truncate. Violates Information Density / Typography.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradePanelView.swift:155-195,300`
- **Exact fix:** Drop `.frame(maxWidth: .infinity)` from the two chips in the futures row (keep it in the options row) so they size to content, give the mid `Text` `.layoutPriority(-1).lineLimit(1).minimumScaleFactor(0.85)`, and add `.fixedSize()` to the chip `Text`. Combined with the P2 height-normalization fix, move the mid readout to its own row where truncation is impossible.

### [P3] — Menu chips render dates and strikes in rounded proportional 12pt; placeholder/value states are indistinguishable

- **What/Why:** `chipLabel` uses `.chipLabel` (rounded caption semibold — `AppTypography.swift:10`) for both the placeholder ("Expiration") and the value ("2026-07-18 · 0DTE"), identical color and weight. Digits in a rounded proportional font neither align nor read as data; and a filled ticket parameter should be visually louder than an empty one. Violates Typography and Information Density.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradePanelView.swift:294-301`, call sites `:100-103,122-125,163,184-187`
- **Exact fix:** In `chipLabel`, split the font by content type:
  ```swift
  Text(title)
      .font(.system(.caption, design: .monospaced).weight(.semibold))
      .foregroundStyle(isPlaceholder ? .secondary : .primary)
      .lineLimit(1)
  ```
  Add a `var isPlaceholder: Bool = false` parameter and pass `true` at the three `?? "Expiration"` / `?? "Strike"` / `?? "Contract"` fallbacks.

## Quick wins vs structural work

**Quick wins (<1 hour each):**

- P1 contrast: two hex changes in `AppColors.swift` (finding 2).
- P1 press states: one `PressableButtonStyle` + four call-site swaps (finding 5).
- P2 monospaced quotes: three `.font(.priceSmall)` swaps (finding 7).
- P2 VoiceOver labels / `accessibilityHidden` on icons (finding 10).
- P3 stepper haptics: two lines (finding 12).
- P3 placeholder/value styling in `chipLabel` (finding 14).
- P2 estimated notional in `quoteLine` (finding 9).

**Structural work (refactor):**

- P0 scroll container + host frame-floor changes, plus re-testing the drag-divider UX across Dynamic Type sizes (finding 1).
- P1 44pt hit targets — touches visual sizing of steppers/chips/divider, needs visual re-balance of the qty row (finding 3).
- P1 error surfacing — requires adding `futuresError` to `TradeViewModel` and an error-row component reused by both sections (finding 4).
- P2 equal-height options/futures sections + Reduce-Motion-gated animations (finding 6).
- P2 `AppMetrics` token layer + mechanical substitution across 4+ files (finding 11).
