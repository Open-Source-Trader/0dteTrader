import Foundation

enum TickStorage {
    private static let maxCandles = 600

    private static func fileURL(symbol: String, interval: TickInterval) -> URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("tick-candles", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(symbol)-\(interval.rawValue).json")
    }

    static func load(symbol: String, interval: TickInterval) -> [Candle] {
        let url = fileURL(symbol: symbol, interval: interval)
        guard let data = try? Data(contentsOf: url),
              let stored = try? JSONDecoder().decode([StoredCandle].self, from: data) else {
            return []
        }
        return stored.map(\.candle)
    }

    static func save(symbol: String, interval: TickInterval, candles: [Candle]) {
        let trimmed = candles.count > maxCandles ? Array(candles.suffix(maxCandles)) : candles
        let stored = trimmed.map(StoredCandle.init)
        guard let data = try? JSONEncoder().encode(stored) else { return }
        let url = fileURL(symbol: symbol, interval: interval)
        try? data.write(to: url, options: .atomic)
    }
}

private struct StoredCandle: Codable {
    let time: TimeInterval
    let open: Double
    let high: Double
    let low: Double
    let close: Double
    let volume: Int

    init(_ candle: Candle) {
        time = candle.time.timeIntervalSince1970
        open = candle.open
        high = candle.high
        low = candle.low
        close = candle.close
        volume = candle.volume
    }

    var candle: Candle {
        Candle(
            time: Date(timeIntervalSince1970: time),
            open: open,
            high: high,
            low: low,
            close: close,
            volume: volume
        )
    }
}
