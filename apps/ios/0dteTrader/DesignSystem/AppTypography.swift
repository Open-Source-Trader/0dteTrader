import SwiftUI

/// Typography helpers. Prices use monospaced digits so ticking quotes don't
/// shift layout; everything else uses Dynamic Type-friendly text styles.
extension Font {
    static let priceLarge = Font.system(.title3, design: .monospaced).weight(.semibold)
    static let priceMedium = Font.system(.body, design: .monospaced).weight(.medium)
    static let priceSmall = Font.system(.footnote, design: .monospaced)

    static let chipLabel = Font.system(.caption, design: .rounded).weight(.semibold)
    static let panelLabel = Font.subheadline
}
