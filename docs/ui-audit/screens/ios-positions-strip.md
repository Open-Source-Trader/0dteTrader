# Screen i9: Positions/orders strip

- **App:** iOS
- **Location:** `apps/ios/0dteTrader/Features/Trade/PositionsStripView.swift` (whole file; alerts at lines 38–62, chips at 66–127). Context: embedded at top of `apps/ios/0dteTrader/Features/Trade/TradePanelView.swift:15`. Tokens: `apps/ios/0dteTrader/DesignSystem/AppColors.swift`, `AppTypography.swift`, `Formatters.swift`, `Haptics.swift`.
- **Visual:** UNVERIFIED-VISUAL — no macOS/Xcode available; layout reconstructed mathematically from code (stack spacings, paddings, font metrics) and contrast computed from token hex values.
- **Scores:** Composition 5/10 · Typography 5/10 · Color 5/10 · Density 7/10 · DataViz 4/10 · Motion 4/10 · States 4/10 · Platform 5/10 · A11y 4/10 · Consistency 5/10 → **Overall 48/100**
- **Score justifications:**
  - Composition 5 — 12pt side margins match the panel (`TradePanelView.swift:41`), but 6/7/10pt internal values break the 8pt grid (`PositionsStripView.swift:16,87,88`).
  - Typography 5 — `.chipLabel` token used for titles, but live P&L and avg price use proportional `.caption`/`.caption2` (lines 81,84) while the monospaced `.priceSmall` token exists unused (`AppTypography.swift:8`).
  - Color 5 — P&L text passes AA (systemRed #FF453A on appSurface #1A1C24 ≈ 4.99:1; systemGreen #30D158 ≈ 8.4:1) and `+/-` signs carry meaning, but chip borders are a double-dimmed separator below 3:1 and two competing red/green families coexist (`pnlPositive` vs `buyGreen`).
  - Density 7 — Correct 3-tier hierarchy (symbol semibold 12pt → qty@avg 11pt secondary → P&L semibold 12pt) in ~53pt of height; the strongest aspect of this component.
  - DataViz 4 — No charts in scope, but the numeric discipline fails: ticking P&L in proportional digits reflows chip width every update, no `contentTransition`, no skeleton for the working state.
  - Motion 4 — Haptics on tap are right (`Haptics.selection()`, lines 68,110), but `.buttonStyle(.plain)` gives zero press feedback, P&L color flips green↔red with no animation, no reduced-motion consideration.
  - States 4 — Working state = unlabeled 10pt spinner; empty state = silent collapse to zero height; no error surface at all for flatten/cancel failures; no skeletons.
  - Platform 5 — Idiomatic `.alert` confirmation flows and SF Symbols, but the cancel-order button is an unframed SF Symbol (~20×20pt hit area vs 44pt HIG minimum).
  - A11y 4 — VoiceOver label omits quantity and P&L (line 97); cancel button label is a generic "Cancel order" (line 117); hit area violation; only the `+/-` sign saves color-independence.
  - Consistency 5 — Uses `appSurface`/`appBorder`/`chipLabel` tokens, but every spacing/radius value is a magic number (no spacing tokens exist), and order-side text is uncolored unlike the green/red `TradeActionButton`s it sits above.

## Findings

### [P1] — Cancel-order button hit area ≈20×20pt, below the 44pt HIG minimum

- **What/Why:** `xmark.circle.fill` is rendered at default symbol size (~17–20pt) inside `.buttonStyle(.plain)` with no `.frame` or `.contentShape`. The tappable region is the glyph bounds — roughly 20×20pt against the 44×44pt HIG/WCAG minimum. On a trading app this is the button that cancels a live working order; a missed tap keeps an unwanted order working. Violates Platform Fidelity + Accessibility.
- **Location:** `apps/ios/0dteTrader/Features/Trade/PositionsStripView.swift:112-115`
- **Exact fix:**

```swift
Image(systemName: "xmark.circle.fill")
    .font(.body)
    .foregroundStyle(.secondary)
    .frame(width: 44, height: 44)
    .contentShape(Rectangle())
```

and change the chip's trailing padding at line 119 from `.padding(.horizontal, 10)` to `.padding(.leading, 10).padding(.trailing, 2)` so the 44pt frame doesn't inflate the chip (chip total height becomes ~53pt, matching the position chip).

### [P1] — Live P&L and average price use proportional fonts → chip width jitters on every tick

- **What/Why:** `Position.unrealizedPnl` and `markPrice` are live `var`s (`DomainModels.swift:242-243`). The P&L line uses `.caption` and the qty/avg line uses `.caption2` — both proportional — while the design system's own comment says "Prices use monospaced digits so ticking quotes don't shift layout" (`AppTypography.swift:3`) and ships `.priceSmall` (footnote, monospaced) for exactly this. Every quote tick changes "+1.24" → "+1.19" digit widths and the whole chip row reflows horizontally. Violates Typography + DataViz.
- **Location:** `apps/ios/0dteTrader/Features/Trade/PositionsStripView.swift:80-84`
- **Exact fix:**

```swift
Text("\(Format.signedQuantity(position.quantity)) @ \(Format.price(position.avgPrice))")
    .font(.priceSmall)
    .foregroundStyle(.secondary)
Text(Format.signedPrice(position.unrealizedPnl))
    .font(.priceSmall.weight(.semibold))
    .foregroundStyle(position.unrealizedPnl >= 0 ? Color.pnlPositive : Color.pnlNegative)
    .contentTransition(.numericText())          // iOS 16+ digit-roll on change
    .animation(.easeInOut(duration: 0.2), value: position.unrealizedPnl)
```

### [P1] — VoiceOver label omits quantity and P&L; cancel button doesn't identify its order

- **What/Why:** The position chip's label is "Position ES, tap to flatten" (line 97) — a VoiceOver user hears the symbol but not the quantity, average price, or the current P&L, i.e. cannot make an informed flatten decision. The order chip's cancel button reads "Cancel order" (line 117) with no indication of _which_ order — meaningless once two orders are on screen. Violates Accessibility.
- **Location:** `apps/ios/0dteTrader/Features/Trade/PositionsStripView.swift:97,117`
- **Exact fix:**

```swift
// position chip (replaces line 97):
.accessibilityElement(children: .ignore)
.accessibilityLabel("Position \(position.symbol), quantity \(position.quantity), average price \(Format.price(position.avgPrice)), unrealized P&L \(Format.signedPrice(position.unrealizedPnl)) dollars")
.accessibilityHint("Double-tap to flatten at market")

// cancel button (replaces line 117):
.accessibilityLabel("Cancel \(order.side.displayName) order, \(order.quantity) \(order.contractSymbol)")
```

Also wrap the order chip's text VStack in `.accessibilityElement(children: .combine)` (after line 108) so type/status read as one element.

### [P1] — Zero press feedback on both interactive elements

- **What/Why:** Both chips use `.buttonStyle(.plain)` (lines 96,116) with no custom style — no scale, no opacity, no background darken on touch-down. On the Robinhood polish bar this reads as a dead UI; every tappable surface in a best-in-class app responds within one frame. Violates Motion & Micro-interactions.
- **Location:** `apps/ios/0dteTrader/Features/Trade/PositionsStripView.swift:96,116`
- **Exact fix:** add a shared style and apply it at both sites:

```swift
struct ChipPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(!reduceMotion && configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
// then: .buttonStyle(ChipPressStyle()) at lines 96 and 116
```

### [P2] — Chip border is a double-dimmed separator, effectively invisible (<3:1)

- **What/Why:** `Color.appBorder` is `UIColor.separator` (`AppColors.swift:61`), already a low-alpha system color, and the stroke further multiplies it by `.opacity(0.5)` at `lineWidth: 0.5` (lines 93,125). Against `appSurface` (#1A1C24 on #0B0C10) the resulting hairline is well under the 3:1 non-text contrast guideline — chips lose their boundary and read as floating text. Violates Color & Contrast (3:1 UI-component minimum).
- **Location:** `apps/ios/0dteTrader/Features/Trade/PositionsStripView.swift:91-94,123-126`
- **Exact fix:**

```swift
.overlay(
    RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(Color.appBorder, lineWidth: 1)
)
```

(remove `.opacity(0.5)`, raise lineWidth to 1). If that's still too subtle against `appBackground`, switch the fill to `Color.appSurfaceElevated` and drop the stroke entirely.

### [P2] — No error, offline, or duplicate-action protection states

- **What/Why:** Flatten/cancel failures have no surface in this component — no inline error, no retry affordance; `onFlatten`/`onCancelOrder` results are fire-and-forget from this view's perspective. Worse, a chip whose symbol is in `workingSymbols` (order already in flight) shows a 10pt spinner but **remains fully tappable** (lines 67-69): a second tap queues a duplicate flatten confirmation. The spinner also has no accessibility label. Empty state silently collapses to zero height, which is acceptable for a strip but means "no positions" and "positions not yet loaded" are indistinguishable. Violates State Coverage.
- **Location:** `apps/ios/0dteTrader/Features/Trade/PositionsStripView.swift:67-78,96`
- **Exact fix:**

```swift
// position chip button, after line 69's action closure:
.disabled(workingSymbols.contains(position.symbol))

// on the chip label:
.opacity(workingSymbols.contains(position.symbol) ? 0.6 : 1)

// on the ProgressView (line 76):
ProgressView()
    .controlSize(.mini)
    .accessibilityLabel("Order working")
```

For failures, surface via the existing `ToastView` (already in `Features/Trade/`) from the `onFlatten` result in `TradeScreenView.swift:212` — no new component needed.

### [P2] — Magic numbers throughout; 7pt and 6pt break the 4pt/8pt grid

- **What/Why:** No spacing/radius tokens exist in the design system, and this file hardcodes: `VStack(spacing: 6)` (16), `HStack(spacing: 8)` (19,29), `.padding(.horizontal, 12)` (24,34), `spacing: 2` (71,102), `spacing: 6` (72), `.padding(.horizontal, 10)` + `.padding(.vertical, 7)` (87-88,119-120), `cornerRadius: 10` (90,92,122,124), `lineWidth: 0.5` (93,125). 6pt stack spacing and 7pt vertical padding are not multiples of 4 — chips land off-grid (position chip height = 39pt content + 14pt padding = 53pt; order chip = 25pt + 14pt = 39pt, ragged against it). Violates Composition + Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Trade/PositionsStripView.swift:16,87-88,90,119-120,122`
- **Exact fix:** introduce a spacing token file `apps/ios/0dteTrader/DesignSystem/AppSpacing.swift`:

```swift
import CoreGraphics
enum AppSpacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let chipRadius: CGFloat = 10
}
```

then: line 16 `VStack(spacing: AppSpacing.sm)`; line 87 `.padding(.horizontal, AppSpacing.md)`; line 88 `.padding(.vertical, AppSpacing.sm)` (7→8 puts the chip at 55pt, on-grid); line 90 `cornerRadius: AppSpacing.chipRadius`; repeat for lines 119-122.

### [P2] — Two competing red/green families; order side is uncolored

- **What/Why:** P&L uses `pnlPositive`/`pnlNegative` = raw `.systemGreen`/`.systemRed` (`AppColors.swift:64-65`), while the BUY/SELL buttons 100pt below use custom `buyGreen` (#19B85B dark) / `sellRed` (#E13A43 dark). The same semantic ("long/profit good, short/loss bad") renders in two visibly different hues on one screen. And the order chip's `BUY 2 MESU5` title (line 103) is plain primary color — the directional information that `TradeActionButton` encodes in color is absent here. Violates Color + Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Trade/PositionsStripView.swift:85,103`; `apps/ios/0dteTrader/DesignSystem/AppColors.swift:64-65`
- **Exact fix:** color the side word in the order chip title:

```swift
Text("\(order.side.displayName) \(order.quantity) \(order.contractSymbol)")
    .font(.chipLabel)
    .foregroundStyle(order.side == .buy ? Color.buyGreen : Color.sellRed)
```

and align the P&L palette with the brand pair by redefining in `AppColors.swift:64-65`:

```swift
static let pnlPositive = buyGreen
static let pnlNegative = sellRed
```

(buyGreen dark #19B85B on appSurface #1A1C24 computes ≈ 6.1:1, sellRed ≈ 5.2:1 — both pass AA 4.5:1.)

### [P3] — P&L has no currency unit; "+1.24" is ambiguous

- **What/Why:** `Format.signedPrice` emits `String(format: "%+.2f")` (`Formatters.swift:10-12`), so a P&L of one dollar twenty-four renders identically to a 1.24-point move — on a screen mixing options premiums and futures prices, the missing `$` forces mental parsing. Violates Information Density (primary figure not self-describing).
- **Location:** `apps/ios/0dteTrader/DesignSystem/Formatters.swift:10-12` (consumed at `PositionsStripView.swift:83`)
- **Exact fix:**

```swift
static func signedPrice(_ value: Double, fractionDigits: Int = 2) -> String {
    let sign = value >= 0 ? "+" : "-"
    return "\(sign)$\(String(format: "%.\(fractionDigits)f", abs(value)))"
}
```

(yields `+$1.24` / `-$0.87`; verify the two other call sites want the `$` before merging.)

### [P3] — No scroll affordance: clipped chips give no hint more content exists

- **What/Why:** Both ScrollViews hide indicators (lines 18,28) and have no edge fade. With 2.5 chips visible, the half-clipped third chip is the only discovery mechanism — fine for TradingView veterans, below the Apple clarity bar. Violates Composition/Platform polish.
- **Location:** `apps/ios/0dteTrader/Features/Trade/PositionsStripView.swift:18,28`
- **Exact fix:** trailing-edge fade mask on each ScrollView:

```swift
.mask(
    HStack(spacing: 0) {
        Color.black
        LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
            .frame(width: 24)
    }
)
```

(or iOS 17-native: `.scrollIndicators(.visible, axes: .horizontal)` plus `.contentMargins(.horizontal, 12, for: .scrollContent)` replacing the manual padding at lines 24,34.)

### [P3] — Flatten confirmation omits the P&L being realized

- **What/Why:** The alert asks "Submit a market sell order to close ES?" (line 48) without stating the unrealized P&L the user is about to lock in — the single most decision-relevant number, already on the chip behind the dimmed alert. One extra clause removes all doubt at the most consequential moment. Violates Information Density at the decision point.
- **Location:** `apps/ios/0dteTrader/Features/Trade/PositionsStripView.swift:47-49`
- **Exact fix:**

```swift
} message: { position in
    Text("Submit a market \(position.quantity > 0 ? "sell" : "buy") order to close \(position.symbol)? Realizes \(Format.signedPrice(position.unrealizedPnl)) unrealized P&L.")
}
```

(after applying the currency fix above this reads "Realizes +$1.24 unrealized P&L.")

## Quick wins vs structural work

**<1 hour (verbatim from findings):**

- 44pt cancel-button frame + contentShape (P1 #1)
- Swap P&L/avg-price lines to `.priceSmall` + `.contentTransition(.numericText())` (P1 #2)
- Expanded VoiceOver labels/hints (P1 #3)
- `ChipPressStyle` + apply at both buttons (P1 #4)
- Border de-dimming: drop `.opacity(0.5)`, lineWidth 1 (P2 #5)
- `.disabled` + opacity + spinner label for working chips (P2 #6)
- Currency `$` in `Format.signedPrice` (P3 #9), scroll fade mask (P3 #10), alert P&L clause (P3 #11)

**Structural (needs refactor/cross-file coordination):**

- `AppSpacing` token file + sweeping all magic numbers across the feature (P2 #7) — touches every Trade view, not just this file.
- Unifying `pnlPositive`/`pnlNegative` with `buyGreen`/`sellRed` (P2 #8) — global palette change; must re-verify contrast everywhere P&L text appears (chart, tickets) before landing.
- Real error/retry surfacing for flatten/cancel failures (P2 #6, second half) — requires wiring async results from `TradeViewModel` through `TradeScreenView` to `ToastView`, beyond this component's current callback-only interface.
