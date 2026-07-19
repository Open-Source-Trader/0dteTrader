import Foundation

/// Math primitives for the TWC Heatmap V5 port that don't exist in
/// IndicatorEngine (twcMath.ts port, 1:1). Pine v6 semantics mirrored where
/// they matter: warm-up nils, na-condition-is-false ternaries, supertrend
/// direction sign (-1 = bullish).
enum TwcMath {
    static func sourceSeries(_ candles: [Candle], source: String) -> [Double] {
        switch source {
        case "open": return candles.map(\.open)
        case "high": return candles.map(\.high)
        case "low": return candles.map(\.low)
        case "hl2": return candles.map { ($0.high + $0.low) / 2 }
        case "hlc3": return candles.map { ($0.high + $0.low + $0.close) / 3 }
        case "ohlc4": return candles.map { ($0.open + $0.high + $0.low + $0.close) / 4 }
        default: return candles.map(\.close)
        }
    }

    /// Rolling mean over a window; nil until the window fills (Pine ta.sma).
    /// The window slides only over contiguous non-nil values.
    static func rollingMean(_ values: [Double?], period: Int) -> [Double?] {
        var result = [Double?](repeating: nil, count: values.count)
        guard period > 0 else { return result }
        var sum = 0.0
        var count = 0
        for i in 0..<values.count {
            guard let v = values[i] else {
                sum = 0
                count = 0
                continue
            }
            sum += v
            count += 1
            if count > period {
                if let drop = values[i - period] { sum -= drop }
                count = period
            }
            if count == period { result[i] = sum / Double(period) }
        }
        return result
    }

    /// Population (÷N) stdev over a window; nil until it fills (Pine ta.stdev).
    static func rollingStdev(_ values: [Double?], period: Int) -> [Double?] {
        var result = [Double?](repeating: nil, count: values.count)
        guard period > 0, values.count >= period else { return result }
        for i in (period - 1)..<values.count {
            var sum = 0.0
            var valid = true
            for j in (i - period + 1)...i {
                guard let v = values[j] else {
                    valid = false
                    break
                }
                sum += v
            }
            guard valid else { continue }
            let mean = sum / Double(period)
            var variance = 0.0
            for j in (i - period + 1)...i {
                let v = values[j]!
                variance += (v - mean) * (v - mean)
            }
            result[i] = (variance / Double(period)).squareRoot()
        }
        return result
    }

    /// Pine f_zscore: (v - sma) / stdev, 0 when stdev == 0, nil in warm-up.
    static func zscore(_ values: [Double?], period: Int) -> [Double?] {
        let mean = rollingMean(values, period: period)
        let sd = rollingStdev(values, period: period)
        return values.indices.map { i in
            guard let v = values[i], let m = mean[i], let s = sd[i] else { return nil }
            return s == 0 ? 0 : (v - m) / s
        }
    }

    /// Gaussian PDF (Pine f_gauss).
    static func gaussPdf(_ x: Double, mu: Double, sigma: Double) -> Double {
        let s2 = sigma * sigma
        guard s2 > 0 else { return 0 }
        let z = (x - mu) / sigma
        return exp(-0.5 * z * z) / (sigma * (2 * Double.pi).squareRoot())
    }

    /// Pine ta.linreg(src, len, offset): least-squares line fit over the last
    /// `len` values, evaluated `offset` bars back from the newest point.
    static func linreg(_ values: [Double], period: Int, offset: Int) -> [Double?] {
        var result = [Double?](repeating: nil, count: values.count)
        guard period > 1, values.count >= period else { return result }
        let n = Double(period)
        let sumX = (n - 1) * n / 2
        let sumX2 = (n - 1) * n * (2 * n - 1) / 6
        for i in (period - 1)..<values.count {
            var sumY = 0.0
            var sumXY = 0.0
            for j in 0..<period {
                let y = values[i - period + 1 + j]
                sumY += y
                sumXY += Double(j) * y
            }
            let denom = n * sumX2 - sumX * sumX
            guard denom != 0 else { continue }
            let slope = (n * sumXY - sumX * sumY) / denom
            let intercept = (sumY - slope * sumX) / n
            result[i] = intercept + slope * (n - 1 - Double(offset))
        }
        return result
    }

    /// Ehlers Center of Gravity (Pine f_cog, nz() -> 0 for pre-history bars).
    static func cogSeries(_ values: [Double], period: Int) -> [Double] {
        values.indices.map { i in
            var num = 0.0
            var den = 0.0
            for j in 0..<period {
                let idx = i - j
                let v = idx >= 0 ? values[idx] : 0
                num += Double(j + 1) * v
                den += v
            }
            return den == 0 ? 0 : -num / den + Double(period + 1) / 2
        }
    }

    private static let nyCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .current
        return calendar
    }()

    /// Session-anchored VWAP of hlc3 (Pine ta.vwap): accumulation resets on
    /// each America/New_York calendar day. On daily-and-larger intervals
    /// every bar is its own session, so the VWAP collapses to that bar's
    /// hlc3 — exactly why the Pine header flags VWAP-z as weak on D/W charts.
    static func sessionVwap(_ candles: [Candle], intervalSeconds: Int) -> [Double?] {
        var result = [Double?](repeating: nil, count: candles.count)
        let daily = intervalSeconds >= 86_400
        var pv = 0.0
        var vol = 0.0
        var sessionDay: Int? = nil
        for i in 0..<candles.count {
            let c = candles[i]
            if daily {
                pv = 0
                vol = 0
            } else {
                let day = nyCalendar.ordinality(of: .day, in: .era, for: c.time)
                if day != sessionDay {
                    sessionDay = day
                    pv = 0
                    vol = 0
                }
            }
            let typical = (c.high + c.low + c.close) / 3
            pv += typical * Double(c.volume)
            vol += Double(c.volume)
            if vol > 0 { result[i] = pv / vol }
        }
        return result
    }

    /// Pine ta.atr: RMA of true range where the FIRST bar's true range is
    /// high - low (no prior close), seeded with the SMA of the first `period`
    /// true ranges, first value at index period-1. Differs from
    /// IndicatorEngine.atr (skips bar 0, outputs from index period) — the TWC
    /// engine uses this one everywhere for exact Pine warm-up parity.
    static func pineAtr(_ candles: [Candle], period: Int) -> [Double?] {
        var result = [Double?](repeating: nil, count: candles.count)
        guard period > 0, candles.count >= period else { return result }
        let trueRanges: [Double] = candles.indices.map { i in
            let c = candles[i]
            if i == 0 { return c.high - c.low }
            let prevClose = candles[i - 1].close
            return max(c.high - c.low, abs(c.high - prevClose), abs(c.low - prevClose))
        }
        var value = trueRanges[0..<period].reduce(0, +) / Double(period)
        result[period - 1] = value
        guard candles.count > period else { return result }
        for i in period..<candles.count {
            value = (value * Double(period - 1) + trueRanges[i]) / Double(period)
            result[i] = value
        }
        return result
    }

    struct SupertrendResult: Equatable, Sendable {
        let value: [Double?]
        /// -1 = bullish, 1 = bearish (Pine convention).
        let direction: [Double?]
    }

    /// Pine ta.supertrend reference algorithm over hl2 with band ratcheting.
    static func supertrend(_ candles: [Candle], factor: Double, atrPeriod: Int) -> SupertrendResult {
        var value = [Double?](repeating: nil, count: candles.count)
        var direction = [Double?](repeating: nil, count: candles.count)
        let atrArr = pineAtr(candles, period: atrPeriod)
        var prevLower: Double? = nil
        var prevUpper: Double? = nil
        var prevSt: Double? = nil
        for i in 0..<candles.count {
            guard let a = atrArr[i] else { continue }
            let src = (candles[i].high + candles[i].low) / 2
            var lower = src - factor * a
            var upper = src + factor * a
            let prevClose = i > 0 ? candles[i - 1].close : candles[i].close
            if let pl = prevLower, !(lower > pl || prevClose < pl) { lower = pl }
            if let pu = prevUpper, !(upper < pu || prevClose > pu) { upper = pu }

            let dir: Double
            if i == 0 || atrArr[i - 1] == nil {
                dir = 1
            } else if let st = prevSt, let pu = prevUpper, st == pu {
                dir = candles[i].close > upper ? -1 : 1
            } else {
                dir = candles[i].close < lower ? 1 : -1
            }
            let st = dir == -1 ? lower : upper
            value[i] = st
            direction[i] = dir
            prevLower = lower
            prevUpper = upper
            prevSt = st
        }
        return SupertrendResult(value: value, direction: direction)
    }

    struct HtfResample {
        let htfCandles: [Candle]
        /// chartToHtf[i] = index of the HTF bucket containing chart bar i.
        let chartToHtf: [Int]
    }

    /// Resample chart candles into 6x-timeframe buckets (client-side
    /// substitute for Pine request.security on the 6x timeframe). Intraday
    /// buckets are clock-aligned; daily data buckets by index blocks of 6.
    static func resampleHtf(_ candles: [Candle], intervalSeconds: Int) -> HtfResample {
        var htfCandles: [Candle] = []
        var chartToHtf: [Int] = []
        let daily = intervalSeconds >= 86_400
        let htfSeconds = Double(intervalSeconds * 6)
        var currentKey: Int? = nil
        for i in 0..<candles.count {
            let c = candles[i]
            let key = daily ? i / 6 : Int((c.time.timeIntervalSince1970 / htfSeconds).rounded(.down))
            if key != currentKey {
                currentKey = key
                htfCandles.append(c)
            } else {
                var bucket = htfCandles[htfCandles.count - 1]
                bucket.high = max(bucket.high, c.high)
                bucket.low = min(bucket.low, c.low)
                bucket.close = c.close
                bucket.volume += c.volume
                htfCandles[htfCandles.count - 1] = bucket
            }
            chartToHtf.append(htfCandles.count - 1)
        }
        return HtfResample(htfCandles: htfCandles, chartToHtf: chartToHtf)
    }

    /// Pine timeframe string → seconds ("5" → 300, "D" → 86400, "W" → 604800).
    static func timeframeSeconds(_ tf: String) -> Int {
        if tf == "D" || tf == "1D" { return 86_400 }
        if tf == "W" || tf == "1W" { return 604_800 }
        if let minutes = Int(tf), minutes > 0 { return minutes * 60 }
        return 60
    }

    /// Resample chart candles into arbitrary clock-aligned buckets (MTF
    /// votes). Buckets no larger than the chart interval degenerate to one
    /// bucket per bar; weekly buckets anchor to the epoch week.
    static func resampleTo(_ candles: [Candle], targetSeconds: Int, chartIntervalSeconds: Int) -> HtfResample {
        if targetSeconds <= chartIntervalSeconds {
            return HtfResample(htfCandles: candles, chartToHtf: Array(candles.indices))
        }
        var htfCandles: [Candle] = []
        var chartToHtf: [Int] = []
        let target = Double(targetSeconds)
        var currentKey: Int? = nil
        for i in 0..<candles.count {
            let c = candles[i]
            let key = Int((c.time.timeIntervalSince1970 / target).rounded(.down))
            if key != currentKey {
                currentKey = key
                htfCandles.append(c)
            } else {
                var bucket = htfCandles[htfCandles.count - 1]
                bucket.high = max(bucket.high, c.high)
                bucket.low = min(bucket.low, c.low)
                bucket.close = c.close
                bucket.volume += c.volume
                htfCandles[htfCandles.count - 1] = bucket
            }
            chartToHtf.append(htfCandles.count - 1)
        }
        return HtfResample(htfCandles: htfCandles, chartToHtf: chartToHtf)
    }

    /// Map an HTF series back to chart bars repaint-safely: every chart bar in
    /// bucket k reads HTF bar k-1 — the prior COMPLETED bucket — exactly what
    /// Pine's f_confirmedSupertrend (expr[1] + lookahead_on) yields.
    static func mapConfirmedHtf(_ htfValues: [Double?], chartToHtf: [Int]) -> [Double?] {
        chartToHtf.map { k in k >= 1 ? htfValues[k - 1] : nil }
    }

    /// crossover against a constant threshold, nil-guarded (Pine ta.crossover).
    static func crossesOver(_ series: [Double?], at i: Int, threshold: Double) -> Bool {
        guard i > 0, let cur = series[i], let prev = series[i - 1] else { return false }
        return cur > threshold && prev <= threshold
    }

    static func crossesUnder(_ series: [Double?], at i: Int, threshold: Double) -> Bool {
        guard i > 0, let cur = series[i], let prev = series[i - 1] else { return false }
        return cur < threshold && prev >= threshold
    }

    /// Series-vs-series crossover at index i, nil-guarded.
    static func seriesCrossOver(_ a: [Double?], _ b: [Double?], at i: Int) -> Bool {
        guard i > 0, let a1 = a[i], let a0 = a[i - 1], let b1 = b[i], let b0 = b[i - 1] else { return false }
        return a1 > b1 && a0 <= b0
    }

    static func seriesCrossUnder(_ a: [Double?], _ b: [Double?], at i: Int) -> Bool {
        guard i > 0, let a1 = a[i], let a0 = a[i - 1], let b1 = b[i], let b0 = b[i - 1] else { return false }
        return a1 < b1 && a0 >= b0
    }

    /// Pine ta.pivothigh(src, left, right): confirmed at bar i, the pivot sits
    /// at i - right and must exceed every bar `left` back and `right` forward
    /// (>= on the left so flat tops resolve at their earliest bar, > right).
    static func pivotHigh(_ values: [Double], left: Int, right: Int) -> [Double?] {
        var result = [Double?](repeating: nil, count: values.count)
        guard values.count > left + right else { return result }
        for i in (left + right)..<values.count {
            let center = i - right
            let pivot = values[center]
            var ok = true
            for j in (center - left)..<center where values[j] > pivot {
                ok = false
                break
            }
            // right >= 1 guard: a ClosedRange with right == 0 would trap
            if ok, right >= 1 {
                for j in (center + 1)...(center + right) where values[j] >= pivot {
                    ok = false
                    break
                }
            }
            if ok { result[i] = pivot }
        }
        return result
    }

    static func pivotLow(_ values: [Double], left: Int, right: Int) -> [Double?] {
        var result = [Double?](repeating: nil, count: values.count)
        guard values.count > left + right else { return result }
        for i in (left + right)..<values.count {
            let center = i - right
            let pivot = values[center]
            var ok = true
            for j in (center - left)..<center where values[j] < pivot {
                ok = false
                break
            }
            // right >= 1 guard: a ClosedRange with right == 0 would trap
            if ok, right >= 1 {
                for j in (center + 1)...(center + right) where values[j] <= pivot {
                    ok = false
                    break
                }
            }
            if ok { result[i] = pivot }
        }
        return result
    }

    /// Pine ta.highestbars at bar i: offset (0 or negative) to the highest
    /// value of the last `length` bars; most recent bar wins ties.
    static func highestBarsOffset(_ values: [Double], at i: Int, length: Int) -> Int {
        let start = max(0, i - length + 1)
        var best = start
        if start < i {
            for j in (start + 1)...i where values[j] >= values[best] { best = j }
        }
        return best - i
    }

    static func lowestBarsOffset(_ values: [Double], at i: Int, length: Int) -> Int {
        let start = max(0, i - length + 1)
        var best = start
        if start < i {
            for j in (start + 1)...i where values[j] <= values[best] { best = j }
        }
        return best - i
    }
}
