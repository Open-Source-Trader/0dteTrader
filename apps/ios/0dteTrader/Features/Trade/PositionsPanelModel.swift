import Foundation

/// One open-position row in the swipe-in positions panel, pre-formatted.
/// A pure value so the formatting and ordering are unit-testable without any
/// view in the loop; the view looks the live `Position` back up by `id` when
/// a button needs it.
struct PositionsPanelPositionRow: Equatable, Identifiable {
    /// The position's contract symbol.
    let id: String
    /// "500C 0DTE" (via EntryLineStyle) or the raw symbol when the chain
    /// cannot identify the contract.
    let label: String
    let quantity: String
    let entry: String
    let mark: String
    let pnl: String
    let pnlIsPositive: Bool
    /// A 1-lot has nothing to trim (half rounds down to zero).
    let canTrim: Bool
}

enum PositionsPanelRowBuilder {
    /// Open positions as display rows, most recently opened first
    /// (`openedAt` descending; positions without a record sort after those
    /// with one, then by symbol so the order is stable).
    static func positionRows(
        positions: [Position],
        contractResolver: (String) -> OptionContract?,
        today: Date = Date()
    ) -> [PositionsPanelPositionRow] {
        positions
            .filter { $0.quantity != 0 }
            .sorted { lhs, rhs in
                switch (lhs.openedAt, rhs.openedAt) {
                case let (left?, right?) where left != right:
                    return left > right
                case (_?, nil):
                    return true
                case (nil, _?):
                    return false
                default:
                    return lhs.symbol < rhs.symbol
                }
            }
            .map { position in
                let contract = contractResolver(position.symbol)
                return PositionsPanelPositionRow(
                    id: position.symbol,
                    label: contract.map { EntryLineStyle.label(for: $0, today: today) } ?? position.symbol,
                    quantity: Format.signedQuantity(position.quantity),
                    entry: Format.price(position.avgPrice),
                    mark: Format.price(position.markPrice),
                    pnl: Format.signedPrice(position.unrealizedPnl),
                    pnlIsPositive: position.unrealizedPnl >= 0,
                    canTrim: TradeViewModel.trimQuantity(position.quantity) > 0
                )
            }
    }
}
