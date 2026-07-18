import Foundation

// MARK: - Shared enums (raw values match the API contract)

enum AssetClass: String, Codable, CaseIterable, Sendable {
    case option
    case future
}

enum OrderSide: String, Codable, Sendable {
    case buy
    case sell

    var opposite: OrderSide { self == .buy ? .sell : .buy }
    var displayName: String { rawValue.uppercased() }
}

enum OrderType: String, Codable, CaseIterable, Sendable {
    case mid
    case market

    var displayName: String { self == .mid ? "Mid" : "Market" }
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

struct FuturesContract: Equatable, Sendable, Identifiable {
    var id: String { symbol }
    let symbol: String
    let root: String
    let expiration: String
    let frontMonth: Bool
    let bid: Double
    let ask: Double
    let last: Double

    var mid: Double? { PriceMath.midPrice(bid: bid, ask: ask) }
}

extension FuturesContract {
    init(dto: FuturesContractDTO) {
        self.init(
            symbol: dto.symbol,
            root: dto.root,
            expiration: dto.expiration,
            frontMonth: dto.frontMonth,
            bid: dto.bid,
            ask: dto.ask,
            last: dto.last
        )
    }
}

struct OrderPreview: Equatable, Sendable {
    let contractSymbol: String
    let price: Double
    let estBuyingPower: Double
    let warnings: [String]
}

extension OrderPreview {
    init(dto: OrderPreviewDTO) {
        self.init(
            contractSymbol: dto.resolved.contractSymbol,
            price: dto.resolved.price,
            estBuyingPower: dto.resolved.estBuyingPower,
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
    /// Contract multiplier (options: 100; futures: per spec) for live P/L math.
    let multiplier: Double
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
            multiplier: dto.multiplier
        )
    }
}
