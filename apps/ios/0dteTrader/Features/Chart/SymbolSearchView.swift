import SwiftUI

/// Symbol search/switcher (PRD FR-9). The API has no search endpoint, so the
/// picker covers a curated watchlist plus arbitrary free-text symbols.
///
/// A dropdown under the ticker chip rather than a half-height sheet. Every
/// capability the sheet had is still here — the search field, the curated
/// sections, the recents, the "use this ticker anyway" row — and it is the
/// search field that sets the width, so this is the one anchored popup that
/// does not shrink to its widest row.
struct SymbolSearchView: View {
    let currentSymbol: String
    let onSelect: (String) -> Void
    /// Closes the popup. The dropdown has no `dismiss` environment of its own:
    /// it is not presented by SwiftUI, it is drawn by `HudMenuLayer`.
    let onDismiss: () -> Void

    @State private var query = ""
    /// Comma-joined recent picks, most recent first (max 5).
    @AppStorage("recentSymbols") private var recentSymbolsRaw = ""

    private struct SymbolSection {
        let title: String
        let symbols: [String]
    }

    private static let sections: [SymbolSection] = [
        // SPX/NDX/VIX are index quotes from Tradier via the backend (not tradeable).
        SymbolSection(
            title: "Indices & ETFs",
            symbols: ["SPY", "QQQ", "SPX", "NDX", "VIX", "IWM", "DIA", "VXX"]
        ),
        // Live 24/7 data from Coinbase via the backend's crypto data source.
        SymbolSection(title: "Crypto", symbols: ChartSymbolCatalog.cryptoSymbols),
        SymbolSection(title: "Stocks", symbols: ["AAPL", "MSFT", "NVDA", "TSLA", "AMD", "AMZN", "META", "GOOGL", "AVGO", "SMCI"]),
    ]

    /// Wide enough to read a query back in, which is the floor a list of
    /// four-letter tickers would not have set on its own.
    private static let width: CGFloat = 240
    private static let rowHeight: CGFloat = 36
    /// Capped like the menus are, and for the same reason: the list scrolls, so
    /// a popup tall enough to reach the trade panel buys nothing and hides the
    /// chart it is being read against.
    private static let maxHeight: CGFloat = 380

    /// Ticker charset only: letters/digits, uppercased, no spaces, capped.
    private static func sanitize(_ raw: String) -> String {
        String(raw.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(12))
    }

    private var queryBinding: Binding<String> {
        Binding(
            get: { query },
            set: { query = Self.sanitize($0) }
        )
    }

    private var normalizedQuery: String { query }

    private var showsCustomSymbol: Bool {
        guard !normalizedQuery.isEmpty else { return false }
        return !Self.sections.contains { $0.symbols.contains(normalizedQuery) }
    }

    private func filtered(_ symbols: [String]) -> [String] {
        guard !normalizedQuery.isEmpty else { return symbols }
        return symbols.filter { $0.contains(normalizedQuery) }
    }

    private var recentSection: SymbolSection? {
        let recents = recentSymbolsRaw
            .split(separator: ",")
            .map(String.init)
            .filter { $0 != currentSymbol && filtered([$0]).count == 1 }
            .prefix(5)
        return recents.isEmpty ? nil : SymbolSection(title: "Recent", symbols: Array(recents))
    }

    /// What Return selects: the custom symbol if shown, else the top match.
    private var topHit: String? {
        guard !normalizedQuery.isEmpty else { return nil }
        if showsCustomSymbol { return normalizedQuery }
        for section in Self.sections {
            if let first = filtered(section.symbols).first { return first }
        }
        return nil
    }

    private var hasCatalogMatch: Bool {
        Self.sections.contains { !filtered($0.symbols).isEmpty }
    }

    var body: some View {
        VStack(spacing: 0) {
            searchField
            Rectangle()
                .fill(Color.hudStroke.opacity(0.18))
                .frame(height: 1)
            ScrollView {
                LazyVStack(spacing: 0) {
                    if showsCustomSymbol {
                        customSymbolRow
                    }
                    if !normalizedQuery.isEmpty && !hasCatalogMatch {
                        Text("No watchlist match. Tap above to load it anyway.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, AppSpacing.sm)
                            .padding(.vertical, AppSpacing.md)
                    }
                    if let recentSection {
                        section(recentSection)
                    }
                    ForEach(Self.sections, id: \.title) { section in
                        let symbols = filtered(section.symbols)
                        if !symbols.isEmpty {
                            self.section(SymbolSection(title: section.title, symbols: symbols))
                        }
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .frame(width: Self.width)
        .frame(maxHeight: Self.maxHeight, alignment: .top)
        .hudMenuPanel()
    }

    /// Not auto-focused. This popup opens under a chip in the top-left corner
    /// and the keyboard covers the bottom half of the screen; raising it before
    /// anyone has asked to type would hide the watchlist they came for.
    private var searchField: some View {
        HStack(spacing: AppSpacing.sm) {
            Image(systemName: "magnifyingglass")
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField("Search", text: queryBinding)
                .font(.system(.subheadline, design: .monospaced))
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit {
                    if let hit = topHit { select(hit) }
                }
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, AppSpacing.md)
        .frame(height: 44)
    }

    private var customSymbolRow: some View {
        Button {
            select(normalizedQuery)
        } label: {
            HStack(spacing: AppSpacing.xs) {
                Image(systemName: "arrow.right.circle")
                    .font(.caption)
                    .accessibilityHidden(true)
                Text("Use \"\(normalizedQuery)\"")
                    .font(.system(.subheadline, design: .monospaced).weight(.medium))
                    .lineLimit(1)
            }
            .foregroundStyle(Color.appAccent)
            .frame(maxWidth: .infinity)
            .frame(height: Self.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func section(_ section: SymbolSection) -> some View {
        VStack(spacing: 0) {
            Text(section.title.uppercased())
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .kerning(0.8)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.top, AppSpacing.sm)
                .padding(.bottom, AppSpacing.xs)
                .accessibilityAddTraits(.isHeader)
            ForEach(section.symbols, id: \.self) { symbol in
                symbolRow(symbol)
            }
        }
    }

    /// Centred, like every other anchored popup's rows, with the checkmark laid
    /// over the trailing end rather than laid out after the ticker.
    private func symbolRow(_ symbol: String) -> some View {
        Button {
            select(symbol)
        } label: {
            ZStack {
                Text(symbol)
                    .font(.system(.subheadline, design: .monospaced).weight(.medium))
                if symbol == currentSymbol {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.bold))
                        .accessibilityHidden(true)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            .foregroundStyle(symbol == currentSymbol ? Color.appAccent : .primary)
            .padding(.horizontal, AppSpacing.md)
            .frame(maxWidth: .infinity)
            .frame(height: Self.rowHeight)
            .contentShape(Rectangle())
            .background(symbol == currentSymbol ? Color.appAccent.opacity(0.12) : .clear)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(symbol)
        .accessibilityHint(symbol == currentSymbol ? "Currently selected" : "Double-tap to switch to \(symbol)")
        .accessibilityAddTraits(symbol == currentSymbol ? .isSelected : [])
    }

    private func select(_ symbol: String) {
        Haptics.selection()
        var recents = recentSymbolsRaw.split(separator: ",").map(String.init)
        recents.removeAll { $0 == symbol }
        recents.insert(symbol, at: 0)
        recentSymbolsRaw = recents.prefix(5).joined(separator: ",")
        onSelect(symbol)
        onDismiss()
    }
}
