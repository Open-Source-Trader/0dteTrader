import Foundation

/// Known tradable futures roots.
enum FuturesRoots {
    static let known: [String] = ["MES", "ES", "MNQ", "NQ", "CL", "GC"]

    static let fallback = "MES"

    /// Derives a futures root from a chart symbol or contract symbol
    /// (e.g. "MES" → "MES", "MESU26" → "MES"). Longest prefixes first.
    static func root(for symbol: String) -> String? {
        let uppercased = symbol.uppercased()
        return known
            .sorted { $0.count > $1.count }
            .first { uppercased.hasPrefix($0) }
    }
}
