import Foundation

/// Chart trading (order lines drawn directly on the candles). Mirrors the
/// desktop ChartTradingSettings.
struct ChartTradingSettings: Codable, Equatable, Sendable {
    /// Master switch for the order-line overlay.
    var enabled: Bool
    /// Futures-style bracketing: drag off a position's entry line to place its
    /// target and stop. Off means the entry line is read-only and lines are
    /// only placed from the long-press affordance.
    var bracketDrag: Bool
    /// Contracts a new line is created with.
    var defaultQuantity: Int

    /// Bounds for the per-line default size, shared by the settings stepper and
    /// `init(from:)`. They must be one constant: when decoding accepted more
    /// than the stepper could show, a stored value out of range armed a size the
    /// UI could neither display nor correct.
    static let defaultQuantityRange = 1...50

    static let `default` = ChartTradingSettings(
        enabled: true,
        bracketDrag: true,
        defaultQuantity: 1
    )

    /// Decoded defensively: a stored payload from an older build (or a corrupt
    /// one) must not arm a line with a quantity nobody chose.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled)
            ?? ChartTradingSettings.default.enabled
        bracketDrag = try container.decodeIfPresent(Bool.self, forKey: .bracketDrag)
            ?? ChartTradingSettings.default.bracketDrag
        let quantity = try container.decodeIfPresent(Int.self, forKey: .defaultQuantity)
            ?? ChartTradingSettings.default.defaultQuantity
        defaultQuantity = ChartTradingSettings.defaultQuantityRange.contains(quantity)
            ? quantity
            : ChartTradingSettings.default.defaultQuantity
    }

    init(enabled: Bool, bracketDrag: Bool, defaultQuantity: Int) {
        self.enabled = enabled
        self.bracketDrag = bracketDrag
        self.defaultQuantity = defaultQuantity
    }
}
