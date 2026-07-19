import SwiftUI

/// Typography helpers. Prices use JetBrains Mono so ticking quotes don't
/// shift layout; labels use Rajdhani and display text Orbitron (the bundled
/// HUD fonts — see Resources/Fonts + UIAppFonts in project.yml). All tokens
/// stay Dynamic Type-friendly via `relativeTo`.
extension Font {
    static let priceLarge = Font.custom("JetBrainsMono-SemiBold", size: 20, relativeTo: .title3)
    static let priceMedium = Font.custom("JetBrainsMono-Regular", size: 17, relativeTo: .body)
    static let priceSmall = Font.custom("JetBrainsMono-Regular", size: 13, relativeTo: .footnote)

    static let chipLabel = Font.custom("Rajdhani-SemiBold", size: 12, relativeTo: .caption)
    static let panelLabel = Font.custom("Rajdhani-Medium", size: 15, relativeTo: .subheadline)

    static let hudTitle = Font.custom("Orbitron-Bold", size: 20, relativeTo: .title3)
    static let hudButton = Font.custom("Orbitron-Medium", size: 16, relativeTo: .headline)
}
