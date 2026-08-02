import Foundation

/// Parses OCC-style option symbols (SPY260717C00503000) — the format broker
/// positions carry. CURR mode resolves holdings through this rather than the
/// loaded chain, so a leg on a not-yet-fetched expiration still shows up.
/// Mirrors the server's `parseOccSymbol` and the desktop's `occSymbol.ts`.
enum OccSymbol {
    struct Parsed: Equatable {
        let underlying: String
        /// YYYY-MM-DD.
        let expiration: String
        let optionType: OptionType
        let strike: Double
    }

    /// ROOT (1–6 uppercase letters or dots) + YYMMDD + C|P + 8-digit strike
    /// in thousandths. Anything else returns nil.
    static func parse(_ symbol: String) -> Parsed? {
        guard symbol.count >= 16 else { return nil }
        let strikeField = String(symbol.suffix(8))
        guard strikeField.allSatisfy(\.isNumber), let thousandths = Double(strikeField) else {
            return nil
        }
        let beforeStrike = symbol.dropLast(8)
        guard let typeCharacter = beforeStrike.last, typeCharacter == "C" || typeCharacter == "P"
        else { return nil }
        let beforeType = beforeStrike.dropLast()
        let ymd = String(beforeType.suffix(6))
        guard ymd.count == 6, ymd.allSatisfy(\.isNumber) else { return nil }
        let root = String(beforeType.dropLast(6))
        guard (1...6).contains(root.count),
              root.allSatisfy({ ($0.isUppercase && $0.isLetter) || $0 == "." })
        else { return nil }
        let year = ymd.prefix(2)
        let month = ymd.dropFirst(2).prefix(2)
        let day = ymd.suffix(2)
        return Parsed(
            underlying: root,
            expiration: "20\(year)-\(month)-\(day)",
            optionType: typeCharacter == "C" ? .call : .put,
            strike: thousandths / 1000
        )
    }
}
