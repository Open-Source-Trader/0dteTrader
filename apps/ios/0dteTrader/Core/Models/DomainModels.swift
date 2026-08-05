import Foundation

// MARK: - Shared enums (raw values match the API contract)

/// The app is options-only; the backend rejects any other asset class.
enum AssetClass: String, Codable, CaseIterable, Sendable {
    case option
}

enum OrderSide: String, Codable, Sendable {
    case buy
    case sell

    var opposite: OrderSide { self == .buy ? .sell : .buy }
    var displayName: String { rawValue.uppercased() }
}

/// Execution types a resting chart-order line may carry.
///
/// Deliberately narrower than `OrderType`: a line is fired by the server's
/// watcher with nobody watching and nothing on screen to type a price into, so
/// the variants that need a human-supplied number cannot reach it. Mirrors
/// `ChartOrderType` in `packages/shared-types`.
enum ChartOrderType: String, Codable, CaseIterable, Sendable {
    case mid
    case market

    var displayName: String { self == .mid ? "Mid" : "Market" }
    /// The label the order line's pill prints.
    var shortLabel: String { self == .market ? "MKT" : "MID" }
}

/// How the trade panel prices an order.
///
/// Only `custom` carries a client-supplied price; `bid`, `mid` and `ask` are
/// resolved server-side from the server's own quote at execution time, exactly
/// as `mid` always was. `mid` and `market` keep their raw values, so anything
/// already persisted or in flight as either still decodes.
enum OrderType: String, Codable, CaseIterable, Sendable {
    case custom
    case bid
    case mid
    case ask
    case market

    /// Short name for a list — the history row, the positions strip.
    var displayName: String {
        switch self {
        case .custom: return "Custom"
        case .bid: return "Bid"
        case .mid: return "Mid"
        case .ask: return "Ask"
        case .market: return "Market"
        }
    }

    /// How the order is priced, spelled out — the confirm sheet's phrasing,
    /// where "Ask" alone would not say whether it is a limit or a market order.
    var pricingDescription: String {
        switch self {
        case .custom: return "Limit at your price"
        case .bid: return "Limit at bid"
        case .mid: return "Limit at mid"
        case .ask: return "Limit at ask"
        case .market: return "Market"
        }
    }

    /// The chart line's execution type for this panel selection.
    ///
    /// The three price-carrying variants collapse onto `.mid` — the
    /// server-computed limit — because a line fires unattended: a bid or ask
    /// read at arming time would be stale by the time the level is crossed, and
    /// a custom price belongs to the contract and the moment it was typed for.
    /// Mirrors `narrowToChartOrderType` in `packages/shared-types`.
    var chartOrderType: ChartOrderType { self == .market ? .market : .mid }
}

enum OptionType: String, Codable, CaseIterable, Sendable {
    case call
    case put

    var displayName: String { self == .call ? "Call" : "Put" }
    var shortName: String { self == .call ? "C" : "P" }
}

enum OrderStatus: String, Sendable {
    case submitted
    case filled
    case partiallyFilled = "partially_filled"
    case cancelled
    case rejected
    case unknown

    init(tolerant rawValue: String) {
        self = OrderStatus(rawValue: rawValue) ?? .unknown
    }

    var displayName: String {
        switch self {
        case .submitted: return "Submitted"
        case .filled: return "Filled"
        case .partiallyFilled: return "Partially filled"
        case .cancelled: return "Cancelled"
        case .rejected: return "Rejected"
        case .unknown: return "Unknown"
        }
    }
}

// MARK: - Domain models
// DTO mapping initializers live in extensions so the memberwise initializers
// remain available (unit tests construct these directly).

struct Quote: Equatable, Sendable, Identifiable {
    var id: String { symbol }
    let symbol: String
    let bid: Double
    let ask: Double
    let last: Double
    let bidSize: Int
    let askSize: Int
    let volume: Int
    let timestamp: Date
}

extension Quote {
    init(dto: QuoteDTO) {
        self.init(
            symbol: dto.symbol,
            bid: dto.bid,
            ask: dto.ask,
            last: dto.last,
            bidSize: dto.bidSize,
            askSize: dto.askSize,
            volume: dto.volume,
            timestamp: DateParsing.dateTime(dto.timestamp) ?? Date(timeIntervalSince1970: 0)
        )
    }
}

struct Candle: Equatable, Sendable {
    var time: Date
    var open: Double
    var high: Double
    var low: Double
    var close: Double
    var volume: Int
}

extension Candle {
    init(dto: CandleDTO) {
        self.init(
            time: DateParsing.dateTime(dto.time) ?? Date(timeIntervalSince1970: 0),
            open: dto.open,
            high: dto.high,
            low: dto.low,
            close: dto.close,
            volume: dto.volume
        )
    }
}

struct OptionContract: Equatable, Sendable, Identifiable {
    var id: String { symbol }
    let symbol: String
    let underlying: String
    let expiration: String
    let strike: Double
    let optionType: OptionType
    let bid: Double
    let ask: Double
    let last: Double

    /// Indicative mid price from the current quote pair; nil when the quote is unusable.
    var mid: Double? { PriceMath.midPrice(bid: bid, ask: ask) }

    /// Whether this contract carries a quote an order could be priced from:
    /// both sides live and not crossed (a locked book, bid == ask, passes).
    /// Every order type this app sends is priced from the live book — mid,
    /// bid and ask all need both sides — and a one-sided or crossed book is
    /// a broken feed, not a market. False for the all-zero placeholder a
    /// CURR leg synthesizes before its expiration's contracts load, and for
    /// junk (negative/NaN) quotes; `last` deliberately does not count — a
    /// stale print is not a market. Desktop applies this identical rule, so
    /// the two clients cannot disagree about whether an order can be sent.
    var hasTradeableQuote: Bool { bid > 0 && ask > 0 && bid <= ask }
}

extension OptionContract {
    /// Nil for an unknown optionType: silently treating it as a call would
    /// misprice and mis-trade the contract.
    init?(dto: OptionContractDTO) {
        guard let optionType = OptionType(rawValue: dto.optionType) else { return nil }
        self.init(
            symbol: dto.symbol,
            underlying: dto.underlying,
            expiration: dto.expiration,
            strike: dto.strike,
            optionType: optionType,
            bid: dto.bid,
            ask: dto.ask,
            last: dto.last
        )
    }
}

struct OptionsChain: Equatable, Sendable {
    let underlying: String
    let underlyingPrice: Double
    let expirations: [String]
    /// `var` so OptionsChainViewModel can merge lazily-fetched expirations.
    var contracts: [OptionContract]
}

extension OptionsChain {
    init(dto: OptionsChainDTO) {
        self.init(
            underlying: dto.underlying,
            underlyingPrice: dto.underlyingPrice,
            expirations: dto.expirations,
            contracts: dto.contracts.compactMap(OptionContract.init(dto:))
        )
    }
}

struct OrderPreview: Equatable, Sendable {
    let contractSymbol: String
    let price: Double
    let estBuyingPower: Double
    /// The quote the server priced against; nil from a server that predates it.
    let bid: Double?
    let ask: Double?
    let warnings: [String]
}

extension OrderPreview {
    init(dto: OrderPreviewDTO) {
        self.init(
            contractSymbol: dto.resolved.contractSymbol,
            price: dto.resolved.price,
            estBuyingPower: dto.resolved.estBuyingPower,
            bid: dto.resolved.bid,
            ask: dto.resolved.ask,
            warnings: dto.warnings
        )
    }
}

struct OrderResult: Equatable, Sendable, Identifiable {
    var id: String { orderId }
    let orderId: String
    let status: OrderStatus
    let contractSymbol: String
    let side: OrderSide
    let quantity: Int
    let orderType: OrderType
    let limitPrice: Double?
    let filledPrice: Double?
    let timestamp: Date
}

extension OrderResult {
    init(dto: OrderResultDTO) {
        self.init(
            orderId: dto.orderId,
            status: OrderStatus(tolerant: dto.status),
            contractSymbol: dto.contractSymbol,
            side: OrderSide(rawValue: dto.side) ?? .buy,
            quantity: dto.quantity,
            orderType: OrderType(rawValue: dto.orderType) ?? .market,
            limitPrice: dto.limitPrice,
            filledPrice: dto.filledPrice,
            timestamp: DateParsing.dateTime(dto.timestamp) ?? Date(timeIntervalSince1970: 0)
        )
    }
}

struct Position: Equatable, Sendable, Identifiable {
    var id: String { symbol }
    let symbol: String
    let assetClass: AssetClass
    let quantity: Int
    let avgPrice: Double
    var markPrice: Double
    var unrealizedPnl: Double
    /// Contract multiplier (options: 100) for live P/L math.
    let multiplier: Double
    /// Underlying price the position was opened at — the authoritative
    /// fill-time record, and the level the chart's entry line sits at. Nil
    /// when the server has no record of it (including while the backend
    /// cannot observe the underlying at fill time).
    var underlyingEntryPrice: Double?
    /// Placement-time-quote-derived estimate of the same level, sent while
    /// `underlyingEntryPrice` is absent. Display fallback only — anything
    /// that moves or arms an order must use the authoritative record, never
    /// this.
    var underlyingEntryEstimate: Double? = nil
    /// When the fill that opened the current position run happened. Nil when
    /// the server has no record of it.
    var openedAt: Date? = nil
}

extension Position {
    /// Nil for an unknown assetClass: defaulting to .option would route a
    /// flatten through the options path and build a wrong close order.
    init?(dto: PositionDTO) {
        guard let assetClass = AssetClass(rawValue: dto.assetClass) else { return nil }
        self.init(
            symbol: dto.symbol,
            assetClass: assetClass,
            quantity: dto.quantity,
            avgPrice: dto.avgPrice,
            markPrice: dto.markPrice,
            unrealizedPnl: dto.unrealizedPnl,
            multiplier: dto.multiplier,
            underlyingEntryPrice: dto.underlyingEntryPrice,
            underlyingEntryEstimate: dto.underlyingEntryEstimate,
            openedAt: dto.openedAt.flatMap(DateParsing.dateTime)
        )
    }
}
