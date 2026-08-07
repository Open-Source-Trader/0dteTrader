import Foundation

enum UsrMath {
    static func clamp(_ value: Double, _ minimum: Double, _ maximum: Double) -> Double {
        max(minimum, min(maximum, value))
    }

    static func quantizedPriceKey(_ price: Double, minimumTick: Double) -> String {
        // Pine math.round() resolves exact halves upward (toward +infinity),
        // unlike Swift's default toNearestOrAwayFromZero for negative values.
        let scaled = floor(price / minimumTick + 0.5)
        if scaled.isFinite, abs(scaled) <= 9_007_199_254_740_991 {
            return String(Int64(scaled))
        }
        // Use the quantized value, not the raw price, so identity continues to
        // reflect the minimum-tick equivalence relation outside Int64 range.
        // If division itself overflows, retain raw-price uniqueness explicitly.
        let overflowed = !scaled.isFinite
        let bits = String((overflowed ? price : scaled).bitPattern, radix: 16)
        let prefix = overflowed ? "price-bits" : "bits"
        return "\(prefix):\(String(repeating: "0", count: max(0, 16 - bits.count)))\(bits)"
    }

    static func trueRange(_ candle: Candle, _ previous: Candle?) -> Double {
        guard let previous else { return candle.high - candle.low }
        return max(candle.high - candle.low, abs(candle.high - previous.close), abs(candle.low - previous.close))
    }

    static func atr(_ candles: [Candle], length: Int = 14) -> [Double?] {
        var result = Array<Double?>(repeating: nil, count: candles.count)
        let ranges = candles.enumerated().map { trueRange($0.element, $0.offset > 0 ? candles[$0.offset - 1] : nil) }
        var seed = 0.0
        for index in ranges.indices {
            seed += ranges[index]
            if index == length - 1 {
                result[index] = seed / Double(length)
            } else if index >= length, let previous = result[index - 1] {
                result[index] = (previous * Double(length - 1) + ranges[index]) / Double(length)
            }
        }
        return result
    }

    static func mean(_ values: ArraySlice<Double>) -> Double {
        values.reduce(0, +) / Double(values.count)
    }

    static func deviation(_ values: ArraySlice<Double>, mean: Double) -> Double {
        sqrt(values.reduce(0) { $0 + pow($1 - mean, 2) } / Double(values.count))
    }

    static func volumeRatio(_ candle: UsrAnalysisCandle) -> Double {
        guard let mean = candle.volumeMean, mean > 0 else { return 0 }
        return candle.volume / mean
    }

    static func isVolumeAnomaly(_ candle: UsrAnalysisCandle, _ settings: UsrSettings) -> Bool {
        let ratio = volumeRatio(candle)
        let dispersionReady = (candle.volumeStd ?? 0) > 0
        let z = dispersionReady ? (candle.volume - (candle.volumeMean ?? 0)) / (candle.volumeStd ?? 1) : 0
        return ratio >= settings.minimumRelativeVolume && (!dispersionReady || z >= settings.minimumVolumeZScore)
    }

    static func displacement(_ candle: UsrAnalysisCandle, bullish: Bool, settings: UsrSettings) -> Bool {
        let range = max(candle.high - candle.low, settings.minimumTick)
        let body = abs(candle.close - candle.open)
        let direction = bullish ? candle.close > candle.open : candle.close < candle.open
        return direction
            && body / range * 100 >= settings.displacementBodyPercent
            && (candle.atr ?? 0) > 0
            && body >= (candle.atr ?? 0) * settings.displacementAtrMultiplier
    }

}
