# Screen i11: Trade history sheet
- **App:** iOS
- **Location:** `apps/ios/0dteTrader/Features/Trade/HistoryView.swift` (whole file, 116 lines); presented from `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:91-93`; desktop clone reference `apps/desktop/src/features/trade/HistoryView.tsx`
- **Visual:** UNVERIFIED-VISUAL (iOS pixels) — no macOS/Xcode available; layout reconstructed from code. Desktop-clone screenshot `docs/ui-audit/shots/10-history.png` was reviewed and used for cross-platform divergence checks (it shows a `Done` button, mono fonts, and a centered empty state that the iOS code does not produce).
- **Scores:** Composition 6/10 · Typography 5/10 · Color 6/10 · Density 6/10 · DataViz 5/10 · Motion 3/10 · States 3/10 · Platform 5/10 · A11y 5/10 · Consistency 4/10 → **Overall 48/100**
- **Score justifications:**
  - Composition 6 — Plain `List` with two unstyled sections; HStack/Spacer alignment is clean, but the primary metric (net P/L) sits in a default list row with no visual weight (HistoryView.swift:46-55).
  - Typography 5 — Total uses monospaced `.priceMedium`, but per-row P/L uses proportional `.caption` (line 88) so digits are not tabular; symbol line is proportional (line 74) while the desktop clone renders it mono (HistoryView.tsx:134).
  - Color 6 — Contrast is fine (buyGreen ≈7.6:1, sellRed ≈4.6:1 on appBackground — measured), and signs make P/L not color-only; but P/L uses `buyGreen/sellRed` instead of the dedicated `pnlPositive/pnlNegative` tokens (lines 53, 89) and zero P/L renders green "+0.00".
  - Density 6 — Detail line (`type · filled @ price · date`) is well-packed (lines 96-107), but the hero number of the screen is body-sized.
  - DataViz 5 — No charts required here; judged on loading discipline: bare `ProgressView()` spinner instead of skeleton rows (lines 22-23).
  - Motion 3 — Zero motion: `ProgressView` → list swap is instant with no transition, no insert animations, no haptics.
  - States 3 — Loading = spinner; empty = bare left-aligned `Text` in a list row (line 59); error = passive centered text with no retry (lines 16-20); no pull-to-refresh, so data goes stale.
  - Platform 5 — Sheet has no `Done` button (unlike `ProfileView.swift:18-22` and the desktop clone HistoryView.tsx:67-71); swipe-down is the only dismissal path; no SF Symbols anywhere; list rows give ≥44pt targets.
  - A11y 5 — No `.accessibilityLabel`/`.accessibilityElement(children: .combine)` anywhere; VoiceOver reads "+0.00" as "plus zero point zero zero"; meaning is not color-only (signs + status text present), which is the saving grace.
  - Consistency 4 — Diverges from the desktop clone in 4 places (Done button, total font size, mono symbol line, centered empty state), bypasses its own P/L color tokens, and hardcodes 2pt spacing values with no spacing token system (lines 71, 93).

## Findings

### [P1] — No dismissal affordance: sheet has no Done button
- **What/Why:** Platform Fidelity + Consistency. The sheet's only exit is swipe-down. The app's own `ProfileView` adds `Button("Done") { dismiss() }` (ProfileView.swift:18-22) and the desktop clone renders a `Done` nav-bar button (HistoryView.tsx:67-71, visible in 10-history.png). A trading sheet covering the blotter needs an explicit, discoverable close target.
- **Location:** `apps/ios/0dteTrader/Features/Trade/HistoryView.swift:27-28`
- **Exact fix:**
```swift
.navigationTitle("History")
.navigationBarTitleDisplayMode(.inline)
.toolbar {
    ToolbarItem(placement: .topBarTrailing) {
        Button("Done") { dismiss() }
    }
}
```
plus `@Environment(\.dismiss) private var dismiss` at line 9.

### [P1] — Error state is a dead end: no retry, no refresh
- **What/Why:** State Coverage. On failure the user sees passive secondary text (lines 16-20) and the only recovery is dismissing and reopening the sheet. The list also lacks `.refreshable`, so successful loads go stale with no way to re-pull — unacceptable for order history in a live trading app.
- **Location:** `apps/ios/0dteTrader/Features/Trade/HistoryView.swift:16-20, 44-67`
- **Exact fix:** Replace the error branch with an actionable `ContentUnavailableView` and add pull-to-refresh:
```swift
} else if let errorMessage {
    ContentUnavailableView {
        Label("Couldn't Load History", systemImage: "exclamationmark.triangle")
    } description: {
        Text(errorMessage)
    } actions: {
        Button("Retry") { Task { await load() } }
            .buttonStyle(.borderedProminent)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
}
```
and on the `List` at line 45 add `.refreshable { await load() }`. Also make `load()` reset `errorMessage = nil` first so Retry clears the error.

### [P1] — Per-row P/L uses proportional caption font, not tabular/monospaced
- **What/Why:** Typography. Line 88 renders realized P/L in `.caption.weight(.semibold)` — proportional digits — while the total uses monospaced `.priceMedium` and the design system exists precisely so "ticking quotes don't shift layout" (AppTypography.swift:3-4). Numbers in the same column will misalign right-edge across rows.
- **Location:** `apps/ios/0dteTrader/Features/Trade/HistoryView.swift:88`
- **Exact fix:**
```swift
Text(Format.signedPrice(realized))
    .font(.priceSmall.weight(.semibold))
    .foregroundStyle(realized > 0 ? Color.pnlPositive : realized < 0 ? Color.pnlNegative : .secondary)
```

### [P1] — P/L colored with buy/sell action tokens instead of P&L tokens
- **What/Why:** Consistency + Color. The design system defines `pnlPositive`/`pnlNegative` explicitly "for text on app surfaces" (AppColors.swift:63-65) and the desktop clone uses `--pnl-positive/--pnl-negative` (HistoryView.tsx:14-16). HistoryView uses `buyGreen`/`sellRed` (lines 53, 89), so P/L text will drift from every other P/L surface if either palette changes. Additionally `>= 0` colors a zero P/L green — zero is neutral, not profit (screenshot shows green "+0.00").
- **Location:** `apps/ios/0dteTrader/Features/Trade/HistoryView.swift:53, 89`
- **Exact fix:**
```swift
// line 53
.foregroundStyle(history.totalRealizedPnl > 0 ? Color.pnlPositive
                 : history.totalRealizedPnl < 0 ? Color.pnlNegative : .secondary)
```

### [P1] — Empty state is a bare left-aligned list-row label
- **What/Why:** State Coverage. "No orders yet." is a plain `Text` inside a `Section` (lines 58-60), so it renders as an unstyled list row, left-aligned, no icon, no guidance — while the desktop clone centers it (HistoryView.tsx:116-118). iOS 17 ships `ContentUnavailableView` for exactly this.
- **Location:** `apps/ios/0dteTrader/Features/Trade/HistoryView.swift:57-66`
- **Exact fix:** Move the empty check above the `List` and render:
```swift
if history.entries.isEmpty {
    ContentUnavailableView(
        "No Orders Yet",
        systemImage: "clock.arrow.circlepath",
        description: Text("Filled and working orders will appear here.")
    )
} else {
    List { /* total section + entries section */ }
}
```

### [P2] — Loading state is a spinner, not skeleton rows
- **What/Why:** DataViz/States — skeletons > spinners. `ProgressView()` (lines 22-23) gives no sense of the incoming layout, and its swap to the list is an instant pop with no transition (Motion).
- **Location:** `apps/ios/0dteTrader/Features/Trade/HistoryView.swift:21-24`
- **Exact fix:**
```swift
} else {
    List {
        ForEach(0..<6, id: \.self) { _ in
            VStack(alignment: .leading, spacing: 4) {
                RoundedRectangle(cornerRadius: 4).fill(Color.appSurface).frame(height: 15)
                RoundedRectangle(cornerRadius: 4).fill(Color.appSurface).frame(width: 220, height: 12)
            }
            .padding(.vertical, 4)
        }
    }
    .redacted(reason: .placeholder)
    .listStyle(.insetGrouped)
}
```

### [P2] — Hero metric under-emphasized; inconsistent with clone
- **What/Why:** Density/Composition. The screen's primary number — net realized P/L — is `.priceMedium` (body, 17pt, medium) while the desktop clone renders it `fs-title3`/600 (HistoryView.tsx:102-104, visible larger in 10-history.png). The most important datum on the sheet has the same visual weight as a settings row.
- **Location:** `apps/ios/0dteTrader/Features/Trade/HistoryView.swift:52`
- **Exact fix:** `.font(.priceLarge)` (title3 monospaced semibold, AppTypography.swift:6) — one-word change, matches the clone.

### [P2] — Hardcoded 2pt spacing breaks the 4pt grid
- **What/Why:** Composition/Consistency. `VStack(alignment: .leading, spacing: 2)` (line 71) and `.padding(.vertical, 2)` (line 93) are off-grid one-offs; the desktop clone uses `gap: 2; padding: 10px 0` — different rhythm again (HistoryView.tsx:126-129). No spacing tokens exist anywhere in the iOS target, so every screen invents its own.
- **Location:** `apps/ios/0dteTrader/Features/Trade/HistoryView.swift:71, 93`
- **Exact fix:** `spacing: 4` and `.padding(.vertical, 4)`; longer-term, add `AppSpacing` tokens (`xxs: 4, xs: 8, sm: 12, md: 16`) to `DesignSystem/` and sweep the feature views.

### [P2] — No transition between loading → content; no row insert animation
- **What/Why:** Motion. The `Group` swaps `ProgressView` → `List` instantly; no `.animation`, no `.transition`, no haptic on load completion. Robinhood-bar sheets fade/slide content in within ~200ms.
- **Location:** `apps/ios/0dteTrader/Features/Trade/HistoryView.swift:13-25, 33-41`
- **Exact fix:**
```swift
.transaction { $0.animation = .easeOut(duration: 0.2) } // on the Group
// and in load(): withAnimation(.easeOut(duration: 0.2)) { history = result }
```

### [P3] — VoiceOver reads rows as five disjoint fragments
- **What/Why:** Accessibility. Each row is 4 separate `Text` elements (side/qty/symbol, status, detail line, P/L) — VoiceOver users must swipe through each fragment, and P/L reads as "plus one point two four". No `.accessibilityElement(children: .combine)` or labels.
- **Location:** `apps/ios/0dteTrader/Features/Trade/HistoryView.swift:70-94`
- **Exact fix:** append to the row `VStack`:
```swift
.accessibilityElement(children: .combine)
.accessibilityLabel("\(entry.side) \(entry.quantity) \(entry.contractSymbol), \(OrderStatus(tolerant: entry.status).displayName)")
.accessibilityValue(entry.realizedPnl.map { "realized P/L \(Format.signedPrice($0)) dollars" } ?? "")
```

### [P3] — P/L formatter has no thousands separators; timestamp overly verbose
- **What/Why:** Typography/Density. `Format.signedPrice` is `String(format: "%+.2f")` (Formatters.swift:11), so a $12,345.67 day renders "+12345.67" — hard to scan at speed. And `date.formatted(date: .abbreviated, ...)` (line 104) emits the year ("Jul 18, 2026, 2:56 PM") inside an already-dense caption line; the desktop clone omits the year (HistoryView.tsx:25-30).
- **Location:** `apps/ios/0dteTrader/DesignSystem/Formatters.swift:10-12`, `apps/ios/0dteTrader/Features/Trade/HistoryView.swift:104`
- **Exact fix:** use `NumberFormatter`/`FloatingPointFormatStyle` with grouping: `value.formatted(.number.precision(.fractionLength(2)).sign(strategy: .always()).grouping(.automatic))`, and drop the year when it's the current year (or use `.formatted(.dateTime.month(.abbreviated).day().hour().minute())`).

### [P3] — Symbol line proportional on iOS, monospaced on clone
- **What/Why:** Consistency. `BUY 2 MNQZ6` renders in proportional `.subheadline` (line 74); the clone uses `--font-mono` for the same line (HistoryView.tsx:134). Contract symbols (`MNQZ6`, `ESU6`) align better and scan faster in mono, and the two platforms should match by design.
- **Location:** `apps/ios/0dteTrader/Features/Trade/HistoryView.swift:73-74`
- **Exact fix:** `.font(.system(.subheadline, design: .monospaced).weight(.semibold))`

## Quick wins vs structural work

**Landable in <1 hour (all one-file, HistoryView.swift unless noted):**
- Add `Done` toolbar button + `dismiss` (F1).
- `.refreshable { await load() }` + reset `errorMessage` in `load()` (part of F2).
- `.priceSmall.weight(.semibold)` for row P/L (F3).
- Swap `buyGreen/sellRed` → `pnlPositive/pnlNegative` with neutral-zero handling (F4).
- `.priceLarge` on the net total (F7).
- `spacing: 4` / `.padding(.vertical, 4)` (F8).
- `.accessibilityElement(children: .combine)` + label/value (F10).
- Ease-out 200ms transition on load (F9).
- Monospaced symbol line (F12).

**Structural / cross-cutting:**
- `ContentUnavailableView` error + retry + empty states — requires reworking the `Group` branching so empty/error render outside the `List` (F2, F5).
- Skeleton-row loading placeholder with `.redacted(reason: .placeholder)` (F6).
- `AppSpacing` token set in `DesignSystem/` + sweep of inline spacing across all feature views (F8, root cause).
- Grouped-thousands `Format.signedPrice` + year-aware timestamp formatting in `Formatters.swift` — touches every P/L surface (PositionsStripView also uses it), so verify callers (F11).
- iOS↔desktop parity pass: Done button, total font size, mono symbol, centered empty state all diverge from `apps/desktop/src/features/trade/HistoryView.tsx` — fix one side and hold the other to it (F1, F5, F7, F12).
