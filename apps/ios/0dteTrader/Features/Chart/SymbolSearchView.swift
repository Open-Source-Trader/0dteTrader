import SwiftUI

/// Symbol search/switcher (PRD FR-9). The API has no search endpoint, so the
/// picker covers a curated watchlist plus arbitrary free-text symbols.
struct SymbolSearchView: View {
    let currentSymbol: String
    let onSelect: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private struct SymbolSection {
        let title: String
        let symbols: [String]
    }

    private static let sections: [SymbolSection] = [
        SymbolSection(title: "Indices & ETFs", symbols: ["SPY", "QQQ", "SPX", "IWM", "DIA", "VXX"]),
        // Live 24/7 data from Coinbase via the backend's crypto data source.
        SymbolSection(title: "Crypto", symbols: ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK", "LTC"]),
        SymbolSection(title: "Futures Roots", symbols: ["MES", "ES", "MNQ", "NQ", "CL", "GC"]),
        SymbolSection(title: "Stocks", symbols: ["AAPL", "MSFT", "NVDA", "TSLA", "AMD", "AMZN", "META", "GOOGL", "AVGO", "SMCI"]),
    ]

    private var normalizedQuery: String {
        query.uppercased().trimmingCharacters(in: .whitespaces)
    }

    private var showsCustomSymbol: Bool {
        guard !normalizedQuery.isEmpty else { return false }
        return !Self.sections.contains { $0.symbols.contains(normalizedQuery) }
    }

    private func filtered(_ symbols: [String]) -> [String] {
        guard !normalizedQuery.isEmpty else { return symbols }
        return symbols.filter { $0.contains(normalizedQuery) }
    }

    var body: some View {
        NavigationStack {
            List {
                if showsCustomSymbol {
                    Section {
                        Button {
                            select(normalizedQuery)
                        } label: {
                            Label("Use \"\(normalizedQuery)\"", systemImage: "text.cursor")
                        }
                    }
                }
                ForEach(Self.sections, id: \.title) { section in
                    let symbols = filtered(section.symbols)
                    if !symbols.isEmpty {
                        Section(section.title) {
                            ForEach(symbols, id: \.self) { symbol in
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
                            }
                        }
                    }
                }
            }
            .searchable(text: $query, prompt: "Symbol")
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .navigationTitle("Symbol")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    private func select(_ symbol: String) {
        Haptics.selection()
        onSelect(symbol)
        dismiss()
    }
}
