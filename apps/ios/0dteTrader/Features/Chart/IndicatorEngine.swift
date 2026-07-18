import Foundation

struct MACDValues: Equatable, Sendable {
    let macdLine: [Double?]
    let signalLine: [Double?]
    let histogram: [Double?]
}

struct BollingerBands: Equatable, Sendable {
    let upper: [Double?]
    let middle: [Double?]
    let lower: [Double?]
}

struct StochasticValues: Equatable, Sendable {
    let k: [Double?]
    let d: [Double?]
}

/// Pure indicator math over `[Candle]` (ARCHITECTURE.md §4). No UI dependencies.
///
/// Every function returns an array aligned 1:1 with the input candles; indices
/// inside each indicator's warm-up window are `nil` so overlays can skip them.
enum IndicatorEngine {
    // MARK: - SMA

    static func sma(candles: [Candle], period: Int) -> [Double?] {
        sma(candles.map(\.close), period: period)
    }

    static func sma(_ values: [Double], period: Int) -> [Double?] {
        guard period > 0, values.count >= period else {
            return [Double?](repeating: nil, count: values.count)
        }
        var result = [Double?](repeating: nil, count: values.count)
        var windowSum = values[0..<period].reduce(0, +)
        result[period - 1] = windowSum / Double(period)
        guard values.count > period else { return result }
        for index in period..<values.count {
            windowSum += values[index] - values[index - period]
            result[index] = windowSum / Double(period)
        }
        return result
    }

    // MARK: - EMA
    // Seeded with the SMA of the first `period` values, then the standard
    // k = 2 / (period + 1) recursion.

    static func ema(candles: [Candle], period: Int) -> [Double?] {
        ema(candles.map(\.close), period: period)
    }

    static func ema(_ values: [Double], period: Int) -> [Double?] {
        guard period > 0, values.count >= period else {
            return [Double?](repeating: nil, count: values.count)
        }
        var result = [Double?](repeating: nil, count: values.count)
        let seed = values[0..<period].reduce(0, +) / Double(period)
        result[period - 1] = seed
        let multiplier = 2.0 / Double(period + 1)
        var previous = seed
        for index in period..<values.count {
            let value = values[index] * multiplier + previous * (1 - multiplier)
            result[index] = value
            previous = value
        }
        return result
    }

    // MARK: - VWAP
    // Cumulative (typical price × volume) / cumulative volume over the loaded
    // candle set; load an intraday range to get the standard session VWAP.

    static func vwap(candles: [Candle]) -> [Double?] {
        var result = [Double?](repeating: nil, count: candles.count)
        var cumulativePV = 0.0
        var cumulativeVolume = 0.0
        for (index, candle) in candles.enumerated() {
            let typicalPrice = (candle.high + candle.low + candle.close) / 3.0
            cumulativePV += typicalPrice * Double(candle.volume)
            cumulativeVolume += Double(candle.volume)
            if cumulativeVolume > 0 {
                result[index] = cumulativePV / cumulativeVolume
            }
        }
        return result
    }

    // MARK: - RSI (Wilder's smoothing)

    static func rsi(candles: [Candle], period: Int = 14) -> [Double?] {
        let closes = candles.map(\.close)
        guard period > 0, closes.count > period else {
            return [Double?](repeating: nil, count: closes.count)
        }
        var result = [Double?](repeating: nil, count: closes.count)

        var avgGain = 0.0
        var avgLoss = 0.0
        for index in 1...period {
            let change = closes[index] - closes[index - 1]
            if change > 0 {
                avgGain += change
            } else {
                avgLoss += -change
            }
        }
        avgGain /= Double(period)
        avgLoss /= Double(period)
        result[period] = rsiValue(avgGain: avgGain, avgLoss: avgLoss)

        guard closes.count > period + 1 else { return result }
        for index in (period + 1)..<closes.count {
            let change = closes[index] - closes[index - 1]
            avgGain = (avgGain * Double(period - 1) + max(change, 0)) / Double(period)
            avgLoss = (avgLoss * Double(period - 1) + max(-change, 0)) / Double(period)
            result[index] = rsiValue(avgGain: avgGain, avgLoss: avgLoss)
        }
        return result
    }

    private static func rsiValue(avgGain: Double, avgLoss: Double) -> Double {
        if avgLoss == 0 {
            return avgGain == 0 ? 50 : 100
        }
        let relativeStrength = avgGain / avgLoss
        return 100 - 100 / (1 + relativeStrength)
    }

    // MARK: - MACD (12, 26, 9 by default)

    static func macd(
        candles: [Candle],
        fastPeriod: Int = 12,
        slowPeriod: Int = 26,
        signalPeriod: Int = 9
    ) -> MACDValues {
        let closes = candles.map(\.close)
        let fast = ema(closes, period: fastPeriod)
        let slow = ema(closes, period: slowPeriod)

        var macdLine = [Double?](repeating: nil, count: closes.count)
        var macdPoints: [(index: Int, value: Double)] = []
        for index in 0..<closes.count {
            if let fastValue = fast[index], let slowValue = slow[index] {
                let value = fastValue - slowValue
                macdLine[index] = value
                macdPoints.append((index: index, value: value))
            }
        }

        var signalLine = [Double?](repeating: nil, count: closes.count)
        var histogram = [Double?](repeating: nil, count: closes.count)
        guard signalPeriod > 0, macdPoints.count >= signalPeriod else {
            return MACDValues(macdLine: macdLine, signalLine: signalLine, histogram: histogram)
        }

        let seed = macdPoints[0..<signalPeriod].map { $0.value }.reduce(0, +) / Double(signalPeriod)
        let seedIndex = macdPoints[signalPeriod - 1].index
        signalLine[seedIndex] = seed
        if let macdValue = macdLine[seedIndex] {
            histogram[seedIndex] = macdValue - seed
        }

        let multiplier = 2.0 / Double(signalPeriod + 1)
        var previous = seed
        for pointIndex in signalPeriod..<macdPoints.count {
            let point = macdPoints[pointIndex]
            let signal = point.value * multiplier + previous * (1 - multiplier)
            signalLine[point.index] = signal
            histogram[point.index] = point.value - signal
            previous = signal
        }
        return MACDValues(macdLine: macdLine, signalLine: signalLine, histogram: histogram)
    }

    // MARK: - Stochastic (%K smoothed by SMA, %D = SMA of %K)

    static func stochastic(
        candles: [Candle],
        kPeriod: Int = 14,
        kSmooth: Int = 3,
        dPeriod: Int = 3
    ) -> StochasticValues {
        var raw = [Double?](repeating: nil, count: candles.count)
        if kPeriod > 0, candles.count >= kPeriod {
            for index in (kPeriod - 1)..<candles.count {
                let window = candles[(index - kPeriod + 1)...index]
                let highest = window.map(\.high).max() ?? 0
                let lowest = window.map(\.low).min() ?? 0
                let range = highest - lowest
                raw[index] = range == 0 ? 50 : (candles[index].close - lowest) / range * 100
            }
        }
        let kLine = smaNullable(raw, period: kSmooth)
        let dLine = smaNullable(kLine, period: dPeriod)
        return StochasticValues(k: kLine, d: dLine)
    }

    /// SMA over a nullable series: smooths the contiguous non-nil tail.
    private static func smaNullable(_ values: [Double?], period: Int) -> [Double?] {
        var result = [Double?](repeating: nil, count: values.count)
        var points: [(index: Int, value: Double)] = []
        for (index, value) in values.enumerated() {
            if let value {
                points.append((index, value))
            }
        }
        guard period > 0, points.count >= period else { return result }
        var windowSum = 0.0
        for position in 0..<points.count {
            windowSum += points[position].value
            if position >= period {
                windowSum -= points[position - period].value
            }
            if position >= period - 1 {
                result[points[position].index] = windowSum / Double(period)
            }
        }
        return result
    }

    // MARK: - ATR (Wilder's smoothing)

    static func atr(candles: [Candle], period: Int = 14) -> [Double?] {
        var result = [Double?](repeating: nil, count: candles.count)
        guard period > 0, candles.count > period else { return result }
        var trueRanges = [Double](repeating: 0, count: candles.count)
        for (index, candle) in candles.enumerated() {
            if index == 0 {
                trueRanges[index] = candle.high - candle.low
            } else {
                let previousClose = candles[index - 1].close
                trueRanges[index] = max(
                    candle.high - candle.low,
                    max(abs(candle.high - previousClose), abs(candle.low - previousClose))
                )
            }
        }
        var value = trueRanges[1...period].reduce(0, +) / Double(period)
        result[period] = value
        guard candles.count > period + 1 else { return result }
        for index in (period + 1)..<candles.count {
            value = (value * Double(period - 1) + trueRanges[index]) / Double(period)
            result[index] = value
        }
        return result
    }

    // MARK: - Bollinger Bands (20, 2 by default), population standard deviation

    static func bollingerBands(
        candles: [Candle],
        period: Int = 20,
        multiplier: Double = 2
    ) -> BollingerBands {
        let closes = candles.map(\.close)
        var upper = [Double?](repeating: nil, count: closes.count)
        var middle = [Double?](repeating: nil, count: closes.count)
        var lower = [Double?](repeating: nil, count: closes.count)
        guard period > 0, closes.count >= period else {
            return BollingerBands(upper: upper, middle: middle, lower: lower)
        }
        for index in (period - 1)..<closes.count {
            let window = closes[(index - period + 1)...index]
            let mean = window.reduce(0, +) / Double(period)
            let variance = window.map { ($0 - mean) * ($0 - mean) }.reduce(0, +) / Double(period)
            let standardDeviation = variance.squareRoot()
            middle[index] = mean
            upper[index] = mean + multiplier * standardDeviation
            lower[index] = mean - multiplier * standardDeviation
        }
        return BollingerBands(upper: upper, middle: middle, lower: lower)
    }
}
