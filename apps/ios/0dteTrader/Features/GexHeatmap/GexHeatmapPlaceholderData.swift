import Foundation

/// No gamma-exposure feed exists in the API yet (see packages/shared-types —
/// OptionsChain has no OI/gamma fields). Strikes are generated around the live
/// spot price so the sheet works for any symbol; exposure magnitudes are
/// synthetic placeholders (seeded by symbol) until a real GEX endpoint is
/// wired in, so switching the selected underlying visibly changes the data.
/// Desktop parity: apps/desktop/src/features/gexHeatmap/GexHeatmapModal.tsx.
enum GexHeatmapPlaceholderData {
    private static func hashSymbol(_ symbol: String) -> Int {
        var hash = 0
        for scalar in symbol.unicodeScalars {
            hash = (hash * 31 + Int(scalar.value)) % 97
        }
        return hash
    }

    static func buildEntries(symbol: String, spotPrice: Double, expirations: [String]) -> [GexHeatmapEntry] {
        var strikeStep = 0.5
        if spotPrice >= 200 { strikeStep = 5 }
        else if spotPrice >= 50 { strikeStep = 1 }
        let roundedSpot = (spotPrice / strikeStep).rounded() * strikeStep
        let offsets = Array(-20...20)
        let seed = hashSymbol(symbol)

        return offsets.map { offset in
            let strike = roundedSpot + Double(offset) * strikeStep
            let distance = abs(offset)
            let baseMagnitude = Swift.max(1, 60 - distance * 3 + (seed % 20))
            let cells = expirations.enumerated().map { expIndex, expiration -> GexHeatmapCell in
                let decay = 1.0 / Double(expIndex + 1)
                let sign: Double = (offset + expIndex + seed) % 3 == 0 ? -1 : 1
                let netGex = (sign * Double(baseMagnitude) * decay * 1_000_000 * Double(1 + distance % 3))
                    .rounded()
                return GexHeatmapCell(expiration: expiration, netGex: netGex)
            }
            return GexHeatmapEntry(strike: strike, cells: cells)
        }
    }
}
