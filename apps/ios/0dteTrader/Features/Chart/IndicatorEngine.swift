import Foundation

// Registry dispatch and its pure math helpers intentionally live together so
// parity behavior can be reviewed as one unit.
// swiftlint:disable file_length

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
    typealias L2Executor = @Sendable (OrderBookIndicatorsDTO) -> [String: Double?]

    static let l2Executors: [String: L2Executor] = [
        "spread": { indicators in
            [
                "absolute": indicators.spreadAbs,
                "bps": indicators.spreadBps,
                "percentile": indicators.spreadPercentile,
            ]
        },
        "top_book_imbalance": { ["value": $0.topBookImbalance] },
        "tick_pressure": { ["value": $0.tickPressure] },
        "depth_imbalance": { ["value": $0.depthImbalance] },
        "cumulative_pressure": { ["value": $0.cumulativePressure] },
        "touch_depletion": { ["value": $0.touchDepletion] },
    ]

    static var registeredL2IndicatorIds: Set<String> {
        Set(l2Executors.keys)
    }
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
            // Monotonic deques of indices give the trailing window's high/low
            // in amortized O(1) per bar instead of rescanning the last
            // `kPeriod` bars.
            var highDeque: [Int] = []
            var lowDeque: [Int] = []
            for index in 0..<candles.count {
                while let last = highDeque.last, candles[last].high <= candles[index].high {
                    highDeque.removeLast()
                }
                highDeque.append(index)
                while let last = lowDeque.last, candles[last].low >= candles[index].low {
                    lowDeque.removeLast()
                }
                lowDeque.append(index)

                let windowStart = index - kPeriod + 1
                if highDeque[0] < windowStart { highDeque.removeFirst() }
                if lowDeque[0] < windowStart { lowDeque.removeFirst() }

                if index >= kPeriod - 1 {
                    let highest = candles[highDeque[0]].high
                    let lowest = candles[lowDeque[0]].low
                    let range = highest - lowest
                    raw[index] = range == 0 ? 50 : (candles[index].close - lowest) / range * 100
                }
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
        // Rolling sum/sum-of-squares: var = E[x^2] - E[x]^2, updated in O(1)
        // per bar instead of re-slicing and re-scanning the trailing window.
        var sum = 0.0
        var sumSquares = 0.0
        for index in 0..<period {
            sum += closes[index]
            sumSquares += closes[index] * closes[index]
        }
        for index in (period - 1)..<closes.count {
            if index >= period {
                let dropped = closes[index - period]
                sum += closes[index] - dropped
                sumSquares += closes[index] * closes[index] - dropped * dropped
            }
            let mean = sum / Double(period)
            let variance = max(0, sumSquares / Double(period) - mean * mean)
            let standardDeviation = variance.squareRoot()
            middle[index] = mean
            upper[index] = mean + multiplier * standardDeviation
            lower[index] = mean - multiplier * standardDeviation
        }
        return BollingerBands(upper: upper, middle: middle, lower: lower)
    }

    // MARK: - Registry-driven geometry

    private typealias CandleExecutor = (
        _ descriptor: IndicatorDescriptor,
        _ candles: [Candle],
        _ parameters: [String: Double]
    ) -> IndicatorGeometry

    private static let candleExecutors: [String: CandleExecutor] = [
        "sma": { descriptor, candles, parameters in
            seriesGeometry(descriptor, [
                "value": sma(candles: candles, period: integer(parameters, "period")),
            ])
        },
        "ema": { descriptor, candles, parameters in
            seriesGeometry(descriptor, [
                "value": ema(candles: candles, period: integer(parameters, "period")),
            ])
        },
        "rsi": { descriptor, candles, parameters in
            seriesGeometry(descriptor, [
                "value": rsi(candles: candles, period: integer(parameters, "period")),
            ])
        },
        "macd": { descriptor, candles, parameters in
            let values = macd(
                candles: candles,
                fastPeriod: integer(parameters, "fastPeriod"),
                slowPeriod: integer(parameters, "slowPeriod"),
                signalPeriod: integer(parameters, "signalPeriod")
            )
            return seriesGeometry(descriptor, [
                "macd": values.macdLine,
                "signal": values.signalLine,
                "histogram": values.histogram,
            ])
        },
        "bollinger": { descriptor, candles, parameters in
            let values = bollingerBands(
                candles: candles,
                period: integer(parameters, "period"),
                multiplier: parameters["multiplier"] ?? 0
            )
            return seriesGeometry(descriptor, [
                "upper": values.upper,
                "middle": values.middle,
                "lower": values.lower,
            ])
        },
        "stochastic": { descriptor, candles, parameters in
            let values = stochastic(
                candles: candles,
                kPeriod: integer(parameters, "kPeriod"),
                kSmooth: integer(parameters, "kSmooth"),
                dPeriod: integer(parameters, "dPeriod")
            )
            return seriesGeometry(descriptor, ["k": values.k, "d": values.d])
        },
        "atr": { descriptor, candles, parameters in
            seriesGeometry(descriptor, [
                "value": atrIncludingFirst(candles: candles, period: integer(parameters, "period")),
            ])
        },
        "anchored_vwap": { descriptor, candles, parameters in
            seriesGeometry(descriptor, [
                "value": anchoredVwap(
                    candles: candles,
                    anchorTimestamp: parameters["anchorTimestamp"] ?? 0
                ),
            ])
        },
        "supertrend": { descriptor, candles, parameters in
            seriesGeometry(descriptor, supertrend(
                candles: candles,
                atrPeriod: integer(parameters, "atrPeriod"),
                multiplier: parameters["multiplier"] ?? 0
            ))
        },
        "keltner": { descriptor, candles, parameters in
            seriesGeometry(descriptor, keltner(
                candles: candles,
                emaPeriod: integer(parameters, "emaPeriod"),
                atrPeriod: integer(parameters, "atrPeriod"),
                multiplier: parameters["multiplier"] ?? 0
            ))
        },
        "vpvr": { descriptor, candles, parameters in
            IndicatorGeometry(
                indicatorId: descriptor.id,
                kind: descriptor.geometry.kind,
                series: [:],
                rows: volumeProfile(
                    candles: candles,
                    rowCount: integer(parameters, "rowCount"),
                    valueAreaPercent: parameters["valueAreaPercent"] ?? 0
                ),
                unavailableReason: nil
            )
        },
        "adx_dmi": { descriptor, candles, parameters in
            seriesGeometry(descriptor, adxDmi(
                candles: candles,
                period: integer(parameters, "period")
            ))
        },
        "obv": { descriptor, candles, _ in
            seriesGeometry(descriptor, ["value": obv(candles: candles)])
        },
        "cci": { descriptor, candles, parameters in
            seriesGeometry(descriptor, [
                "value": cci(candles: candles, period: integer(parameters, "period")),
            ])
        },
        "williams_r": { descriptor, candles, parameters in
            seriesGeometry(descriptor, [
                "value": williamsR(candles: candles, period: integer(parameters, "period")),
            ])
        },
        "ichimoku": { descriptor, candles, parameters in
            seriesGeometry(descriptor, ichimoku(
                candles: candles,
                conversionPeriod: integer(parameters, "conversionPeriod"),
                basePeriod: integer(parameters, "basePeriod"),
                spanBPeriod: integer(parameters, "spanBPeriod"),
                displacement: integer(parameters, "displacement")
            ))
        },
    ]

    static var registeredCandleIndicatorIds: Set<String> {
        Set(candleExecutors.keys)
    }

    static func compute(
        indicatorId: String,
        candles: [Candle],
        parameters: [String: Double],
        registry: IndicatorRegistry,
        l2Indicators: OrderBookIndicatorsDTO? = nil,
        l2UnavailableReason: String = "No L2 data"
    ) throws -> IndicatorGeometry {
        guard let descriptor = registry.descriptor(id: indicatorId) else {
            throw IndicatorSettingsValidationError.invalid("Unknown indicator \(indicatorId).")
        }
        var validationState = try IndicatorSettingsState.defaults(for: registry)
        validationState.indicators[indicatorId] = IndicatorSetting(enabled: true, parameters: parameters)
        try IndicatorSettingsValidator.validate(validationState, registry: registry)
        if descriptor.requiresL2 {
            guard let l2Indicators else {
                return .unavailable(descriptor: descriptor, reason: l2UnavailableReason)
            }
            guard let executor = l2Executors[indicatorId] else {
                throw IndicatorSettingsValidationError.invalid(
                    "\(indicatorId) has no L2 geometry engine."
                )
            }
            let current = executor(l2Indicators)
            let series = Dictionary(uniqueKeysWithValues: current.map { id, value in
                var values = [Double?](repeating: nil, count: candles.count)
                if !values.isEmpty { values[values.count - 1] = value }
                return (id, values)
            })
            let geometry = IndicatorGeometry(
                indicatorId: descriptor.id,
                kind: descriptor.geometry.kind,
                series: series,
                rows: [],
                unavailableReason: nil
            )
            try validateGeometry(geometry, descriptor: descriptor, candleCount: candles.count)
            return geometry
        }
        try validateCandles(candles, indicatorId: indicatorId)
        guard let executor = candleExecutors[indicatorId] else {
            throw IndicatorSettingsValidationError.invalid("\(indicatorId) has no candle geometry engine.")
        }
        let geometry = executor(descriptor, candles, parameters)
        try validateGeometry(geometry, descriptor: descriptor, candleCount: candles.count)
        return geometry
    }

    static func validateGeometry(
        _ geometry: IndicatorGeometry,
        descriptor: IndicatorDescriptor,
        candleCount: Int
    ) throws {
        guard geometry.indicatorId == descriptor.id,
              geometry.kind == descriptor.geometry.kind
        else {
            throw IndicatorSettingsValidationError.invalid(
                "\(descriptor.id) produced geometry with the wrong identity or kind."
            )
        }
        if geometry.unavailableReason != nil {
            guard geometry.series.isEmpty, geometry.rows.isEmpty else {
                throw IndicatorSettingsValidationError.invalid(
                    "\(descriptor.id) produced data while unavailable."
                )
            }
            return
        }
        if geometry.kind == .priceProfile {
            guard geometry.series.isEmpty else {
                throw IndicatorSettingsValidationError.invalid(
                    "\(descriptor.id) produced unexpected price-profile series."
                )
            }
            for row in geometry.rows {
                guard row.low.isFinite,
                      row.high.isFinite,
                      row.volume.isFinite,
                      row.low <= row.high,
                      row.volume >= 0
                else {
                    throw IndicatorSettingsValidationError.invalid(
                        "\(descriptor.id) produced an invalid price-profile row."
                    )
                }
            }
            for (previous, current) in zip(geometry.rows, geometry.rows.dropFirst()) {
                guard previous.high <= current.low else {
                    throw IndicatorSettingsValidationError.invalid(
                        "\(descriptor.id) price-profile rows must be ordered and non-overlapping."
                    )
                }
            }
            return
        }

        let expectedKeys = Set(descriptor.geometry.series.map(\.id))
        guard Set(geometry.series.keys) == expectedKeys, geometry.rows.isEmpty else {
            throw IndicatorSettingsValidationError.invalid(
                "\(descriptor.id) output does not match its descriptor."
            )
        }
        for values in geometry.series.values {
            guard values.count == candleCount,
                  values.compactMap({ $0 }).allSatisfy(\.isFinite)
            else {
                throw IndicatorSettingsValidationError.invalid(
                    "\(descriptor.id) produced an invalid or misaligned series."
                )
            }
        }
    }

    private static func integer(_ parameters: [String: Double], _ id: String) -> Int {
        Int(parameters[id] ?? 0)
    }

    private static func validateCandles(_ candles: [Candle], indicatorId: String) throws {
        for candle in candles {
            let values = [
                candle.time.timeIntervalSince1970,
                candle.open,
                candle.high,
                candle.low,
                candle.close,
                candle.volume,
            ]
            guard values.allSatisfy(\.isFinite), candle.volume >= 0 else {
                throw IndicatorSettingsValidationError.invalid(
                    "\(indicatorId) received non-finite or negative candle data."
                )
            }
            guard candle.low <= candle.high,
                  candle.low <= candle.open,
                  candle.low <= candle.close,
                  candle.high >= candle.open,
                  candle.high >= candle.close
            else {
                throw IndicatorSettingsValidationError.invalid(
                    "\(indicatorId) received invalid OHLC candle data."
                )
            }
        }
        for (previous, current) in zip(candles, candles.dropFirst()) {
            guard current.time > previous.time else {
                throw IndicatorSettingsValidationError.invalid(
                    "\(indicatorId) candle timestamps must be strictly increasing."
                )
            }
        }
    }

    private static func seriesGeometry(
        _ descriptor: IndicatorDescriptor,
        _ series: [String: [Double?]]
    ) -> IndicatorGeometry {
        IndicatorGeometry(
            indicatorId: descriptor.id,
            kind: descriptor.geometry.kind,
            series: series,
            rows: [],
            unavailableReason: nil
        )
    }

    private static func anchoredVwap(candles: [Candle], anchorTimestamp: Double) -> [Double?] {
        let firstIndex: Int
        if anchorTimestamp == 0 {
            guard let latest = candles.last else { return [] }
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .current
            firstIndex = candles.firstIndex {
                calendar.isDate($0.time, inSameDayAs: latest.time)
            } ?? candles.count
        } else if let index = candles.firstIndex(where: {
            $0.time.timeIntervalSince1970 * 1_000 >= anchorTimestamp
        }) {
            firstIndex = index
        } else {
            return [Double?](repeating: nil, count: candles.count)
        }
        var result = [Double?](repeating: nil, count: candles.count)
        var cumulativePriceVolume = 0.0
        var cumulativeVolume = 0.0
        for index in firstIndex..<candles.count {
            let candle = candles[index]
            let volume = Double(candle.volume)
            cumulativePriceVolume += (candle.high + candle.low + candle.close) / 3 * volume
            cumulativeVolume += volume
            if cumulativeVolume > 0 { result[index] = cumulativePriceVolume / cumulativeVolume }
        }
        return result
    }

    private static func trueRanges(_ candles: [Candle]) -> [Double] {
        candles.enumerated().map { index, candle in
            guard index > 0 else { return candle.high - candle.low }
            let previousClose = candles[index - 1].close
            return max(candle.high - candle.low, max(abs(candle.high - previousClose), abs(candle.low - previousClose)))
        }
    }

    private static func atrIncludingFirst(candles: [Candle], period: Int) -> [Double?] {
        let ranges = trueRanges(candles)
        guard period > 0, ranges.count >= period else {
            return [Double?](repeating: nil, count: candles.count)
        }
        var result = [Double?](repeating: nil, count: candles.count)
        var value = ranges[0..<period].reduce(0, +) / Double(period)
        result[period - 1] = value
        for index in period..<ranges.count {
            value = (value * Double(period - 1) + ranges[index]) / Double(period)
            result[index] = value
        }
        return result
    }

    private static func supertrend(
        candles: [Candle],
        atrPeriod: Int,
        multiplier: Double
    ) -> [String: [Double?]] {
        var bullish = [Double?](repeating: nil, count: candles.count)
        var bearish = [Double?](repeating: nil, count: candles.count)
        let atrValues = atrIncludingFirst(candles: candles, period: atrPeriod)
        var previousUpper: Double?
        var previousLower: Double?
        var wasBullish = true
        for index in candles.indices {
            guard let atrValue = atrValues[index] else { continue }
            let middle = (candles[index].high + candles[index].low) / 2
            let basicUpper = middle + multiplier * atrValue
            let basicLower = middle - multiplier * atrValue
            let finalUpper: Double
            let finalLower: Double
            if index > 0, let priorUpper = previousUpper, let priorLower = previousLower {
                let previousClose = candles[index - 1].close
                finalUpper = basicUpper < priorUpper || previousClose > priorUpper ? basicUpper : priorUpper
                finalLower = basicLower > priorLower || previousClose < priorLower ? basicLower : priorLower
            } else {
                finalUpper = basicUpper
                finalLower = basicLower
            }
            if wasBullish {
                wasBullish = candles[index].close >= finalLower
            } else {
                wasBullish = candles[index].close > finalUpper
            }
            if wasBullish { bullish[index] = finalLower } else { bearish[index] = finalUpper }
            previousUpper = finalUpper
            previousLower = finalLower
        }
        return ["bullish": bullish, "bearish": bearish]
    }

    private static func keltner(
        candles: [Candle],
        emaPeriod: Int,
        atrPeriod: Int,
        multiplier: Double
    ) -> [String: [Double?]] {
        let middle = ema(candles: candles, period: emaPeriod)
        let ranges = atrIncludingFirst(candles: candles, period: atrPeriod)
        var upper = [Double?](repeating: nil, count: candles.count)
        var lower = upper
        for index in candles.indices {
            if let mid = middle[index], let range = ranges[index] {
                upper[index] = mid + multiplier * range
                lower[index] = mid - multiplier * range
            }
        }
        return ["upper": upper, "middle": middle, "lower": lower]
    }

    private static func volumeProfile(
        candles: [Candle],
        rowCount: Int,
        valueAreaPercent: Double
    ) -> [PriceProfileRow] {
        guard !candles.isEmpty,
              let minimum = candles.map(\.low).min(),
              let maximum = candles.map(\.high).max()
        else { return [] }
        if minimum == maximum {
            return [PriceProfileRow(
                low: minimum,
                high: maximum,
                volume: candles.reduce(0) { $0 + Double($1.volume) },
                inValueArea: true
            )]
        }
        let width = (maximum - minimum) / Double(rowCount)
        var volumes = [Double](repeating: 0, count: rowCount)
        for candle in candles {
            let typical = (candle.high + candle.low + candle.close) / 3
            let rawIndex = Int((typical - minimum) / width)
            volumes[min(rowCount - 1, max(0, rawIndex))] += Double(candle.volume)
        }
        let target = volumes.reduce(0, +) * valueAreaPercent / 100
        let ranked = volumes.indices.sorted { left, right in
            volumes[left] == volumes[right] ? left < right : volumes[left] > volumes[right]
        }
        var included = Set<Int>()
        var running = 0.0
        for index in ranked where running < target {
            guard volumes[index] > 0 else { continue }
            included.insert(index)
            running += volumes[index]
        }
        return volumes.indices.map { index in
            PriceProfileRow(
                low: minimum + Double(index) * width,
                high: minimum + Double(index + 1) * width,
                volume: volumes[index],
                inValueArea: included.contains(index)
            )
        }
    }

    private static func adxDmi(candles: [Candle], period: Int) -> [String: [Double?]] {
        var adx = [Double?](repeating: nil, count: candles.count)
        var plusDi = adx
        var minusDi = adx
        guard period > 0, candles.count > period else {
            return ["adx": adx, "plusDi": plusDi, "minusDi": minusDi]
        }
        let ranges = trueRanges(candles)
        var plusDm = [Double](repeating: 0, count: candles.count)
        var minusDm = plusDm
        for index in 1..<candles.count {
            let up = candles[index].high - candles[index - 1].high
            let down = candles[index - 1].low - candles[index].low
            plusDm[index] = up > down && up > 0 ? up : 0
            minusDm[index] = down > up && down > 0 ? down : 0
        }
        var smoothedTr = ranges[1...period].reduce(0, +)
        var smoothedPlus = plusDm[1...period].reduce(0, +)
        var smoothedMinus = minusDm[1...period].reduce(0, +)
        var dx = [Double?](repeating: nil, count: candles.count)
        for index in period..<candles.count {
            if index > period {
                smoothedTr = smoothedTr - smoothedTr / Double(period) + ranges[index]
                smoothedPlus = smoothedPlus - smoothedPlus / Double(period) + plusDm[index]
                smoothedMinus = smoothedMinus - smoothedMinus / Double(period) + minusDm[index]
            }
            let plus = smoothedTr == 0 ? 0 : smoothedPlus / smoothedTr * 100
            let minus = smoothedTr == 0 ? 0 : smoothedMinus / smoothedTr * 100
            plusDi[index] = plus
            minusDi[index] = minus
            let sum = plus + minus
            dx[index] = sum == 0 ? 0 : abs(plus - minus) / sum * 100
        }
        let firstAdxIndex = period * 2 - 1
        if firstAdxIndex < candles.count {
            let seedValues = dx[period...firstAdxIndex].compactMap { $0 }
            if seedValues.count == period {
                var current = seedValues.reduce(0, +) / Double(period)
                adx[firstAdxIndex] = current
                if firstAdxIndex + 1 < candles.count {
                    for index in (firstAdxIndex + 1)..<candles.count {
                        if let dxValue = dx[index] {
                            current = (current * Double(period - 1) + dxValue) / Double(period)
                            adx[index] = current
                        }
                    }
                }
            }
        }
        return ["adx": adx, "plusDi": plusDi, "minusDi": minusDi]
    }

    private static func obv(candles: [Candle]) -> [Double?] {
        guard !candles.isEmpty else { return [] }
        var result = [Double?](repeating: nil, count: candles.count)
        var value = 0.0
        result[0] = value
        for index in 1..<candles.count {
            if candles[index].close > candles[index - 1].close {
                value += Double(candles[index].volume)
            } else if candles[index].close < candles[index - 1].close {
                value -= Double(candles[index].volume)
            }
            result[index] = value
        }
        return result
    }

    private static func cci(candles: [Candle], period: Int) -> [Double?] {
        let typical = candles.map { ($0.high + $0.low + $0.close) / 3 }
        var result = [Double?](repeating: nil, count: candles.count)
        guard period > 0, typical.count >= period else { return result }
        for index in (period - 1)..<typical.count {
            let values = typical[(index - period + 1)...index]
            let mean = values.reduce(0, +) / Double(period)
            let deviation = values.reduce(0) { $0 + abs($1 - mean) } / Double(period)
            result[index] = deviation == 0 ? 0 : (typical[index] - mean) / (0.015 * deviation)
        }
        return result
    }

    private static func williamsR(candles: [Candle], period: Int) -> [Double?] {
        var result = [Double?](repeating: nil, count: candles.count)
        guard period > 0, candles.count >= period else { return result }
        for index in (period - 1)..<candles.count {
            let window = candles[(index - period + 1)...index]
            let highest = window.map(\.high).max() ?? 0
            let lowest = window.map(\.low).min() ?? 0
            let range = highest - lowest
            result[index] = range == 0 ? -50 : (highest - candles[index].close) / range * -100
        }
        return result
    }

    private static func midpointSeries(candles: [Candle], period: Int) -> [Double?] {
        var result = [Double?](repeating: nil, count: candles.count)
        guard period > 0, candles.count >= period else { return result }
        for index in (period - 1)..<candles.count {
            let window = candles[(index - period + 1)...index]
            result[index] = ((window.map(\.high).max() ?? 0) + (window.map(\.low).min() ?? 0)) / 2
        }
        return result
    }

    private static func ichimoku(
        candles: [Candle],
        conversionPeriod: Int,
        basePeriod: Int,
        spanBPeriod: Int,
        displacement: Int
    ) -> [String: [Double?]] {
        let conversion = midpointSeries(candles: candles, period: conversionPeriod)
        let base = midpointSeries(candles: candles, period: basePeriod)
        let rawSpanB = midpointSeries(candles: candles, period: spanBPeriod)
        var spanA = [Double?](repeating: nil, count: candles.count)
        var spanB = spanA
        var lagging = spanA
        for sourceIndex in candles.indices {
            let destination = sourceIndex + displacement
            if destination < candles.count {
                if let conversionValue = conversion[sourceIndex], let baseValue = base[sourceIndex] {
                    spanA[destination] = (conversionValue + baseValue) / 2
                }
                spanB[destination] = rawSpanB[sourceIndex]
            }
            let laggingIndex = sourceIndex - displacement
            if laggingIndex >= 0 { lagging[laggingIndex] = candles[sourceIndex].close }
        }
        return [
            "conversion": conversion,
            "base": base,
            "spanA": spanA,
            "spanB": spanB,
            "lagging": lagging,
        ]
    }
}
