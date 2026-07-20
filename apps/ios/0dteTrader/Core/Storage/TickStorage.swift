import Foundation

/// Completed tick candles plus the in-progress accumulator, persisted per
/// quote so an app restart resumes the partial candle. Files from the old
/// candle-array format (500t… sizes) are simply orphaned by the new names.
struct StoredTickState {
    var candles: [Candle]
    var accumulator: TickAccumulatorState?
}

struct TickAccumulatorState: Codable, Equatable {
    var count: Int
    var open: Double
    var high: Double
    var low: Double
    var close: Double
    var firstTimestamp: TimeInterval
}

enum TickStorage {
    private static let maxCandles = 600

    private static func fileURL(symbol: String, interval: TickInterval) -> URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("tick-candles", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(symbol)-\(interval.rawValue).json")
    }

    static func load(symbol: String, interval: TickInterval) -> StoredTickState {
        let url = fileURL(symbol: symbol, interval: interval)
        guard let data = try? Data(contentsOf: url),
              let stored = try? JSONDecoder().decode(StoredState.self, from: data) else {
            return StoredTickState(candles: [], accumulator: nil)
        }
        return StoredTickState(candles: stored.candles.map(\.candle), accumulator: stored.accumulator)
    }

    static func save(symbol: String, interval: TickInterval, state: StoredTickState) {
        let candles = state.candles.count > maxCandles
            ? Array(state.candles.suffix(maxCandles))
            : state.candles
        let stored = StoredState(
            candles: candles.map(StoredCandle.init),
            accumulator: state.accumulator
        )
        guard let data = try? JSONEncoder().encode(stored) else { return }
        let url = fileURL(symbol: symbol, interval: interval)
        try? data.write(to: url, options: .atomic)
    }
}

private struct StoredState: Codable {
    let candles: [StoredCandle]
    let accumulator: TickAccumulatorState?
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
