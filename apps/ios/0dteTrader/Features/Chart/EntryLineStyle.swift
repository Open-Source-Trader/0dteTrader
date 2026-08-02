import UIKit

/// How a position's entry line is labelled and stroked.
///
/// The stroke says WHAT the line is — a call rides the accent blue, a put the
/// red — while profit/loss colouring stays on the P/L pill alone, so a winning
/// put no longer paints its whole line green nor a losing call red. One
/// decision function each, shared by the overlay and (for the label) the
/// positions panel.
enum EntryLineStyle {
    /// Entry-line stroke: calls `.appAccent`, puts `.appPnlNegative`.
    static func strokeColor(for optionType: OptionType) -> UIColor {
        optionType == .call ? .appAccent : .appPnlNegative
    }

    /// Expirations are exchange-calendar dates; format them in New York time
    /// (a device west of ET would otherwise print the previous day) with a
    /// fixed locale so "Aug 8" is "Aug 8" everywhere.
    private static let expirationDayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "America/New_York")
        formatter.dateFormat = "MMM d"
        return formatter
    }()

    /// Leading label pill: "500C 0DTE" / "500P Aug 8" — which contract the
    /// line belongs to, with 0DTE spelled out on expiration day (New York
    /// calendar, like the panel's expiration chip).
    static func label(for contract: OptionContract, today: Date = Date()) -> String {
        let leg = "\(Format.strike(contract.strike))\(contract.optionType.shortName)"
        if contract.expiration == DateParsing.marketDayString(from: today) {
            return "\(leg) 0DTE"
        }
        guard let day = DateParsing.day(contract.expiration) else {
            // An unparseable expiration is shown as it came rather than hidden.
            return "\(leg) \(contract.expiration)"
        }
        return "\(leg) \(expirationDayFormatter.string(from: day))"
    }
}
