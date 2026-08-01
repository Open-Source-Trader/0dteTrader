import Foundation

/// Lossless base+delta candle encoding, ported verbatim from iOS's
/// `AIAnalysisPromptBuilder.buildCandleTable`
/// (apps/ios/0dteTrader/Features/AIAnalysis/AIAnalysisModels.swift) so both
/// iOS and desktop send the model the same, already-shipped-and-tested
/// prompt format instead of drifting copies. The first candle is absolute
/// OHLCV; every following candle encodes open/high/low/close as signed
/// deltas from the *previous candle's close* — volume stays absolute since
/// deltas don't compress it well. Reconstruction is exact:
/// `close[n] = close[n-1] + delta`. This is strictly a text-formatting
/// concern: no trimming, no budget awareness, no knowledge of either
/// caller's snapshot type — that stays each side's own responsibility.
public enum CandleTableEncoder {
    /// - Parameters:
    ///   - bars: candles in chronological order (oldest first).
    ///   - interval: e.g. "5m" — included verbatim in the header line.
    ///   - startLabel: pre-formatted timestamp for the first bar (e.g.
    ///     "2026-08-01 09:30" in NY time) — formatting/timezone conversion
    ///     is the caller's concern, since it depends on each side's own
    ///     timestamp representation (iOS: `Date`; desktop: unix-seconds).
    public static func encode(_ bars: [CandleBar], interval: String, startLabel: String) -> String {
        guard !bars.isEmpty else { return "" }

        var lines: [String] = []
        lines.append(
            "CANDLES \(interval) start=\(startLabel) tz=NY " +
            "columns=open,high,low,close,volume encoding=b1-absolute-bars2plus-delta-from-previous-close"
        )

        var previousClose: Double?
        for (index, bar) in bars.enumerated() {
            if index == 0 {
                lines.append("B1: \(f(bar.open)),\(f(bar.high)),\(f(bar.low)),\(f(bar.close)),\(v(bar.volume))")
            } else {
                let base = previousClose ?? bar.close
                lines.append(
                    "B\(index + 1): \(sf(bar.open - base)),\(sf(bar.high - base))," +
                    "\(sf(bar.low - base)),\(sf(bar.close - base)),\(v(bar.volume))"
                )
            }
            previousClose = bar.close
        }

        return lines.joined(separator: "\n")
    }

    private static func f(_ value: Double) -> String {
        String(format: "%.2f", value)
    }

    private static func sf(_ value: Double) -> String {
        String(format: "%+.2f", value)
    }

    /// Volume renders without a fractional part when it's a whole number
    /// (the overwhelmingly common case for both callers) — matches iOS's
    /// original output, which printed `Int` volumes with no decimals.
    private static func v(_ value: Double) -> String {
        if value == value.rounded(), value.isFinite {
            return String(Int64(value))
        }
        return f(value)
    }
}
