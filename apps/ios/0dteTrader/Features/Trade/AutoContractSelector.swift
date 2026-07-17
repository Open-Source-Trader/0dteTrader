import Foundation

/// AUTO contract selection (PRD FR-15/FR-16): pick the option +1 strike OTM
/// from the underlying's last price —
///   calls: lowest strike strictly above last;
///   puts:  highest strike strictly below last.
/// Expiration defaults to the nearest one (0DTE when available).
/// The server re-validates this selection at submission time (FR-20).
enum AutoContractSelector {
    static func selectAutoOTM(
        chain: OptionsChain,
        optionType: OptionType,
        expiration: String? = nil,
        last: Double? = nil,
        today: Date = Date()
    ) -> OptionContract? {
        let referencePrice = last ?? chain.underlyingPrice
        let targetExpiration = expiration ?? nearestExpiration(chain.expirations, today: today)

        let candidates = chain.contracts.filter { contract in
            contract.optionType == optionType
                && (targetExpiration == nil || contract.expiration == targetExpiration)
        }

        switch optionType {
        case .call:
            return candidates
                .filter { $0.strike > referencePrice }
                .min(by: { $0.strike < $1.strike })
        case .put:
            return candidates
                .filter { $0.strike < referencePrice }
                .max(by: { $0.strike < $1.strike })
        }
    }

    /// Nearest expiration on or after `today`; falls back to the latest known
    /// expiration when every listed date is in the past. ISO `yyyy-MM-dd`
    /// strings sort chronologically, so plain string comparison is valid.
    static func nearestExpiration(_ expirations: [String], today: Date = Date()) -> String? {
        let todayString = DateParsing.dayString(from: today)
        let valid = expirations.filter { DateParsing.day($0) != nil }
        guard !valid.isEmpty else { return nil }
        return valid.filter { $0 >= todayString }.min() ?? valid.max()
    }
}
