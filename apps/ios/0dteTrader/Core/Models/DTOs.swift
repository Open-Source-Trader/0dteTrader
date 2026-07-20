import Foundation

// MARK: - Error envelope
// All API errors decode from `{ "error": { "code": ..., "message": ... } }`.

struct APIErrorBody: Decodable, Equatable, Sendable {
    let code: String
    let message: String
}

struct APIErrorEnvelope: Decodable, Equatable, Sendable {
    let error: APIErrorBody
}

// MARK: - Auth

struct CredentialsDTO: Encodable, Sendable {
    let email: String
    let password: String
}

struct RefreshRequestDTO: Encodable, Sendable {
    let refreshToken: String
}

struct AuthTokensDTO: Decodable, Equatable, Sendable {
    let accessToken: String
    let refreshToken: String
    let expiresIn: Int
}

// MARK: - Profile & credentials

/// Practice/live trading environment (server-persisted; `PATCH /v1/me`).
enum TradingMode: String, Codable, Equatable, Sendable {
    case practice
    case live
}

/// Trading provider selected by the user (Webull or Alpaca).
enum BrokerProvider: String, Codable, Equatable, Sendable {
    case webull
    case alpaca
}

struct MeDTO: Decodable, Equatable, Sendable {
    let id: String
    let email: String
    let tradingDisabled: Bool
    let webullConfigured: Bool
    /// Auto-discovered via Webull account/list; nil until the first
    /// successful connection (and on older servers).
    let webullAccountId: String?
    /// nil on older servers that predate mode switching.
    let tradingMode: TradingMode?
    /// Active trading provider chosen by the user; nil on older servers.
    let tradingProvider: BrokerProvider?
    /// Practice (paper) Webull credentials are stored.
    let webullPracticeConfigured: Bool?
    let webullPracticeAccountId: String?
    /// Live Alpaca credentials are stored.
    let alpacaConfigured: Bool?
    let alpacaPracticeConfigured: Bool?
    /// Alpaca v2 is key-scoped: no account id is stored.
    let alpacaAccountId: String?
    let alpacaPracticeAccountId: String?
}

struct UpdateTradingModeDTO: Encodable, Sendable {
    let tradingMode: TradingMode
}

struct WebullCredentialsInputDTO: Encodable, Sendable {
    let appKey: String
    let appSecret: String
}

struct WebullConfiguredResponseDTO: Decodable, Equatable, Sendable {
    let webullConfigured: Bool
}

struct AlpacaCredentialsInputDTO: Encodable, Sendable {
    let provider = "alpaca"
    let apiKey: String
    let apiSecret: String
}

struct BrokerCredentialsSavedDTO: Decodable, Equatable, Sendable {
    let provider: BrokerProvider
    let configured: Bool
    let environment: TradingMode
}

// MARK: - Market data

struct QuoteDTO: Decodable, Equatable, Sendable {
    let symbol: String
    let bid: Double
    let ask: Double
    let last: Double
    let bidSize: Int
    let askSize: Int
    let volume: Int
    let timestamp: String
}

struct CandleDTO: Decodable, Equatable, Sendable {
    let time: String
    let open: Double
    let high: Double
    let low: Double
    let close: Double
    let volume: Int
}

struct OptionContractDTO: Decodable, Equatable, Sendable {
    let symbol: String
    let underlying: String
    let expiration: String
    let strike: Double
    let optionType: String
    let bid: Double
    let ask: Double
    let last: Double
}

struct OptionsChainDTO: Decodable, Equatable, Sendable {
    let underlying: String
    let underlyingPrice: Double
    let expirations: [String]
    let contracts: [OptionContractDTO]
}

// MARK: - Trading

struct OrderSelectionDTO: Encodable, Equatable, Sendable {
    let mode: String
    let optionType: String?
    let expiration: String?
    let strike: Double?
}

struct OrderRequestDTO: Encodable, Equatable, Sendable {
    let underlying: String
    let assetClass: String
    let side: String
    let quantity: Int
    let orderType: String
    let selection: OrderSelectionDTO
}

struct OrderPreviewDTO: Decodable, Equatable, Sendable {
    struct Resolved: Decodable, Equatable, Sendable {
        let contractSymbol: String
        let price: Double
        let estBuyingPower: Double
    }

    let resolved: Resolved
    let warnings: [String]
}

struct OrderResultDTO: Decodable, Equatable, Sendable {
    let orderId: String
    let status: String
    let contractSymbol: String
    let side: String
    let quantity: Int
    let orderType: String
    let limitPrice: Double?
    let filledPrice: Double?
    let timestamp: String
}

struct PositionDTO: Decodable, Equatable, Sendable {
    let symbol: String
    let assetClass: String
    let quantity: Int
    let avgPrice: Double
    let markPrice: Double
    let unrealizedPnl: Double
    /// Contract multiplier (options: 100) for client-side live P/L.
    let multiplier: Double
}

struct TradeHistoryEntryDTO: Decodable, Equatable, Sendable {
    let orderId: String
    let status: String
    let contractSymbol: String
    let side: String
    let quantity: Int
    let orderType: String
    let limitPrice: Double?
    let filledPrice: Double?
    let timestamp: String
    let realizedPnl: Double?
}

struct TradeHistoryDTO: Decodable, Equatable, Sendable {
    let entries: [TradeHistoryEntryDTO]
    let totalRealizedPnl: Double
}

// MARK: - WebSocket wire messages
// Client → server: `{ "type": "subscribe"|"unsubscribe", "symbols": [...] }`
// Server → client: `{ "type": "quote", "data": Quote }`,
//                  `{ "type": "orderUpdate", "data": OrderResult }`,
//                  `{ "type": "error", "error": { "code", "message" } }`

struct SocketSubscribeMessage: Encodable, Sendable {
    let type: String
    let symbols: [String]
}

struct SocketEnvelope: Decodable, Sendable {
    let type: String
}

struct SocketQuoteMessage: Decodable, Sendable {
    let data: QuoteDTO
}

struct SocketOrderUpdateMessage: Decodable, Sendable {
    let data: OrderResultDTO
}

struct SocketErrorMessage: Decodable, Sendable {
    let error: APIErrorBody
}
