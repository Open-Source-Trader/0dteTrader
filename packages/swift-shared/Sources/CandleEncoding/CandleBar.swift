/// A single OHLCV candle, decoupled from either consumer's own candle type
/// (iOS's `Candle` carries a `Date`; desktop's shim only has an opaque
/// `JSONValue`) — each caller adapts its own representation into this at
/// the call site. No timestamp field: `CandleTableEncoder` never reads a
/// per-bar time, only the caller-supplied `startLabel` for the header line.
public struct CandleBar: Equatable, Sendable {
    public let open: Double
    public let high: Double
    public let low: Double
    public let close: Double
    /// `Double`, not `Int` — matches desktop's wire representation
    /// (`JSONValue.number(Double)`) without a lossy/failable conversion in
    /// that adapter; iOS's `Int` volumes upcast losslessly.
    public let volume: Double

    public init(open: Double, high: Double, low: Double, close: Double, volume: Double) {
        self.open = open
        self.high = high
        self.low = low
        self.close = close
        self.volume = volume
    }
}
