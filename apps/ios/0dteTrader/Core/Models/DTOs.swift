import Foundation
// DTOs intentionally remain together so every HTTP and socket wire shape is
// reviewable as one contract surface.
// swiftlint:disable file_length

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

enum OrderBookProviderDTO: String, Decodable, Equatable, Sendable {
    case webull
}

enum OrderBookCapabilityDTO: String, Decodable, Equatable, Sendable {
    case nasdaqTotalViewNonDisplay = "nasdaq_totalview_non_display"
}

enum OrderBookFreshnessDTO: String, Decodable, Equatable, Sendable {
    case fresh
    case stale
}

enum OrderBookUnavailableReasonDTO: String, Decodable, Equatable, Sendable {
    case unsupportedInstrument = "unsupported_instrument"
    case entitlementMissing = "entitlement_missing"
    case providerUnconfigured = "provider_unconfigured"
    case invalidCredentials = "invalid_credentials"
    case providerError = "provider_error"
    case rateLimiterUnavailable = "rate_limiter_unavailable"
    case requestTimeout = "request_timeout"
    case noData = "no_data"
    case marketClosed = "market_closed"
    case stale
    case invalidBook = "invalid_book"
    case disconnected
}

struct OrderBookLevelDTO: Decodable, Equatable, Sendable {
    let price: Double
    let size: Double
}

struct OrderBookSnapshotDTO: Decodable, Equatable, Sendable {
    let symbol: String
    let provider: OrderBookProviderDTO
    let capability: OrderBookCapabilityDTO
    let freshness: OrderBookFreshnessDTO
    let timestamp: String
    let receivedAt: String
    let depth: Int
    let bids: [OrderBookLevelDTO]
    let asks: [OrderBookLevelDTO]
}

struct OrderBookIndicatorsDTO: Decodable, Equatable, Sendable {
    let spreadAbs: Double?
    let spreadBps: Double?
    let spreadPercentile: Double?
    let topBookImbalance: Double?
    let tickPressure: Double?
    let depthImbalance: Double?
    let cumulativePressure: Double?
    let touchDepletion: Double?
}

struct L2SnapshotPayloadDTO: Decodable, Equatable, Sendable {
    let snapshot: OrderBookSnapshotDTO
    let indicators: OrderBookIndicatorsDTO
}

enum OrderBookStatusDTO: Decodable, Equatable, Sendable {
    case available(
        symbol: String,
        provider: OrderBookProviderDTO,
        capability: OrderBookCapabilityDTO
    )
    case unavailable(
        symbol: String,
        provider: OrderBookProviderDTO?,
        capability: OrderBookCapabilityDTO?,
        freshness: OrderBookFreshnessDTO?,
        reason: OrderBookUnavailableReasonDTO,
        message: String,
        retryable: Bool
    )

    var symbol: String {
        switch self {
        case .available(let symbol, _, _), .unavailable(let symbol, _, _, _, _, _, _): symbol
        }
    }

    var unavailableMessage: String? {
        guard case .unavailable(_, _, _, _, _, let message, _) = self else { return nil }
        return message
    }

    var isAvailable: Bool {
        if case .available = self { return true }
        return false
    }

    private enum CodingKeys: String, CodingKey {
        case availability, symbol, provider, capability, freshness, reason, message, retryable
    }

    private enum Availability: String, Decodable {
        case available
        case unavailable
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Availability.self, forKey: .availability) {
        case .available:
            guard try values.decode(OrderBookFreshnessDTO.self, forKey: .freshness) == .fresh else {
                throw DecodingError.dataCorruptedError(
                    forKey: .freshness,
                    in: values,
                    debugDescription: "Available L2 status must be fresh."
                )
            }
            self = .available(
                symbol: try values.decode(String.self, forKey: .symbol),
                provider: try values.decode(OrderBookProviderDTO.self, forKey: .provider),
                capability: try values.decode(OrderBookCapabilityDTO.self, forKey: .capability)
            )
        case .unavailable:
            self = .unavailable(
                symbol: try values.decode(String.self, forKey: .symbol),
                provider: try values.decodeIfPresent(OrderBookProviderDTO.self, forKey: .provider),
                capability: try values.decodeIfPresent(OrderBookCapabilityDTO.self, forKey: .capability),
                freshness: try values.decodeIfPresent(OrderBookFreshnessDTO.self, forKey: .freshness),
                reason: try values.decode(OrderBookUnavailableReasonDTO.self, forKey: .reason),
                message: try values.decode(String.self, forKey: .message),
                retryable: try values.decode(Bool.self, forKey: .retryable)
            )
        }
    }
}

enum IVAlertSymbolDTO: String, Codable, CaseIterable, Equatable, Sendable {
    case SPX
    case NDX
    case RUT
}

enum IVAlertDirectionDTO: String, Decodable, Equatable, Sendable {
    case expansion
    case crush
}

struct IVAlertConfigurationDTO: Codable, Equatable, Sendable {
    let enabled: Bool
    let symbols: [IVAlertSymbolDTO]
    let lookbackMinutes: Int
    let thresholdK: Double
    let consecutiveBreaches: Int
    let warmupMinutes: Int
    let warmupSamples: Int
    let cooldownMinutes: Int
}

struct IVAlertConfigurationStateDTO: Decodable, Equatable, Sendable {
    let enabled: Bool
    let symbols: [IVAlertSymbolDTO]
    let lookbackMinutes: Int
    let thresholdK: Double
    let consecutiveBreaches: Int
    let warmupMinutes: Int
    let warmupSamples: Int
    let cooldownMinutes: Int
    let schemaVersion: Int
    let updatedAt: String
}

struct IVAlertDTO: Decodable, Equatable, Sendable {
    let symbol: IVAlertSymbolDTO
    let direction: IVAlertDirectionDTO
    let currentIv: Double
    let baselineIv: Double
    let zScore: Double
    let timestamp: String
}

// MARK: - Trading

struct OrderSelectionDTO: Encodable, Equatable, Sendable {
    let mode: String
    let optionType: String?
    let expiration: String?
    let strike: Double?
    var classicFallbackAcknowledged: Bool? = nil
    var autoScoring: AutoScoringSelectionDTO? = nil
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
    /// the authoritative fill-time record. Absent for positions opened before
    /// it was recorded, or outside the app — and absent from servers that
    /// cannot yet observe the underlying at fill time.
    let underlyingEntryPrice: Double?
    /// Placement-time-quote-derived estimate of the same level, sent while
    /// `underlyingEntryPrice` is absent. Display fallback only.
    let underlyingEntryEstimate: Double?
    /// ISO-8601 time of the fill that opened the current position run. Absent
    /// for positions opened before it was recorded, or outside the app.
    let openedAt: String?
}

// MARK: - Push notifications

/// Device push registration (POST /v1/notifications/devices).
struct DeviceRegistrationDTO: Encodable, Equatable, Sendable {
    /// Lowercase-hex APNs device token.
    let token: String
    let platform: String
}

// MARK: - Discord and legal/compliance

struct DiscordNotificationSettingsDTO: Codable, Equatable, Sendable {
    let configured: Bool
    let maskedWebhookUrl: String?
    var enabled: Bool
    var includePnl: Bool
}

struct DiscordNotificationSettingsUpdateDTO: Encodable, Equatable, Sendable {
    let webhookUrl: String?
    let enabled: Bool
    let includePnl: Bool
}

enum LegalDocumentSlug: String, Codable, Equatable, Sendable, Identifiable {
    case about
    case terms
    case privacy
    case risk
    case openSourceLicenses = "open-source-licenses"

    var id: String { rawValue }
}

struct LegalDocumentSummaryDTO: Decodable, Equatable, Sendable, Identifiable {
    let slug: LegalDocumentSlug
    let title: String
    let version: String
    let publicUrl: String
    let requiresAcceptance: Bool
    let acceptedAt: String?
    let accepted: Bool?

    var id: String { slug.rawValue }
}

struct LegalDocumentDTO: Decodable, Equatable, Sendable {
    let slug: LegalDocumentSlug
    let title: String
    let version: String
    let publicUrl: String
    let requiresAcceptance: Bool
    let markdown: String
}

struct LegalAcceptanceStatusDTO: Decodable, Equatable, Sendable {
    let documents: [LegalDocumentSummaryDTO]
}

struct LegalAcceptanceRequestDTO: Encodable, Equatable, Sendable {
    let document: String
    let version: String
}

struct DeleteAccountRequestDTO: Encodable, Equatable, Sendable {
    let confirmEmail: String
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
    let internalOrderId: String
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

    private enum CodingKeys: String, CodingKey {
        case internalOrderId
        case orderId
        case status
        case contractSymbol
        case side
        case quantity
        case orderType
        case limitPrice
        case filledPrice
        case timestamp
        case realizedPnl
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        orderId = try container.decode(String.self, forKey: .orderId)
        if let decodedInternalId = try container.decodeIfPresent(
            String.self,
            forKey: .internalOrderId
        ), !decodedInternalId.isEmpty {
            internalOrderId = decodedInternalId
        } else {
            // Older API instances do not return the app-owned UUID. Their
            // broker id was the only available list identity, so preserve
            // history during a rolling deployment instead of failing decode.
            internalOrderId = orderId
        }
        status = try container.decode(String.self, forKey: .status)
        contractSymbol = try container.decode(String.self, forKey: .contractSymbol)
        side = try container.decode(String.self, forKey: .side)
        quantity = try container.decode(Int.self, forKey: .quantity)
        orderType = try container.decode(String.self, forKey: .orderType)
        limitPrice = try container.decodeIfPresent(Double.self, forKey: .limitPrice)
        filledPrice = try container.decodeIfPresent(Double.self, forKey: .filledPrice)
        timestamp = try container.decode(String.self, forKey: .timestamp)
        realizedPnl = try container.decodeIfPresent(Double.self, forKey: .realizedPnl)
    }
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

struct SocketL2SubscribeMessage: Encodable, Sendable {
    let type = "l2Subscribe"
    let symbol: String
    let levels: Int
}

struct SocketL2UnsubscribeMessage: Encodable, Sendable {
    let type = "l2Unsubscribe"
    let symbol: String
}

struct SocketIVAlertConfigureMessage: Encodable, Sendable {
    let type = "ivAlertConfigure"
    let data: IVAlertConfigurationDTO
}

struct SocketEnvelope: Decodable, Sendable {
    let type: String
}

struct SocketQuoteMessage: Decodable, Sendable {
    let data: QuoteDTO
}

struct SocketL2SnapshotMessage: Decodable, Sendable {
    let data: L2SnapshotPayloadDTO
}

struct SocketL2StatusMessage: Decodable, Sendable {
    let data: OrderBookStatusDTO
}

struct SocketIVAlertMessage: Decodable, Sendable {
    let data: IVAlertDTO
}

struct SocketIVAlertConfigurationMessage: Decodable, Sendable {
    let data: IVAlertConfigurationStateDTO
}

struct SocketChartOrderMessage: Decodable, Sendable {
    let data: ChartOrderDTO
    let eventId: String?
    let sequence: Int?
}

struct SocketOrderUpdateMessage: Decodable, Sendable {
    let data: OrderResultDTO
    let eventId: String?
    let sequence: Int?
}

struct SocketEventCursorMessage: Decodable, Sendable {
    let sequence: Int
}

struct SocketErrorMessage: Decodable, Sendable {
    let error: APIErrorBody
}
