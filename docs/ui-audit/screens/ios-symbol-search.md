# Screen i14: Symbol search sheet
- **App:** iOS (desktop clone audited as reference)
- **Location:** `apps/ios/0dteTrader/Features/Chart/SymbolSearchView.swift` (whole file, 92 lines; key refs: catalog L17–23, custom-symbol row L42–49, symbol rows L55–68, `.searchable` L74–76, select/haptics L87–91); desktop clone `apps/desktop/src/features/chart/SymbolSearchView.tsx` (catalog L11–20, inline-style search field L57–82, rows L100–114); tokens `apps/ios/0dteTrader/DesignSystem/AppColors.swift`, `AppTypography.swift`, `apps/desktop/src/design/tokens.css`
- **Visual:** screenshot `docs/ui-audit/shots/06-symbol-search.png` (desktop clone, verified pixels: 44pt rows, grouped-section header aligned to row text not card edge, appAccent checkmark, uppercased "SYMBOL" placeholder). iOS render: UNVERIFIED-VISUAL — no macOS/Xcode; iOS layout reconstructed from `List` + `.searchable` defaults (system grouped style, nav-drawer search bar, ~44pt rows).
- **Scores:** Composition 7/10 · Typography 6/10 · Color 8/10 · Density 4/10 · DataViz 2/10 · Motion 6/10 · States 4/10 · Platform 8/10 · A11y 5/10 · Consistency 6/10 → **Overall 56/100**
- **Score justifications:**
  - Composition 7 — pure system `List` + `.searchable` pattern: 16pt insets, ~44pt rows, grouped headers aligned to row text (verified in screenshot); nothing off-grid, nothing bespoke either.
  - Typography 6 — all system Dynamic Type styles (good scaling); but tickers render in default body weight with no tabular/monospaced treatment and no price typography because no prices exist (AppTypography's `priceMedium` unused here).
  - Color 8 — semantic tokens throughout (`.primary`, `Color.appAccent` L65, system grouped background); measured appAccent `#568ff7` on surface `#1a1c24` ≈ 5.3:1, clears WCAG 3:1 UI and 4.5:1 text.
  - Density 4 — rows are bare 3–5-char tickers; ~85% of each row is whitespace in a trading app where name/last/change is the expected payload.
  - DataViz 2 — zero data-viz: no sparkline, no last price, no change pill; the TradingView bar for a symbol picker is mini-quote rows.
  - Motion 6 — system sheet spring (good) + `Haptics.selection()` on select L88 (good); list filter updates are un-animated and there is no press-state feedback beyond List default.
  - States 4 — static catalog so no loading needed, but no designed empty-results copy, no invalid-symbol error, no offline/validation feedback; the "Use X" row silently accepts garbage.
  - Platform 8 — `.searchable`, autocapitalize/autocorrect-off (L75–76), inline nav title, Close button, haptic, 44pt rows, SF Symbols: textbook; misses `.onSubmit` top-hit selection and detents.
  - A11y 5 — Dynamic Type and full-row hit areas inherited from List; but current-symbol state is a color-tinted checkmark with no `.isSelected` trait, so VoiceOver reads "SPY" identically for selected and unselected rows.
  - Consistency 6 — iOS file itself is token-clean, but the 31-symbol catalog is hardcoded and duplicated verbatim in the desktop clone (SymbolSearchView.tsx:11–20), and the desktop clone bypasses tokens with inline `style={{}}`.

## Findings

### [P1] — Symbol rows carry zero market data (no name, last price, change, sparkline)
- **What/Why:** Each row is a bare ticker string (`Text(symbol)` L60) with a `Spacer` and an optional checkmark. Violates Information Density and DataViz: for a 0DTE app whose user is mid-trade, switching symbols blind (no last price, no % change, not even the instrument name — "MES" vs "ES" is meaningless to a newer user) is a Robinhood/TradingView-tier miss. Verified in the screenshot: ~85% of every row's width is empty surface.
- **Location:** `apps/ios/0dteTrader/Features/Chart/SymbolSearchView.swift:59-67`
- **Exact fix:** Replace the row label with a quote row. Add a `quote: (String) -> Quote?` lookup injected from `ChartViewModel` (or a lightweight `QuoteStore`), then:
  ```swift
  HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
          Text(symbol).font(.headline)
          Text(displayName(for: symbol))           // "S&P 500 ETF", "Micro E-mini S&P"
              .font(.caption).foregroundStyle(.secondary)
      }
      Spacer()
      if let q = quote(symbol) {
          VStack(alignment: .trailing, spacing: 2) {
              Text(q.last, format: .number.precision(.fractionLength(2)))
                  .font(.priceSmall)
              Text(q.changePercent, format: .percent.precision(.fractionLength(2)))
                  .font(.caption)
                  .foregroundStyle(q.changePercent >= 0 ? Color.pnlPositive : Color.pnlNegative)
          }
      }
      if symbol == currentSymbol {
          Image(systemName: "checkmark").foregroundStyle(Color.appAccent)
      }
  }
  ```
  Use `.priceSmall` (monospaced, tabular) for the last price per AppTypography.swift:8 and `pnlPositive`/`pnlNegative` (AppColors.swift:64–65) with an explicit `+`/`-` sign via the percent format so P/L is not color-only.

### [P1] — Arbitrary free-text symbol accepted with no validation, then fails silently downstream
- **What/Why:** `normalizedQuery` (L25–27) only uppercases and trims *leading/trailing* whitespace. "S P Y", "🚀🚀", or a 40-char string all produce a tappable "Use X" row; `onSelect` fires and the chart later shows a dead/empty state with no error attributed back to this sheet. Violates State Coverage (actionable errors) and is a real footgun in a money app.
- **Location:** `apps/ios/0dteTrader/Features/Chart/SymbolSearchView.swift:25-32, 42-49`
- **Exact fix:**
  ```swift
  private var normalizedQuery: String {
      query.uppercased()
          .components(separatedBy: .whitespaces).joined()          // kill internal spaces
          .filter { $0.isLetter || $0.isNumber }                   // ticker charset only
          .prefix(12).map(String.init).joined()                    // sane length cap
          .trimmingCharacters(in: .whitespaces)
  }
  ```
  and gate the row on validity:
  ```swift
  private var showsCustomSymbol: Bool {
      guard normalizedQuery.count >= 1 else { return false }
      return !Self.sections.contains { $0.symbols.contains(normalizedQuery) }
  }
  ```
  Bind the search text through a sanitizer (`onChange(of: query)`) so invalid characters never appear, rather than silently transforming on submit.

### [P1] — Current-symbol selection invisible to VoiceOver
- **What/Why:** Selection is communicated solely by a blue checkmark image (L63–66). VoiceOver reads every row identically ("SPY, button"), so a blind user cannot tell which symbol is active. Violates Accessibility (color/icon-independent meaning) and Platform Fidelity (`.isSelected` is the idiomatic trait).
- **Location:** `apps/ios/0dteTrader/Features/Chart/SymbolSearchView.swift:56-68`
- **Exact fix:** On the row `Button`, add:
  ```swift
  .accessibilityLabel(symbol)
  .accessibilityHint(symbol == currentSymbol ? "Currently selected" : "Double-tap to switch to \(symbol)")
  .accessibilityAddTraits(symbol == currentSymbol ? .isSelected : [])
  ```

### [P1] — 31-symbol catalog hardcoded in the view, duplicated verbatim across platforms
- **What/Why:** `SymbolSearchView.swift:17-23` and `apps/desktop/src/features/chart/SymbolSearchView.tsx:11-20` carry byte-identical hardcoded catalogs (same comments). Any symbol addition must be made twice and will drift. Violates Consistency; also a latent data-integrity bug since the catalog is product data living in presentation code.
- **Location:** `apps/ios/0dteTrader/Features/Chart/SymbolSearchView.swift:17-23`; `apps/desktop/src/features/chart/SymbolSearchView.tsx:11-20`
- **Exact fix:** Move the catalog to the shared layer: add `symbolCatalog` to `packages/shared-types` (or serve it from the API's existing config endpoint) and inject it as `let sections: [SymbolSection]` with the current arrays as `static let fallback` only. The view body needs zero other changes.

### [P2] — No Return-key top-hit selection on iOS; desktop clone diverges
- **What/Why:** On iOS, pressing Return on the keyboard does nothing (`.searchable` has no `.onSubmit`); the user must lift a finger and tap a row. The desktop clone *does* select on Enter (SymbolSearchView.tsx:77–79) — but it selects the raw query even when the top filtered match differs. Zero-friction bar: type → Return → chart switched. Violates Motion/Micro-interactions and Consistency.
- **Location:** `apps/ios/0dteTrader/Features/Chart/SymbolSearchView.swift:74-76`
- **Exact fix:** Compute the top hit and submit it:
  ```swift
  private var topHit: String? {
      if showsCustomSymbol { return normalizedQuery }
      return Self.sections.lazy.map { filtered($0.symbols).first }.compactMap { $0 }.first
  }
  // on the List:
  .onSubmit(of: .search) { if let hit = topHit { select(hit) } }
  ```
  Mirror the same top-hit logic in the desktop `onKeyDown` (SymbolSearchView.tsx:77) instead of `select(normalizedQuery)`.

### [P2] — No recents/favorites and current symbol buried mid-list
- **What/Why:** The sheet always renders the same static order; SPY (the current symbol in the screenshot) sits as row 1 only by luck of catalog order, and a user alternating ES↔SPY scrolls past 15 crypto rows every time. For a speed-critical switcher this is a composition/priority miss (primary target should be within the first thumb zone).
- **Location:** `apps/ios/0dteTrader/Features/Chart/SymbolSearchView.swift:17-23, 51-72`
- **Exact fix:** Prepend a computed "Recent" section backed by `@AppStorage("recentSymbols")`:
  ```swift
  private var recentSection: SymbolSection? {
      let recents = recentSymbols.filter { $0 != currentSymbol }.prefix(5)
      return recents.isEmpty ? nil : SymbolSection(title: "Recent", symbols: Array(recents))
  }
  ```
  render it first in the `ForEach`, and in `select(_:)` prepend the symbol to `recentSymbols` (deduped, capped at 5). Sort the active symbol to the top of its own section or pin it in "Recent" automatically.

### [P2] — Empty-results state is implicit and unexplained
- **What/Why:** When the query matches no catalog symbol, the UI collapses to a single "Use X" row with no "No matches" copy — and when the query *does* match catalog symbols, partially-matching sections render with no indication the list is filtered. Verified in code: L42–50 is the only non-catalog content. Violates State Coverage (designed empty states).
- **Location:** `apps/ios/0dteTrader/Features/Chart/SymbolSearchView.swift:41-50`
- **Exact fix:** Add an explicit state above the sections:
  ```swift
  if !normalizedQuery.isEmpty && Self.sections.allSatisfy({ filtered($0.symbols).isEmpty }) {
      ContentUnavailableView {
          Label("No Matches", systemImage: "magnifyingglass")
      } description: {
          Text("No watchlist symbols match \"\(normalizedQuery)\". Tap below to load it anyway.")
      }
      .listRowBackground(Color.clear)
  }
  ```
  (`ContentUnavailableView` is iOS 17-native — matches the deployment target.)

### [P2] — Desktop clone: token bypasses and off-grid inline values
- **What/Why:** `SymbolSearchView.tsx` hardcodes geometry that tokens already define: `height: 36` (L63, no token), `borderRadius: 10` (L66, duplicates `--radius-input` tokens.css:56), `gap: 6` (L62 — breaks the 4pt grid), `padding: '0 10px'` (L64 — 10px off 8pt grid), `padding: '4px 16px 8px'` (L57). Also `textTransform: 'uppercase'` on the `<input>` (L74) uppercases the *placeholder*, so the clone shows "SYMBOL" (verified in screenshot) while iOS shows title-case "Symbol" — a cross-platform divergence. Violates Consistency.
- **Location:** `apps/desktop/src/features/chart/SymbolSearchView.tsx:57-82`
- **Exact fix:** Replace inline values with tokens and normalize the placeholder: `gap: 8`, `padding: '0 12px'`, `borderRadius: 'var(--radius-input)'`, `height: 36` documented or tokenized as `--h-search-input: 36px`; keep `textTransform` but override the placeholder: `style={{ '::placeholder': { textTransform: 'none' } }}` via a CSS class (e.g. `.search-input::placeholder { text-transform: none; }` in components.css).

### [P3] — Search prompt duplicates the nav title
- **What/Why:** `navigationTitle("Symbol")` (L77) and `prompt: "Symbol"` (L74) put the same word on screen twice within 80pt. The prompt should describe the action.
- **Location:** `apps/ios/0dteTrader/Features/Chart/SymbolSearchView.swift:74,77`
- **Exact fix:** `.searchable(text: $query, prompt: "Search symbols")` (and desktop `placeholder="Search symbols"` at SymbolSearchView.tsx:71).

### [P3] — Semantically wrong icon on the "Use X" row
- **What/Why:** `systemImage: "text.cursor"` (L47) reads as a text-editing affordance, not "load this symbol". `plus.circle` (add custom) or `arrow.right.circle` (go) matches intent; SF Symbols guidance is that glyph meaning should be literal.
- **Location:** `apps/ios/0dteTrader/Features/Chart/SymbolSearchView.swift:47`
- **Exact fix:** `Label("Use \"\(normalizedQuery)\"", systemImage: "arrow.right.circle")` (mirror `ArrowRightCircleIcon` in the desktop clone, replacing `TextCursorIcon` at SymbolSearchView.tsx:89).

### [P3] — Full-height sheet with no detent for short result lists
- **What/Why:** The sheet is presented without `.presentationDetents` (TradeScreenView.swift:80–84), so a filtered 1–2-row result still occupies a full-screen sheet. A medium detent keeps the chart visible (context preservation — the user is checking a symbol, not leaving the chart).
- **Location:** `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift:80-84`
- **Exact fix:**
  ```swift
  .sheet(isPresented: $showSymbolSearch) {
      SymbolSearchView(currentSymbol: chartViewModel.symbol) { symbol in
          chartViewModel.selectSymbol(symbol)
      }
      .presentationDetents([.medium, .large])
      .presentationDragIndicator(.visible)
  }
  ```
  (Searchable forces the large detent while the field is focused — the system handles this gracefully.)

## Quick wins vs structural work
**<1 hour:**
- Add `.isSelected` trait + hint to rows (Finding 3).
- Input sanitization for `normalizedQuery` (Finding 2).
- `.onSubmit(of: .search)` top-hit selection (Finding 5).
- Prompt copy "Search symbols", `arrow.right.circle` icon, `.presentationDetents([.medium, .large])` (Findings 9–11).
- Desktop token/grid fixes + placeholder case fix (Finding 8).
- `ContentUnavailableView` empty state (Finding 7).

**Structural:**
- Quote-enriched rows: requires a `QuoteStore`/view-model feed of last price + change for ~31 symbols and a display-name map (Finding 1).
- Shared symbol catalog via `packages/shared-types` or API config endpoint consumed by both platforms (Finding 4).
- Recent-symbols persistence (`@AppStorage` + desktop equivalent storage) with cross-platform parity (Finding 6).
