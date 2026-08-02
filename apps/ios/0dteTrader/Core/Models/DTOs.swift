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
enum TradingMode: String, Codable, Equatable, Sendable, Hashable {
    case practice
    case live

    /// User-facing label for UI ("Live" / "Practice").
    var label: String {
        switch self {
        case .practice: return "Practice"
        case .live: return "Live"
        }
    }
}

/// Trading provider selected by the user (Webull, Alpaca, or SnapTrade).
/// `tradier` is a stored market-data API key, not a selectable trading
/// provider — it appears only in credential save/delete payloads.
enum BrokerProvider: String, Codable, Equatable, Sendable {
    case webull
    case alpaca
    case snaptrade
    case tradier
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
    /// Tradier market-data API key is stored (used alongside Webull).
    let tradierConfigured: Bool?
    let tradierPracticeConfigured: Bool?
    /// Live SnapTrade Personal clientId/consumerKey are stored.
    let snaptradeKeyConfigured: Bool?
    /// Practice SnapTrade Personal clientId/consumerKey are stored.
    let snaptradeKeyPracticeConfigured: Bool?
    /// Live SnapTrade brokerage connection is active.
    let snaptradeConfigured: Bool?
    /// Practice SnapTrade brokerage connection is active.
    let snaptradePracticeConfigured: Bool?
    /// Live SnapTrade trading account id (chosen from connected accounts).
    let snaptradeAccountId: String?
    /// Practice SnapTrade trading account id; nil until chosen.
    let snaptradePracticeAccountId: String?
}

struct UpdateTradingModeDTO: Encodable, Sendable {
    let tradingMode: TradingMode
}

struct WebullCredentialsInputDTO: Encodable, Sendable {
    let appKey: String
    let appSecret: String
    let environment: TradingMode
}

struct WebullAccountDTO: Decodable, Equatable, Sendable, Identifiable {
    let accountId: String
    let accountType: String?
    let accountName: String?

    var id: String { accountId }
}

struct SelectWebullAccountRequest: Encodable, Sendable {
    let accountId: String
    let environment: TradingMode
}

struct WebullConfiguredResponseDTO: Decodable, Equatable, Sendable {
    let webullConfigured: Bool
}

struct AlpacaCredentialsInputDTO: Encodable, Sendable {
    let provider = "alpaca"
    let apiKey: String
    let apiSecret: String
    let environment: TradingMode
}

struct TradierCredentialsInputDTO: Encodable, Sendable {
    let provider = "tradier"
    let apiKey: String
    let environment: TradingMode
}

/// SnapTrade Personal client ID + consumer key (docs.snaptrade.com/docs/personal-vs-commercial)
/// — the user's own SnapTrade identity, entered the same way as an Alpaca API key. Never
/// server-minted.
struct SnapTradeCredentialsInputDTO: Encodable, Sendable {
    let provider = "snaptrade"
    let clientId: String
    let consumerKey: String
    let environment: TradingMode
}

struct BrokerCredentialsSavedDTO: Decodable, Equatable, Sendable {
    let provider: BrokerProvider
    let configured: Bool
    let environment: TradingMode
}

// MARK: - SnapTrade connection

struct SnapTradeConnectionRecordDTO: Decodable, Equatable, Sendable {
    let connectionId: String
    let brokerage: String
    let name: String
    let type: String
    let status: String
    let accountIds: [String]
    let selectedAccountId: String?
    let createdAt: String
}

struct SnapTradeConnectionStatusDTO: Decodable, Equatable, Sendable {
    let configured: Bool
    let selectedAccountId: String?
}

struct SnapTradeConnectionsResponseDTO: Decodable, Equatable, Sendable {
    let connections: [SnapTradeConnectionRecordDTO]
    let accounts: [String: [SnapTradeAccountDTO]]
    let status: SnapTradeConnectionStatusDTO
}

struct SnapTradeAccountDTO: Decodable, Equatable, Sendable {
    let accountId: String
    let name: String
}

struct SnapTradeAuthorizeResponseDTO: Decodable, Equatable, Sendable {
    let redirectUrl: String
}

struct SnapTradeSelectResponseDTO: Decodable, Equatable, Sendable {
    let accountId: String
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
    /// auto_otm only: strikes OTM from the ATM strike; 0 = ATM; nil (omitted)
    /// means 1. Encoded as absent rather than null when nil, so servers
    /// predating the field see the request shape they always did.
    var otmOffset: Int? = nil
}

struct OrderRequestDTO: Encodable, Equatable, Sendable {
    let underlying: String
    let assetClass: String
    let side: String
    let quantity: Int
    let orderType: String
    /// Only sent for `custom`; the server rejects it alongside any other
    /// variant, because those four are priced from its own quote. Encoded as
    /// absent rather than null when nil — `JSONEncoder` omits a nil `Optional`
    /// by default, which is exactly what the DTO's rule wants to see.
    var limitPrice: Double?
    let selection: OrderSelectionDTO
}

struct OrderPreviewDTO: Decodable, Equatable, Sendable {
    struct Resolved: Decodable, Equatable, Sendable {
        let contractSymbol: String
        let price: Double
        let estBuyingPower: Double
        /// The quote the price was resolved against, so the confirm sheet can
        /// print a custom limit next to the live spread. Optional so a server
        /// older than this field still decodes rather than failing the preview.
        let bid: Double?
        let ask: Double?
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
    /// Quantity-weighted price of the UNDERLYING across the opening fills —
    /// where the chart draws this position's entry line. Absent for positions
    /// opened before it was recorded, or outside the app.
    let underlyingEntryPrice: Double?
    /// ISO-8601 time of the fill that opened the current position run. Absent
    /// for positions opened before it was recorded, or outside the app.
    let openedAt: String?
}

// MARK: - Chart trading

struct ChartOrderDTO: Decodable, Equatable, Sendable {
    let id: String
    let underlying: String
    let triggerPrice: Double
    let armPrice: Double
    let side: String
    let quantity: Int
    let orderType: String
    let kind: String
    let optionType: String
    let expiration: String
    let strike: Double
    let contractSymbol: String
    let ocoGroupId: String?
    let status: String
    let createdAt: String
    let expiresAt: String
    let triggeredAt: String?
    let brokerOrderId: String?
    let lastError: String?
}

struct ChartOrderDraftDTO: Encodable, Equatable, Sendable {
    let underlying: String
    let triggerPrice: Double
    let side: String
    let quantity: Int
    let orderType: String
    let kind: String
    let optionType: String
    let expiration: String
    let strike: Double
    let ocoGroupId: String?
}

/// Every field optional: the server leaves untouched whatever is omitted.
struct ChartOrderPatchDTO: Encodable, Equatable, Sendable {
    var triggerPrice: Double?
    var quantity: Int?
    var orderType: String?
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

struct SocketChartOrderMessage: Decodable, Sendable {
    let data: ChartOrderDTO
}

struct SocketOrderUpdateMessage: Decodable, Sendable {
    let data: OrderResultDTO
}

struct SocketErrorMessage: Decodable, Sendable {
    let error: APIErrorBody
}
