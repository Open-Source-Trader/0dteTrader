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
    /// Whether Flatten/Trim can build a close order for this row — the leg
    /// resolved through the chain or its own OCC symbol. False only for a
    /// symbol in neither form, whose close the app cannot construct.
    let actionable: Bool
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
                // Chain contract when loaded, else the OCC symbol names the
                // leg — either way the row can be labelled and closed.
                let contract = contractResolver(position.symbol)
                    ?? OccSymbol.parse(position.symbol).map { parsed in
                        OptionContract(
                            symbol: position.symbol,
                            underlying: parsed.underlying,
                            expiration: parsed.expiration,
                            strike: parsed.strike,
                            optionType: parsed.optionType,
                            bid: 0,
                            ask: 0,
                            last: 0
                        )
                    }
                return PositionsPanelPositionRow(
                    id: position.symbol,
                    label: contract.map { EntryLineStyle.label(for: $0, today: today) } ?? position.symbol,
                    quantity: Format.signedQuantity(position.quantity),
                    entry: Format.price(position.avgPrice),
                    mark: Format.price(position.markPrice),
                    pnl: Format.signedPrice(position.unrealizedPnl),
                    pnlIsPositive: position.unrealizedPnl >= 0,
                    canTrim: TradeViewModel.trimQuantity(position.quantity) > 0,
                    actionable: contract != nil
                )
            }
    }
}
