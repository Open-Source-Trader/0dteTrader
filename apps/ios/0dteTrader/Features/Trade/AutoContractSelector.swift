import Foundation

/// AUTO contract selection (PRD FR-15/FR-16): anchor on the ATM strike — the
/// one nearest the underlying's last price, an exact tie resolving toward the
/// OTM side — then walk `otmOffset` strikes OTM (up for calls, down for puts).
/// Offset 0 trades the ATM strike itself; the default 1 keeps the classic
/// one-strike-out behaviour. Walking off the end of the ladder yields nil.
/// Expiration defaults to the nearest one (0DTE when available).
/// The server re-validates this selection at submission time (FR-20) with the
/// same ATM-anchored walk (`resolveAutoOtm`).
enum AutoContractSelector {
    static func selectAutoOTM(
        chain: OptionsChain,
        optionType: OptionType,
        expiration: String? = nil,
        last: Double? = nil,
        otmOffset: Int = 1,
        today: Date = Date()
    ) -> OptionContract? {
        let referencePrice = last ?? chain.underlyingPrice
        let targetExpiration = expiration ?? nearestExpiration(chain.expirations, today: today)

        let candidates = chain.contracts.filter { contract in
            contract.optionType == optionType
                && (targetExpiration == nil || contract.expiration == targetExpiration)
        }
        guard !candidates.isEmpty else { return nil }

        let ladder = Array(Set(candidates.map(\.strike))).sorted()
        let anchor = atmIndex(in: ladder, reference: referencePrice, optionType: optionType)
        let target = optionType == .call ? anchor + otmOffset : anchor - otmOffset
        guard ladder.indices.contains(target) else { return nil }
        let strike = ladder[target]
        return candidates.first { $0.strike == strike }
    }

    /// Index of the ATM anchor in the ascending strike ladder: nearest strike
    /// to `reference`, equidistant ties resolving toward the OTM side (higher
    /// for calls, lower for puts).
    private static func atmIndex(in ladder: [Double], reference: Double, optionType: OptionType) -> Int {
        var best = 0
        var bestDistance = Double.infinity
        for (index, strike) in ladder.enumerated() {
            let distance = abs(strike - reference)
            if distance < bestDistance {
                best = index
                bestDistance = distance
            } else if distance == bestDistance, optionType == .call {
                // The ladder ascends, so on a tie the later index is the
                // higher strike — the OTM side for a call. Puts keep the
                // earlier (lower) one already stored.
                best = index
            }
        }
        return best
    }

    /// Nearest expiration on or after `today`; falls back to the latest known
    /// expiration when every listed date is in the past. ISO `yyyy-MM-dd`
    /// strings sort chronologically, so plain string comparison is valid.
    /// `today` is the exchange-calendar (New York) date, not device-local.
    static func nearestExpiration(_ expirations: [String], today: Date = Date()) -> String? {
        let todayString = DateParsing.marketDayString(from: today)
        let valid = expirations.filter { DateParsing.day($0) != nil }
        guard !valid.isEmpty else { return nil }
        return valid.filter { $0 >= todayString }.min() ?? valid.max()
    }
}
