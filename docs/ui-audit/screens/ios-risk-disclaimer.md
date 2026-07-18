# Screen i2: Risk Disclaimer
- **App:** iOS
- **Location:** `apps/ios/0dteTrader/Features/Auth/RiskDisclaimerView.swift` (whole file, 50 lines; key refs: layout L9–37, copy L39–49). Supporting: `App/RootView.swift:21` (background), `DesignSystem/TradeButtons.swift:11–28` (divergent duplicate button), `DesignSystem/AppColors.swift:53–59` (appAccent), `Features/Auth/LoginView.swift:64–67` (same CTA contrast bug, systemic)
- **Visual:** UNVERIFIED-VISUAL — no macOS/Xcode on this machine; layout reconstructed from code (VStack spacing 20, padding 24, minHeight 50 CTA) and cross-checked against the desktop React port at `docs/ui-audit/shots/01-risk-disclaimer.png` (860×1864). Pixel measurements below are from the desktop port and assumed faithful to the iOS layout math.
- **Scores:** Composition 4/10 · Typography 5/10 · Color 5/10 · Density 6/10 · DataViz N/A (no data-viz on this screen; excluded) · Motion 3/10 · States 7/10 · Platform 6/10 · A11y 5/10 · Consistency 4/10 → **Overall 50/100** (45/90 applicable points, normalized)
- **Score justifications:**
  - Composition 4: ~31% of viewport (y≈1040→1630 of 1864px in reference shot) is a featureless void between copy end and CTA; no icon/anchor; paddings mostly 8pt-aligned except a 4pt inset (L19).
  - Typography 5: Dynamic Type styles used throughout (scales correctly — credit where due), but the *only* body copy is `.footnote` (13pt) at `.secondary` — sub-legibility-bar for a legal gate; title lacks `.isHeader`.
  - Color 5: semantic tokens used (appAccent/appBackground via RootView — good); body contrast ≈6.3:1 passes AA, but white-on-appAccent CTA = 3.15:1, fails AA 4.5:1 in dark mode.
  - Density 6: sparse is defensible for a legal gate and title/copy/CTA hierarchy is unambiguous, but density was traded for void instead of larger, more legible type.
  - Motion 3: one haptic (L23) and nothing else — no press state, no transitions, no eased 120–250ms feedback anywhere.
  - States 7: screen is static by design; accept is synchronous, idempotent, and can't fail (AuthViewModel.swift:56–60), so loading/error states are genuinely N/A — but there's no pressed/disabled visual state either.
  - Platform 6: haptics ✓, safe area handled by RootView ✓, 50pt target ≥44pt ✓; but no SF Symbol, `.buttonStyle(.plain)` kills the touch-down feedback iOS users expect.
  - A11y 5: Dynamic Type ✓ and ScrollView handles AX5 overflow ✓; fails on missing `.isHeader`, 3.15:1 CTA contrast, no `accessibilityHint` on the gate button.
  - Consistency 4: CTA is a hand-rolled near-copy of `TradeActionButton` with divergent values (50 vs 52pt, no contentShape, no accessibilityLabel); seven magic numbers (20/32/4/50/12/8/24) with zero spacing/radius tokens.

## Findings

### [P1] — CTA contrast 3.15:1, fails WCAG AA 4.5:1 (white text on appAccent)
- **What/Why:** The accept button renders `.white` `.headline` text on `Color.appAccent` (dark: RGB 0.337/0.561/0.969, luminance ≈0.284). Contrast vs white = 1.05/0.334 = **3.15:1** — fails the 4.5:1 requirement for text (17pt semibold only marginally clears the 3:1 "large text" floor; semibold 600 doesn't reliably count as WCAG "bold"). This is the single most important control on the screen and it's below the accessibility bar. Same defect is systemic at `LoginView.swift:64–67`. Violates Color&Contrast, A11y.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RiskDisclaimerView.swift:28–30`; token at `apps/ios/0dteTrader/DesignSystem/AppColors.swift:53–59`
- **Exact fix:** add a high-contrast CTA token to `AppColors.swift` (after line 59) and use it for the button background:
```swift
/// High-contrast CTA fill for white label text. 5.6:1 in dark, 4.8:1 in light.
static let appAccentStrong = Color(
    uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.180, green: 0.373, blue: 0.847, alpha: 1) // #2E5FD8
            : UIColor(red: 0.192, green: 0.427, blue: 0.878, alpha: 1)
    }
)
```
Then in `RiskDisclaimerView.swift:30` change `.background(Color.appAccent)` → `.background(Color.appAccentStrong)`. Apply the same swap at `LoginView.swift:65` (keep `Color.appAccent` for links/tints where 3:1 is acceptable).

### [P1] — Legal body copy set at 13pt `.footnote` in `.secondary`
- **What/Why:** The entire disclosure — the sole reason this screen exists — renders at `.footnote` (13pt at default Dynamic Type) in `.secondary`. Contrast ≈6.3:1 technically passes AA, but 13pt gray legal copy on a near-black field is below the Apple/Robinhood legibility bar (HIG body standard is 17pt; regulatory text should never be the *smallest* type on screen — it reads as a deliberate de-emphasis dark pattern). Violates Typography, Density.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RiskDisclaimerView.swift:16–17`
- **Exact fix:**
```swift
Text(disclaimerText)
    .font(.callout) // 16pt at default size, scales with Dynamic Type
    .foregroundStyle(.secondary)
    .lineSpacing(4)
    .frame(maxWidth: .infinity, alignment: .leading)
```

### [P1] — ~31% of the viewport is dead void; no visual anchor above the fold
- **What/Why:** In the reference shot the copy block ends at y≈1040/1864 (56%) and the CTA starts at y≈1630; the intervening ~590px (31–32% of viewport height) is pure black. Golden-ratio (62/38) budgeting allows ~38% total whitespace — this screen spends nearly all of it in one featureless hole, so the composition reads as unfinished rather than calm. There is also no icon or brand mark: nothing signals "serious warning" before the user reads a word. Violates Composition&Proportion.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RiskDisclaimerView.swift:9–37`
- **Exact fix:** restructure the body (replaces lines 9–35); adds a hierarchical SF Symbol anchor, moves type to `.callout`, gives the ScrollView a bottom fade so truncation is always signaled:
```swift
VStack(spacing: 0) {
    Image(systemName: "exclamationmark.triangle.fill")
        .font(.system(size: 40))
        .symbolRenderingMode(.hierarchical)
        .foregroundStyle(Color.appAccent)
        .padding(.top, 48)
        .accessibilityHidden(true)

    Text("Risk Disclosure")
        .font(.title.bold())
        .accessibilityAddTraits(.isHeader)
        .padding(.top, 16)

    ScrollView {
        Text(disclaimerText)
            .font(.callout)
            .foregroundStyle(.secondary)
            .lineSpacing(4)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.top, 24)
    .overlay(alignment: .bottom) {
        LinearGradient(colors: [Color.appBackground.opacity(0), Color.appBackground],
                       startPoint: .top, endPoint: .bottom)
            .frame(height: 32)
            .allowsHitTesting(false)
    }

    Button {
        Haptics.success()
        viewModel.acceptDisclaimer()
    } label: {
        Text("I Understand and Accept")
            .font(.headline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(Color.appAccentStrong)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(Rectangle())
    }
    .buttonStyle(AcceptButtonStyle())
    .accessibilityHint("Accepts the risk disclosure and continues to sign in")
    .padding(.top, 16)
    .padding(.bottom, 8)
}
.padding(24)
```

### [P1] — Accept button has zero pressed-state feedback
- **What/Why:** `.buttonStyle(.plain)` (L33) renders the label identically in pressed and unpressed states — the most-tapped button in the first-run flow has no touch-down response. Apple/Robinhood bar is a 120–250ms eased opacity/scale response plus haptic; only the haptic exists. Violates Motion&Micro-interactions, Platform Fidelity.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RiskDisclaimerView.swift:33`
- **Exact fix:** add to the file (below the struct) and apply `.buttonStyle(AcceptButtonStyle())`:
```swift
private struct AcceptButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.75 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}
```

### [P2] — Hand-rolled CTA duplicates `TradeActionButton` with divergent values
- **What/Why:** The label construction at L26–31 (`.headline` / `.white` / `maxWidth: .infinity` / radius-12 continuous rect / `.plain`) is a near-verbatim copy of `DesignSystem/TradeButtons.swift:16–22`, but with `minHeight: 50` instead of 52, no `.contentShape(Rectangle())`, and no `.accessibilityLabel`. Two sources of truth for the same component guarantee future drift. Violates Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RiskDisclaimerView.swift:26–33` vs `apps/ios/0dteTrader/DesignSystem/TradeButtons.swift:11–28`
- **Exact fix:** either (a) reuse the component — `TradeActionButton(title: "I Understand and Accept", color: .appAccentStrong) { viewModel.acceptDisclaimer() }` — or (b) if the lighter weight is intentional, extract a shared `PrimaryCTAButton` into `DesignSystem/` and make both call sites use it with one `minHeight: 52` constant.

### [P2] — Title missing `.isHeader`; gate button missing `accessibilityHint`
- **What/Why:** VoiceOver users get no heading announcement for "Risk Disclosure" (it's read as plain text), and the accept button — which *changes app state irreversibly for first run* — has no hint describing its consequence. Focus order itself is correct (title → copy → CTA). Violates Accessibility.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RiskDisclaimerView.swift:10–11` (title), `22–33` (button)
- **Exact fix:** add `.accessibilityAddTraits(.isHeader)` after L11, and `.accessibilityHint("Accepts the risk disclosure and continues to sign in")` after L33 (both included in the restructure code above).

### [P2] — Seven magic numbers, no spacing/radius tokens; 4pt inset breaks the grid
- **What/Why:** `spacing: 20` (L9), `.padding(.top, 32)` (L12), `.padding(.horizontal, 4)` (L19), `minHeight: 50` (L29), `cornerRadius: 12` (L31), `.padding(.bottom, 8)` (L34), `.padding(24)` (L36) — all inline, no `AppSpacing`/`AppRadius` tokens exist anywhere in the DesignSystem. Concretely wrong values: the 4pt horizontal text inset (L19) makes body copy sit at 28pt from screen edge while everything else is at 24pt — a visible 4pt misalignment between title and copy left edges, and 4 is off the 8pt grid; `padding(.top, 32)` stacks on the outer 24 for an arbitrary 56pt header offset.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RiskDisclaimerView.swift:9,12,19,29,31,34,36`
- **Exact fix:** delete `.padding(.horizontal, 4)` at L19 (aligns copy to the 24pt margin). Then add tokens to the DesignSystem and migrate:
```swift
// apps/ios/0dteTrader/DesignSystem/AppSpacing.swift
enum AppSpacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 16
    static let lg: CGFloat = 24
    static let xl: CGFloat = 32
}
enum AppRadius {
    static let button: CGFloat = 12
}
```

### [P3] — Wrong haptic semantics on the accept action
- **What/Why:** Accepting the disclosure is a successful confirmation, but L23 fires `Haptics.impact(.medium)` — a generic mechanical tap. `Haptics.success()` (a `UINotificationFeedbackGenerator .success`) already exists in `DesignSystem/Haptics.swift:13–15` and is the semantically correct pattern for a completed gate. "Holy shit"-level nit: this is the first haptic a new user ever feels in the app.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RiskDisclaimerView.swift:23`
- **Exact fix:** `Haptics.impact(.medium)` → `Haptics.success()`

### [P3] — No scroll affordance when copy truncates on small devices / large text
- **What/Why:** The ScrollView (L14–20) gives no static indication that content continues — on iPhone SE-class heights or AX3+ Dynamic Type the text clips mid-sentence with only the transient scroll indicator as a hint. A first-run legal gate should never look "fully read" when it isn't.
- **Location:** `apps/ios/0dteTrader/Features/Auth/RiskDisclaimerView.swift:14–20`
- **Exact fix:** the bottom `LinearGradient` overlay shown in the P1 restructure above (32pt fade from `appBackground.opacity(0)` to `appBackground`, `allowsHitTesting(false)`).

## Quick wins vs structural work

**Landable in <1 hour:**
- Body font `.footnote` → `.callout` + `lineSpacing(4)` (L16).
- Delete the 4pt horizontal inset (L19).
- `.accessibilityAddTraits(.isHeader)` on title, `accessibilityHint` on button.
- `Haptics.impact(.medium)` → `Haptics.success()` (L23).
- Add `AcceptButtonStyle` (15 lines) and apply it.
- Add `appAccentStrong` token and swap both CTA backgrounds (this screen + `LoginView.swift:65`).
- Bottom scroll-fade gradient overlay.

**Structural (needs refactor / cross-screen coordination):**
- Introduce `AppSpacing`/`AppRadius` token enums and migrate this screen + `LoginView` (same `.padding(24)`, radius 10/12 inline values) — audit-wide problem, not screen-local.
- Extract a shared `PrimaryCTAButton` (or reuse `TradeActionButton`) so this screen, LoginView, and RegisterView stop hand-rolling the same button with divergent heights (50 vs 52pt).
- Systemic contrast pass: white-on-`appAccent` fails 4.5:1 everywhere it's used as a filled button in dark mode; decide token policy (strong-fill variant vs lighter text) once, at the DesignSystem level.
- Composition restructure with SF Symbol anchor + 0-spacing VStack (included above; quick to code but changes the screen's visual identity, so treat as a reviewed design change).
