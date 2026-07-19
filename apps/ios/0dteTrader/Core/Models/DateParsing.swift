import Foundation

/// Lenient date helpers for the backend's JSON payloads.
/// Timestamps are ISO-8601 date-times (optionally with fractional seconds);
/// expirations are `yyyy-MM-dd` calendar dates which sort chronologically as plain strings.
enum DateParsing {
    private static let iso8601Fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso8601Plain = ISO8601DateFormatter()

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static let marketDayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        // Expirations are exchange-calendar dates: "today" for 0DTE logic is
        // a New York date, not the device-local one (a device ahead of ET
        // would otherwise skip the live 0DTE expiration).
        formatter.timeZone = TimeZone(identifier: "America/New_York")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// Parses an ISO-8601 date-time string, tolerating missing fractional seconds.
    static func dateTime(_ string: String) -> Date? {
        iso8601Fractional.date(from: string) ?? iso8601Plain.date(from: string)
    }

    /// Parses a `yyyy-MM-dd` date string.
    static func day(_ string: String) -> Date? {
        dayFormatter.date(from: string)
    }

    /// Formats a date as `yyyy-MM-dd`, comparable lexicographically with API expiration strings.
    static func dayString(from date: Date) -> String {
        dayFormatter.string(from: date)
    }

    /// Formats a date as `yyyy-MM-dd` in the US options market timezone.
    static func marketDayString(from date: Date) -> String {
        marketDayFormatter.string(from: date)
    }
}
