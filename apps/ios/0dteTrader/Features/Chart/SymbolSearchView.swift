import SwiftUI

/// Symbol search/switcher (PRD FR-9). The API has no search endpoint, so the
/// picker covers a curated watchlist plus arbitrary free-text symbols.
struct SymbolSearchView: View {
    let currentSymbol: String
    let onSelect: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    /// Comma-joined recent picks, most recent first (max 5).
    @AppStorage("recentSymbols") private var recentSymbolsRaw = ""

    private struct SymbolSection {
        let title: String
        let symbols: [String]
    }

    private static let sections: [SymbolSection] = [
        SymbolSection(title: "Indices & ETFs", symbols: ["SPY", "QQQ", "SPX", "IWM", "DIA", "VXX"]),
        // Live 24/7 data from Coinbase via the backend's crypto data source.
        SymbolSection(title: "Crypto", symbols: ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK", "LTC"]),
        SymbolSection(title: "Stocks", symbols: ["AAPL", "MSFT", "NVDA", "TSLA", "AMD", "AMZN", "META", "GOOGL", "AVGO", "SMCI"]),
    ]

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
        NavigationStack {
            List {
                if showsCustomSymbol {
                    Section {
                        Button {
                            select(normalizedQuery)
                        } label: {
                            Label("Use \"\(normalizedQuery)\"", systemImage: "arrow.right.circle")
                        }
                    }
                }
                if !normalizedQuery.isEmpty && !hasCatalogMatch {
                    ContentUnavailableView {
                        Label("No Matches", systemImage: "magnifyingglass")
                    } description: {
                        Text("No watchlist symbols match \"\(normalizedQuery)\". Tap above to load it anyway.")
                    }
                    .listRowBackground(Color.clear)
                }
                if let recentSection {
                    Section(recentSection.title) {
                        ForEach(recentSection.symbols, id: \.self) { symbol in
                            symbolRow(symbol)
                        }
                    }
                }
                ForEach(Self.sections, id: \.title) { section in
                    let symbols = filtered(section.symbols)
                    if !symbols.isEmpty {
                        Section(section.title) {
                            ForEach(symbols, id: \.self) { symbol in
                                symbolRow(symbol)
                            }
                        }
                    }
                }
            }
            .searchable(text: queryBinding, prompt: "Search symbols")
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .onSubmit(of: .search) {
                if let hit = topHit { select(hit) }
            }
            .navigationTitle("Symbol")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    private func symbolRow(_ symbol: String) -> some View {
        Button {
            select(symbol)
        } label: {
            HStack {
                Text(symbol)
                    .foregroundStyle(.primary)
                Spacer()
                if symbol == currentSymbol {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Color.appAccent)
                }
            }
        }
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
        dismiss()
    }
}
