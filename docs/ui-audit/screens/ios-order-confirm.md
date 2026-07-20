# Screen i10: Order confirm sheet

- **App:** iOS
- **Location:** `apps/ios/0dteTrader/Features/Trade/OrderConfirmSheet.swift` (whole file, L1–104); context from `TradeViewModel.swift` L207–264 (arm/confirm/cancel), `DesignSystem/AppColors.swift` L35–50 (buyGreen/sellRed), `DesignSystem/AppTypography.swift` L6–8 (price fonts), `DesignSystem/TradeButtons.swift` L5–28 (TradeActionButton — the component this sheet should have reused)
- **Visual:** UNVERIFIED-VISUAL — no macOS/Xcode available; layout reconstructed from code (VStack spacing 16, inner card spacing 10, horizontal padding 20, `.presentationDetents([.medium])`, 52pt buttons, custom 40×5 grabber)
- **Scores:** Composition 6/10 · Typography 5/10 · Color 5/10 · Density 6/10 · DataViz 5/10 · Motion 3/10 · States 6/10 · Platform 6/10 · A11y 5/10 · Consistency 4/10 → **Overall 51/100**
- **Score justifications:**
  - **Composition 6:** Sound vertical rhythm (title → summary → card → buttons) but 20pt horizontal padding (L95) and 10pt row spacing (L28) break the 8pt grid; custom grabber mis-sized (40×5 vs system 36×5).
  - **Typography 5:** Dynamic Type text styles used throughout (good), but ALL prices render in proportional `LabeledContent` body font — `Font.priceMedium` (monospaced) exists and is never used (L42–43); one-off `.font(.subheadline)` on only the Contract row (L41).
  - **Color 5:** Semantic tokens used (sideColor, appSurface, pnlNegative), but white text on `buyGreen` (0.098/0.722/0.357) computes to ≈2.6:1 — fails WCAG AA 4.5:1 and even the 3:1 large-text floor; white on `sellRed` ≈4.3:1 fails 4.5:1; grabber drawn in `.separator` is near-invisible.
  - **Density 6:** Right content, flat hierarchy — the primary number (Est. price) has identical weight/size to "Quantity" and "Order type" secondary rows; nothing leads the eye.
  - **DataViz 5:** No chart expected here, but the numeric data (price, buying power) lacks tabular figures and aligned decimal columns, the one data-viz discipline this screen needs.
  - **Motion 3:** Zero animation: spinner↔rows swap is instant, label→spinner swap on the confirm button is instant (L77–85), disabled-color change is instant, `.buttonStyle(.plain)` gives no pressed state; no haptic on Confirm/Cancel taps.
  - **States 6:** Loading / error+Retry / disabled-confirm / submitting are all covered (genuinely above average), but loading is a bare `ProgressView` instead of skeleton rows, submit errors are conflated into `previewError` (TradeViewModel.swift:256), and `.medium`-only detent + no ScrollView clips content at large Dynamic Type.
  - **Platform 6:** Sheet + detents + 52pt targets + haptics elsewhere are right; but the native drag indicator is hidden and replaced with a non-standard replica, no `.presentationBackground` token, no keyboard/focus affordances needed but missing haptic on the screen's own buttons.
  - **A11y 5:** `LabeledContent` reads well in VoiceOver; but the decorative grabber isn't `.accessibilityHidden`, the submitting spinner has no label, disabled state is color-opacity only, and AA text contrast fails on the primary CTA.
  - **Consistency 4:** The confirm button hand-rolls (and drifts from) `TradeActionButton` (TradeButtons.swift:5) instead of reusing it; every spacing/radius/opacity value is an inline literal (16/10/12/20/12/52/0.35) with no spacing tokens; one row gets a rogue font override.

## Findings

### [P1] — White CTA label on `buyGreen` fails contrast at ≈2.6:1 (needs ≥4.5:1, and even ≥3:1 for large text)

- **What/Why:** Color & A11y. The confirm button renders `.white` text/spinner on `buyGreen` (dark: r0.098 g0.722 b0.357, AppColors.swift:38). Relative luminance of that green ≈ 0.353 → contrast vs white = 1.05/0.403 ≈ **2.6:1**. White on `sellRed` ≈ **4.3:1** (passes 3:1 large-text, fails 4.5:1). On a money-moving button this is the single most visible pixel on the screen and it's below par — Robinhood uses black on green for exactly this reason.
- **Location:** `apps/ios/0dteTrader/Features/Trade/OrderConfirmSheet.swift:80,86,88`
- **Exact fix:** Add a computed label color and use it for both text and spinner:

```swift
private var confirmLabelColor: Color {
    // Black on buyGreen = 8.1:1; white on sellRed = 4.3:1 (large text OK).
    ticket.side == .buy ? .black : .white
}
```

Then change L80 to `.tint(confirmLabelColor)` and L86 to `.foregroundStyle(confirmLabelColor)`.

### [P1] — All prices render in proportional body font; `Font.priceMedium` (tabular) never used

- **What/Why:** Typography & DataViz. `Format.price(preview.price)` and `Format.price(preview.estBuyingPower)` (L42–43) render in `LabeledContent`'s default proportional `.body`. The design system explicitly created monospaced price fonts "so ticking quotes don't shift layout" (AppTypography.swift:3–4) and this screen ignores them; a resolved 0DTE price like `1.24` vs `11.87` won't align digit-for-digit. Additionally L41 slaps `.font(.subheadline)` on only the "Contract" row, shrinking one row of an otherwise uniform list — an accidental one-off.
- **Location:** `apps/ios/0dteTrader/Features/Trade/OrderConfirmSheet.swift:40–43`
- **Exact fix:** Replace L40–43 with the closure form of `LabeledContent` and the design-system fonts:

```swift
LabeledContent("Contract") {
    Text(preview.contractSymbol).font(.priceMedium)
}
LabeledContent("Est. price") {
    Text(Format.price(preview.price))
        .font(.priceLarge)
        .foregroundStyle(sideColor)
}
LabeledContent("Est. buying power") {
    Text(Format.price(preview.estBuyingPower)).font(.priceMedium)
}
```

(`.priceLarge` on the estimate doubles as the hierarchy fix in the P2 "flat hierarchy" finding.)

### [P1] — Custom drag grabber is a near-invisible, mis-sized replica of the system indicator

- **What/Why:** Platform & Color. L98 hides the native indicator, then L15–18 draws a 40×5 capsule filled with `Color.appBorder` — which is `UIColor.separator` (AppColors.swift:61), a ~40%-opacity hairline gray designed for 0.5pt lines. Against the sheet background its contrast is ~1.3:1 (UI components need 3:1), so the sheet's only affordance for "swipe to dismiss" is effectively invisible. It's also 40pt wide vs Apple's 36pt standard, and it's the first element VoiceOver would hit with no `.accessibilityHidden`.
- **Location:** `apps/ios/0dteTrader/Features/Trade/OrderConfirmSheet.swift:15–18,98`
- **Exact fix:** Delete L15–18 entirely and change L98 to:

```swift
.presentationDragIndicator(.visible)
```

The system indicator is correctly sized, colored, and accessibility-hidden for free.

### [P1] — Loading state is a bare spinner; no skeleton rows for the preview card

- **What/Why:** States & Motion. While the server resolves the contract, the card shows quantity/type rows plus one `ProgressView()` row (L32–38), then the resolved rows snap in instantly — a jarring layout jump of 3+ rows inside a fixed `.medium` sheet. Audit bar is skeletons > spinners.
- **Location:** `apps/ios/0dteTrader/Features/Trade/OrderConfirmSheet.swift:32–38`
- **Exact fix:** Replace the `if tradeViewModel.isPreviewLoading` branch with redacted placeholder rows identical in shape to the loaded rows:

```swift
if tradeViewModel.isPreviewLoading {
    LabeledContent("Contract") { Text("MES 5000C").font(.priceMedium) }
    LabeledContent("Est. price") { Text(Format.price(0)).font(.priceLarge) }
    LabeledContent("Est. buying power") { Text(Format.price(0)).font(.priceMedium) }
        .redacted(reason: .placeholder)
} else if let preview = tradeViewModel.preview {
```

and add `.animation(.easeInOut(duration: 0.2), value: tradeViewModel.isPreviewLoading)` on the inner VStack (L28) so rows cross-fade instead of jumping.

### [P1] — `.medium`-only detent with no ScrollView clips content at Accessibility text sizes

- **What/Why:** Platform & A11y. The sheet is locked to `.presentationDetents([.medium])` (L97) and the body is a fixed `VStack` with no `ScrollView`. At Dynamic Type sizes above `.xxLarge` — plausible for a trading app's older users — title + summary + 5–6 card rows + warnings + 52pt buttons exceed ~50% of an 852pt viewport, and the content is truncated with no way to expand or scroll.
- **Location:** `apps/ios/0dteTrader/Features/Trade/OrderConfirmSheet.swift:14,97`
- **Exact fix:**

```swift
ScrollView(.vertical) {
    VStack(spacing: 16) { /* existing content */ }
    .padding(.horizontal, 16)
    .padding(.bottom, 12)
}
.scrollBounceBehavior(.basedOnSize)
.presentationDetents([.medium, .large])
```

### [P2] — Sheet background is the system material, not the app's dark token

- **What/Why:** Color & Consistency. No `.presentationBackground` is set, so the sheet floats on the default system material while the card uses `Color.appSurface` (L64) — the card will sit on a visibly lighter, slightly translucent gray that matches nothing in `AppColors.swift` and lets content behind the sheet bleed through.
- **Location:** `apps/ios/0dteTrader/Features/Trade/OrderConfirmSheet.swift:64,97–98`
- **Exact fix:** Add after L96:

```swift
.presentationBackground(Color.appBackground)
```

### [P2] — Confirm button hand-rolls `TradeActionButton` and drifts: no haptic, no press state

- **What/Why:** Consistency & Motion. `TradeActionButton` (DesignSystem/TradeButtons.swift:5–28) already exists for exactly this pattern — 52pt minHeight, 12pt continuous corner, 0.35-opacity disabled state — and it fires `Haptics.impact(.medium)` on tap. The sheet duplicates the styling inline (L74–91) but drops the haptic and uses `.buttonStyle(.plain)`, so there is zero tactile or visual feedback at the moment of greatest commitment.
- **Location:** `apps/ios/0dteTrader/Features/Trade/OrderConfirmSheet.swift:74–91`
- **Exact fix:** Add haptic + a pressed state; keep the inline button only because it needs a loading spinner (or extend `TradeActionButton` with an `isLoading` flag — see Structural). Minimal verbatim change:

```swift
Button {
    Haptics.impact(.medium)
    Task { await tradeViewModel.confirmArmedOrder() }
} label: { /* unchanged label */ }
.buttonStyle(PressFeedbackStyle())   // see below
.disabled(!confirmEnabled)
```

with, at file scope:

```swift
private struct PressFeedbackStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.8 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}
```

### [P2] — Submitting state snaps label→spinner with no transition and no VoiceOver label

- **What/Why:** Motion & A11y. L77–85 swaps `Text("Confirm Buy")` for a `ProgressView` inside a `Group` — instant, and the button's accessible label momentarily becomes nothing meaningful. The disabled background color (L88) also flips without animation.
- **Location:** `apps/ios/0dteTrader/Features/Trade/OrderConfirmSheet.swift:77–92`
- **Exact fix:** Replace the `Group` with a cross-fading ZStack and an explicit label:

```swift
ZStack {
    Text("Confirm \(ticket.side.displayName)")
        .font(.headline)
        .opacity(tradeViewModel.isSubmitting ? 0 : 1)
    if tradeViewModel.isSubmitting {
        ProgressView().tint(confirmLabelColor)
    }
}
.animation(.easeInOut(duration: 0.15), value: tradeViewModel.isSubmitting)
.accessibilityLabel(tradeViewModel.isSubmitting
    ? "Submitting order"
    : "Confirm \(ticket.side.displayName)")
```

### [P2] — Every spacing/radius value is an off-token inline literal; two break the 8pt grid

- **What/Why:** Consistency & Composition. There are no spacing tokens in the iOS design system, and this file is a showcase: `spacing: 16` (L14), `spacing: 10` (L28 — not a multiple of 4), `.padding()` default-16 (L62), `cornerRadius: 12` ×2 (L65, L89), `HStack(spacing: 12)` (L67), `minHeight: 52` ×2 (L72, L87), `.padding(.horizontal, 20)` (L95 — not a multiple of 8; system margin is 16), `.padding(.bottom, 12)` (L96), `opacity(0.35)` (L88). The 20pt side margins are measurably wider than every other screen using 16pt.
- **Location:** `apps/ios/0dteTrader/Features/Trade/OrderConfirmSheet.swift:14,28,62,65,67,72,87–89,95–96`
- **Exact fix (grid-correcting minimum, no token system required):** L28 `VStack(spacing: 10)` → `VStack(spacing: 12)`; L95 `.padding(.horizontal, 20)` → `.padding(.horizontal, 16)`. Follow-up (structural): add `AppSpacing`/`AppRadius` enums (xs 4, sm 8, md 12, lg 16, xl 24; card/button radius 12) to `DesignSystem/` and migrate.

### [P2] — Submit failures are rendered as preview errors inside the details card

- **What/Why:** States. In `confirmArmedOrder()` the catch blocks set `previewError` (TradeViewModel.swift:256,258), so a _submission_ failure ("Market closed", "Insufficient buying power") appears in the card styled as if the preview failed — directly under "Est. buying power" — and the Retry button next to it calls `loadPreview()`, not a resubmit. Wrong semantics, wrong recovery action.
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeViewModel.swift:254–259`; rendered at `OrderConfirmSheet.swift:51–60`
- **Exact fix:** Add to TradeViewModel (after L54):

```swift
@Published private(set) var submitError: String?
```

Set it in the two catch blocks of `confirmArmedOrder` (`submitError = error.userMessage` / `= error.localizedDescription`) and clear it at the top of `confirmArmedOrder()` and in `cancelArmedOrder()`. In the sheet, render it under the button row (after L93), distinct from the preview error:

```swift
if let submitError = tradeViewModel.submitError {
    Label(submitError, systemImage: "exclamationmark.circle.fill")
        .font(.footnote)
        .foregroundStyle(Color.pnlNegative)
        .multilineTextAlignment(.center)
}
```

The existing Retry button stays bound to `loadPreview()` and only shows for actual preview errors.

### [P2] — Disabled confirm state is color-opacity only (35%)

- **What/Why:** A11y & Color. `sideColor.opacity(0.35)` (L88) over a dark background produces a muted wash whose label contrast drops to ~1.6:1 and whose "disabled-ness" is conveyed purely by hue fade — invisible to users with color-vision deficiency. WCAG exempts disabled controls from contrast minimums, but the _state distinction_ must not rely on color alone.
- **Location:** `apps/ios/0dteTrader/Features/Trade/OrderConfirmSheet.swift:88`
- **Exact fix:** Use a neutral, non-side-colored disabled surface with secondary text:

```swift
.background(confirmEnabled ? sideColor : Color.appSurfaceElevated)
```

and change the label foreground (L86) to:

```swift
.foregroundStyle(confirmEnabled ? confirmLabelColor : Color.secondary)
```

### [P3] — No "holy shit" moment: flat hierarchy, redundant title, no commit gesture

- **What/Why:** Density & Motion. The title "Confirm Buy" (L20) and the button "Confirm Buy" (L82) repeat each other; the actual decision-driving numbers (contract, price, buying power) are buried mid-card at the same weight as "Quantity". Best-in-class order confirms (Robinhood, Schwab thinkorswim mobile) lead with the number and make the commit physical — slide-to-confirm — which also eliminates accidental double-taps.
- **Location:** `apps/ios/0dteTrader/Features/Trade/OrderConfirmSheet.swift:20,42,82`
- **Exact fix (cheap half):** Change the title to context, not repetition: `Text(ticket.summary)` as the headline in `.title3.bold()` and demote the current L23 summary row to the contract line once the preview loads; apply the `.priceLarge` + `sideColor` emphasis from the P1 typography fix so Est. price is the visual apex. (Full swipe-to-confirm is structural — see below.)

## Quick wins vs structural work

**Landable in <1 hour (verbatim above):**

- Black label on the Buy CTA (contrast fix, 3 lines)
- `Font.priceMedium`/`priceLarge` on the three value rows + delete the stray `.font(.subheadline)`
- Delete custom capsule, use `.presentationDragIndicator(.visible)`
- `.presentationBackground(Color.appBackground)`
- `Haptics.impact(.medium)` + `PressFeedbackStyle` on the confirm button
- ZStack cross-fade + `.accessibilityLabel` for the submitting state
- Grid fixes: spacing 10→12, horizontal padding 20→16
- Neutral `appSurfaceElevated` disabled state instead of 35%-opacity side color

**Needs refactors (>1 hour):**

- Redacted skeleton rows replacing the loading `ProgressView` (touches the loading branch + animation plumbing)
- ScrollView + `.medium, .large` detents (requires re-verifying layout at all Dynamic Type sizes)
- `submitError` split in `TradeViewModel` (new @Published, wiring in confirm/cancel, new UI row)
- Extend `TradeActionButton` with an `isLoading` state and delete the sheet's inline button (component unification across Trade screens)
- `AppSpacing`/`AppRadius` token enums in `DesignSystem/` and migration off inline literals app-wide
- Slide-to-confirm gesture control (new component, haptic sequence, reduced-motion fallback)
