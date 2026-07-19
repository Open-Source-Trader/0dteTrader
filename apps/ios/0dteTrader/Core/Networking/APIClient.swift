import Foundation

/// Typed REST client for the 0dteTrader backend.
/// - Attaches `Authorization: Bearer <accessToken>` on authenticated endpoints.
/// - On a 401 it refreshes the access token once (via `SessionStore`) and retries once.
/// - Maps non-2xx responses decoding the `{ "error": { "code", "message" } }` envelope.
struct APIClient: @unchecked Sendable {
    let baseURL: URL

    private let sessionStore: SessionStore
    private let urlSession: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(baseURL: URL, sessionStore: SessionStore, urlSession: URLSession = .shared) {
        self.baseURL = baseURL
        self.sessionStore = sessionStore
        self.urlSession = urlSession
    }

    // MARK: - Core request pipeline

    /// Performs the request and returns raw response data, handling auth + one refresh-retry.
    private func perform(_ endpoint: Endpoint, body: Data?, allowRetry: Bool) async throws -> Data {
        var request = try makeRequest(endpoint, body: body)
        if endpoint.requiresAuth, let token = await sessionStore.currentAccessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch {
            throw APIError.network(underlying: error.localizedDescription)
        }
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.network(underlying: "Invalid response")
        }

        if httpResponse.statusCode == 401, endpoint.requiresAuth, allowRetry {
            // Refresh throws APIError.unauthorized when the session is unrecoverable.
            _ = try await sessionStore.refreshAccessToken()
            return try await perform(endpoint, body: body, allowRetry: false)
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            if let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data) {
                throw APIError.server(
                    code: envelope.error.code,
                    message: envelope.error.message,
                    status: httpResponse.statusCode
                )
            }
            throw APIError.httpStatus(httpResponse.statusCode)
        }
        return data
    }

    private func makeRequest(_ endpoint: Endpoint, body: Data?) throws -> URLRequest {
        let url = baseURL.appendingPathComponent(endpoint.path)
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidRequest
        }
        if !endpoint.query.isEmpty {
            components.queryItems = endpoint.query
        }
        guard let finalURL = components.url else {
            throw APIError.invalidRequest
        }
        var request = URLRequest(url: finalURL)
        request.httpMethod = endpoint.method.rawValue
        request.timeoutInterval = 15
        for (field, value) in endpoint.headers {
            request.setValue(value, forHTTPHeaderField: field)
        }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func request<T: Decodable>(_ endpoint: Endpoint, body: Data? = nil) async throws -> T {
        let data = try await perform(endpoint, body: body, allowRetry: true)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding
        }
    }

    private func requestVoid(_ endpoint: Endpoint, body: Data? = nil) async throws {
        _ = try await perform(endpoint, body: body, allowRetry: true)
    }

    private func encode<Body: Encodable>(_ body: Body) throws -> Data {
        try encoder.encode(body)
    }

    // MARK: - Typed endpoints (docs/API-SPEC.md, docs/openapi.yaml)

    func register(email: String, password: String) async throws -> AuthTokensDTO {
        let endpoint = Endpoint(method: .post, path: "v1/auth/register", requiresAuth: false)
        return try await request(endpoint, body: encode(CredentialsDTO(email: email, password: password)))
    }

    func login(email: String, password: String) async throws -> AuthTokensDTO {
        let endpoint = Endpoint(method: .post, path: "v1/auth/login", requiresAuth: false)
        return try await request(endpoint, body: encode(CredentialsDTO(email: email, password: password)))
    }

    func me() async throws -> MeDTO {
        try await request(Endpoint(method: .get, path: "v1/me"))
    }

    @discardableResult
    func putWebullCredentials(_ credentials: WebullCredentialsInputDTO) async throws -> WebullConfiguredResponseDTO {
        let endpoint = Endpoint(method: .put, path: "v1/me/webull-credentials")
        return try await request(endpoint, body: encode(credentials))
    }

    func deleteWebullCredentials() async throws {
        try await requestVoid(Endpoint(method: .delete, path: "v1/me/webull-credentials"))
    }

    /// Mint a fresh Webull access token from the stored credentials (the
    /// server side of the Reconnect button).
    func refreshWebullSession() async throws {
        try await requestVoid(Endpoint(method: .post, path: "v1/me/webull-session/refresh"))
    }

    func quote(symbol: String) async throws -> QuoteDTO {
        let endpoint = Endpoint(
            method: .get,
            path: "v1/market/quote",
            query: [URLQueryItem(name: "symbol", value: symbol)]
        )
        return try await request(endpoint)
    }

    func candles(symbol: String, interval: String, from: Date? = nil, to: Date? = nil) async throws -> [CandleDTO] {
        var query = [
            URLQueryItem(name: "symbol", value: symbol),
            URLQueryItem(name: "interval", value: interval),
        ]
        let formatter = ISO8601DateFormatter()
        if let from {
            query.append(URLQueryItem(name: "from", value: formatter.string(from: from)))
        }
        if let to {
            query.append(URLQueryItem(name: "to", value: formatter.string(from: to)))
        }
        return try await request(Endpoint(method: .get, path: "v1/market/candles", query: query))
    }

    func optionsChain(symbol: String, expiration: String? = nil) async throws -> OptionsChainDTO {
        var query = [URLQueryItem(name: "symbol", value: symbol)]
        if let expiration {
            query.append(URLQueryItem(name: "expiration", value: expiration))
        }
        return try await request(Endpoint(method: .get, path: "v1/market/options-chain", query: query))
    }

    /// Dealer GEX/DEX levels + premium heat map (Tradier-backed, server-side).
    func gexLevels(symbol: String, expiration: String? = nil) async throws -> GexLevelsDTO {
        var query = [URLQueryItem(name: "symbol", value: symbol)]
        if let expiration {
            query.append(URLQueryItem(name: "expiration", value: expiration))
        }
        return try await request(Endpoint(method: .get, path: "v1/market/gex", query: query))
    }

    func orderHistory() async throws -> TradeHistoryDTO {
        try await request(Endpoint(method: .get, path: "v1/orders/history"))
    }

    func previewOrder(_ order: OrderRequestDTO) async throws -> OrderPreviewDTO {
        let endpoint = Endpoint(method: .post, path: "v1/orders/preview")
        return try await request(endpoint, body: encode(order))
    }

    func placeOrder(_ order: OrderRequestDTO, idempotencyKey: String) async throws -> OrderResultDTO {
        let endpoint = Endpoint(
            method: .post,
            path: "v1/orders",
            headers: ["Idempotency-Key": idempotencyKey]
        )
        return try await request(endpoint, body: encode(order))
    }

    func openOrders() async throws -> [OrderResultDTO] {
        try await request(Endpoint(method: .get, path: "v1/orders"))
    }

    func cancelOrder(orderId: String) async throws {
        try await requestVoid(Endpoint(method: .delete, path: "v1/orders/\(orderId)"))
    }

    func positions() async throws -> [PositionDTO] {
        try await request(Endpoint(method: .get, path: "v1/positions"))
    }
}
