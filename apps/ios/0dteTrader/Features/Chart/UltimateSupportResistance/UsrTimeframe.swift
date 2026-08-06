import Foundation

struct UsrPreparedHistory {
    /// Canonical chart input, including the newest open candle for rendering.
    let presentationCandles: [Candle]
    /// Fully closed chart candles used by every analytical state transition.
    let chartCandles: [Candle]
    let analysisCandles: [UsrAnalysisCandle]
    let analysisSeconds: TimeInterval?
    let timeframeTag: String
    let usedChartTimeframe: Bool
    let warnings: [String]
}

enum UsrTimeframe {
    private static let day: TimeInterval = 86_400
    private static let week: TimeInterval = 604_800
    private static let mondayOffset: TimeInterval = 345_600

    struct Value {
        let seconds: TimeInterval?
        let months: Int?
        let ticks: Int?
        let tag: String
    }

    private static func fixedSeconds(_ seconds: TimeInterval, tag: String? = nil) -> Value {
        Value(seconds: seconds, months: nil, ticks: nil, tag: tag ?? String(Int(seconds)))
    }

    private static func fixedMonths(_ months: Int) -> Value {
        Value(seconds: nil, months: months, ticks: nil, tag: "\(months)M")
    }

    private static func fixedTicks(_ ticks: Int) -> Value {
        Value(seconds: nil, months: nil, ticks: ticks, tag: "\(ticks)T")
    }

    private static func auto(_ chart: TimeInterval) -> Value {
        if chart <= 5 { return fixedSeconds(15, tag: "15S") }
        if chart <= 15 { return fixedSeconds(60, tag: "1") }
        if chart <= 30 { return fixedSeconds(120, tag: "2") }
        if chart <= 60 { return fixedSeconds(300, tag: "5") }
        if chart <= 180 { return fixedSeconds(900, tag: "15") }
        if chart <= 300 { return fixedSeconds(1_800, tag: "30") }
        if chart <= 900 { return fixedSeconds(3_600, tag: "60") }
        if chart <= 1_800 { return fixedSeconds(7_200, tag: "120") }
        if chart <= 3_600 { return fixedSeconds(14_400, tag: "240") }
        if chart <= 7_200 { return fixedSeconds(28_800, tag: "480") }
        if chart <= 14_400 { return fixedSeconds(day, tag: "1D") }
        if chart <= 43_200 { return fixedSeconds(2 * day, tag: "2D") }
        if chart <= day { return fixedSeconds(week, tag: "1W") }
        if chart <= 3 * day { return fixedSeconds(2 * week, tag: "2W") }
        if chart <= week { return fixedMonths(1) }
        if chart <= 2 * week { return fixedMonths(2) }
        if chart <= 31 * day { return fixedMonths(3) }
        return fixedMonths(12)
    }

    static func parse(_ input: String) -> Value? {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard let match = value.range(of: #"^([1-9][0-9]*)?(T|S|D|W|M)?$"#,
                                      options: .regularExpression) else { return nil }
        let canonical = String(value[match])
        guard !canonical.isEmpty else { return nil }
        let suffix = canonical.last.map(String.init) ?? ""
        let hasSuffix = ["T", "S", "D", "W", "M"].contains(suffix)
        let digits = hasSuffix ? String(canonical.dropLast()) : canonical
        guard let amount = Int(digits.isEmpty ? "1" : digits) else { return nil }
        switch hasSuffix ? suffix : "" {
        case "T":
            return [1, 10, 100, 1_000].contains(amount) ? fixedTicks(amount) : nil
        case "S":
            return [1, 5, 10, 15, 30, 45].contains(amount)
                ? fixedSeconds(Double(amount), tag: "\(amount)S") : nil
        case "D":
            return amount <= 365 ? fixedSeconds(Double(amount) * day, tag: "\(amount)D") : nil
        case "W":
            return amount <= 52 ? fixedSeconds(Double(amount) * week, tag: "\(amount)W") : nil
        case "M":
            return amount <= 12 ? fixedMonths(amount) : nil
        default:
            return amount <= 1_440 ? fixedSeconds(Double(amount) * 60, tag: canonical) : nil
        }
    }

    private static func selected(
        _ settings: UsrSettings,
        chart: TimeInterval?
    ) -> Value? {
        switch settings.analysisTimeframe {
        case "chart": return chart.map { fixedSeconds($0, tag: chartTag($0)) }
        case "auto": return chart.map(auto)
        case "4h": return fixedSeconds(14_400, tag: "240")
        case "1d": return fixedSeconds(day, tag: "1D")
        case "3d": return fixedSeconds(3 * day, tag: "3D")
        case "1w": return fixedSeconds(week, tag: "1W")
        case "2w": return fixedSeconds(2 * week, tag: "2W")
        case "1m": return fixedMonths(1)
        case "custom": return parse(settings.customTimeframe)
        default: return nil
        }
    }

    private static func regularSession(_ date: Date) -> Bool {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .current
        let weekday = calendar.component(.weekday, from: date)
        guard weekday != 1 && weekday != 7 else { return false }
        let minute = calendar.component(.hour, from: date) * 60 + calendar.component(.minute, from: date)
        return minute >= 570 && minute < 960
    }

    private static func chartTag(_ seconds: TimeInterval?) -> String? {
        guard let seconds else { return nil }
        if seconds == 60 { return "1" }
        if seconds == 300 { return "5" }
        if seconds == 900 { return "15" }
        if seconds == 1_800 { return "30" }
        if seconds == 3_600 { return "60" }
        if seconds == 14_400 { return "240" }
        if seconds == day { return "1D" }
        if seconds == week { return "1W" }
        return String(Int(seconds))
    }

    private static func key(
        _ date: Date,
        seconds: TimeInterval?,
        months: Int?,
        weekly: Bool
    ) -> String {
        if let months {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
            let monthIndex = calendar.component(.year, from: date) * 12
                + calendar.component(.month, from: date) - 1
            return String(monthIndex / months)
        }
        let epoch = date.timeIntervalSince1970
        guard let seconds else { return String(epoch) }
        if weekly {
            return String(Int(floor((epoch - mondayOffset) / seconds)))
        }
        return String(Int(floor(epoch / seconds)))
    }

    private struct Group {
        let key: String
        let start: Int
        var end: Int
        var candle: Candle
    }

    static func prepare(
        candles input: [Candle],
        settings: UsrSettings,
        chartSeconds: TimeInterval?,
        continuousSession: Bool = false,
        now: Date,
        lastCandleIsOpen: Bool? = nil
    ) -> UsrPreparedHistory {
        var warnings: [String] = []
        var candlesByTime: [Date: Candle] = [:]
        for candle in input where candle.time.timeIntervalSince1970.isFinite
            && candle.open.isFinite && candle.high.isFinite
            && candle.low.isFinite && candle.close.isFinite && candle.volume.isFinite
            && candle.volume >= 0 && candle.high >= candle.low
            && candle.open >= candle.low && candle.open <= candle.high
            && candle.close >= candle.low && candle.close <= candle.high {
            // Prefer the last valid provider/live-stream correction for a
            // timestamp instead of retaining stale OHLCV from the first copy.
            candlesByTime[candle.time] = candle
        }
        let sorted = candlesByTime.values.sorted { $0.time < $1.time }
        if sorted.count != input.count { warnings.append("Invalid or duplicate candles were excluded before analysis.") }
        var confirmed = sorted
        let newestIsOpen = lastCandleIsOpen ?? confirmed.last.map {
            chartSeconds == nil || $0.time.addingTimeInterval(chartSeconds ?? 0) > now
        } ?? false
        if newestIsOpen, !confirmed.isEmpty {
            confirmed.removeLast()
        }
        let requested = selected(settings, chart: chartSeconds)
        var seconds = requested?.seconds
        var months = requested?.months
        var chartContext = settings.analysisTimeframe == "chart"
        let comparable: TimeInterval?
        if let requestedSeconds = requested?.seconds {
            comparable = requestedSeconds
        } else if let requestedMonths = requested?.months {
            comparable = Double(requestedMonths) * (365.25 / 12) * day
        } else {
            comparable = nil
        }
        let requestedIsChartClock = settings.analysisTimeframe == "chart"
            || requested?.tag == chartTag(chartSeconds)
        let requestedIsLower = chartSeconds != nil && comparable != nil
            && (comparable ?? 0) < (chartSeconds ?? 0)
        if chartSeconds == nil || requested == nil || comparable == nil || requestedIsLower
            || (comparable == chartSeconds && requestedIsChartClock) {
            if requestedIsLower {
                warnings.append("The selected analysis timeframe is not above the chart timeframe; chart bars are used.")
            }
            seconds = chartSeconds
            months = nil
            chartContext = true
        }
        let timeframeTag = chartContext ? "chart" : requested?.tag ?? "chart"
        let weeklyClock = !chartContext && timeframeTag.hasSuffix("W")
        var groups: [Group] = []
        for (index, candle) in confirmed.enumerated() {
            let bucket = key(candle.time, seconds: seconds, months: months, weekly: weeklyClock)
            if groups.last?.key != bucket {
                groups.append(Group(key: bucket, start: index, end: index, candle: candle))
            } else {
                let last = groups.count - 1
                groups[last].end = index
                groups[last].candle.high = max(groups[last].candle.high, candle.high)
                groups[last].candle.low = min(groups[last].candle.low, candle.low)
                groups[last].candle.close = candle.close
                groups[last].candle.volume += candle.volume
            }
        }
        let isChartClock = chartContext
        let usable = isChartClock ? groups : Array(groups.dropLast())
        var analysis = usable.enumerated().map { index, group in
            let eventChartIndex = isChartClock ? group.end : groups[index + 1].start
            return UsrAnalysisCandle(
                time: group.candle.time,
                open: group.candle.open,
                high: group.candle.high,
                low: group.candle.low,
                close: group.candle.close,
                volume: group.candle.volume,
                chartStart: group.start,
                chartEnd: group.end,
                eventChartIndex: eventChartIndex,
                eventTime: confirmed[eventChartIndex].time.addingTimeInterval(chartSeconds ?? 0),
                closeTime: confirmed[group.end].time.addingTimeInterval(chartSeconds ?? 0),
                regularSession: continuousSession || regularSession(group.candle.time),
                atr: nil,
                volumeMean: nil,
                volumeStd: nil
            )
        }
        let aggregateCandles = analysis.map {
            Candle(time: $0.time, open: $0.open, high: $0.high, low: $0.low, close: $0.close, volume: $0.volume)
        }
        let atr = UsrMath.atr(aggregateCandles)
        var all: [Double] = []
        var regular: [Double] = []
        var extended: [Double] = []
        for index in analysis.indices {
            analysis[index].atr = atr[index]
            let chosen = settings.sessionAwareVolume && (seconds ?? day) < day
                ? (analysis[index].regularSession ? regular : extended)
                : all
            let fallback: ArraySlice<Double>? = all.count >= settings.volumeLookback
                ? all.suffix(settings.volumeLookback) : nil
            let sample: ArraySlice<Double>? = chosen.count >= settings.volumeLookback
                ? chosen.suffix(settings.volumeLookback) : fallback
            if let sample {
                let mean = UsrMath.mean(sample)
                analysis[index].volumeMean = mean
                analysis[index].volumeStd = UsrMath.deviation(sample, mean: mean)
            }
            all.append(analysis[index].volume)
            if analysis[index].regularSession { regular.append(analysis[index].volume) }
            else { extended.append(analysis[index].volume) }
        }
        return UsrPreparedHistory(
            presentationCandles: sorted,
            chartCandles: confirmed,
            analysisCandles: analysis,
            analysisSeconds: seconds,
            timeframeTag: timeframeTag,
            usedChartTimeframe: chartContext,
            warnings: warnings
        )
    }
}
