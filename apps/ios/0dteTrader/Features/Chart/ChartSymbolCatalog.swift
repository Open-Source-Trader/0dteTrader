import Foundation

/// Shared chart-market classification used by symbol selection and indicators.
/// The backend routes this exact set to Coinbase's continuous 24/7 feed.
enum ChartSymbolCatalog {
    static let cryptoSymbols = ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK", "LTC"]

    static func isContinuousMarket(_ symbol: String) -> Bool {
        cryptoSymbols.contains(symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased())
    }
}
