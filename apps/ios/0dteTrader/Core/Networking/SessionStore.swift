import Foundation

extension Notification.Name {
    /// Posted (from any actor) when the refresh token is rejected and the user must log in again.
    static let sessionDidBecomeUnauthenticated = Notification.Name("com.0dtetrader.sessionDidBecomeUnauthenticated")
}

/// Owns the token lifecycle: access token in memory, refresh token in the Keychain.
/// Refresh calls are de-duplicated — concurrent callers share one in-flight request.
actor SessionStore {
    private let keychainStore: KeychainStore
    private let baseURL: URL
    private let urlSession: URLSession

    private var accessToken: String?
    private var refreshTask: Task<AuthTokensDTO, Error>?

    init(keychainStore: KeychainStore, baseURL: URL, urlSession: URLSession = .shared) {
        self.keychainStore = keychainStore
        self.baseURL = baseURL
        self.urlSession = urlSession
    }

    // MARK: - State

    func currentAccessToken() -> String? {
        accessToken
    }

    func hasStoredRefreshToken() -> Bool {
        (try? keychainStore.readRefreshToken()) != nil
    }

    /// Stores freshly issued tokens after register/login.
    func signIn(with tokens: AuthTokensDTO) throws {
        accessToken = tokens.accessToken
        try keychainStore.saveRefreshToken(tokens.refreshToken)
    }

    /// Attempts to restore a session from the Keychain-stored refresh token (app launch).
    func restoreSession() async -> Bool {
        guard hasStoredRefreshToken() else { return false }
        do {
            _ = try await refreshAccessToken()
            return true
        } catch {
            return false
        }
    }

    /// Returns a usable access token, refreshing first if none is in memory.
    func accessTokenOrRefresh() async throws -> String {
        if let accessToken {
            return accessToken
        }
        return try await refreshAccessToken()
    }

    /// Forces a refresh. Concurrent calls await the same in-flight request.
    func refreshAccessToken() async throws -> String {
        if let refreshTask {
            return try await refreshTask.value.accessToken
        }
        let task = Task<AuthTokensDTO, Error> { [keychainStore, baseURL, urlSession] in
            try await Self.performRefresh(keychainStore: keychainStore, baseURL: baseURL, urlSession: urlSession)
        }
        refreshTask = task
        defer { refreshTask = nil }
        do {
            let tokens = try await task.value
            accessToken = tokens.accessToken
            try keychainStore.saveRefreshToken(tokens.refreshToken) // rotation: server issues a new refresh token every time
            return tokens.accessToken
        } catch {
            if let apiError = error as? APIError, apiError == .unauthorized {
                clearLocalSession()
                NotificationCenter.default.post(name: .sessionDidBecomeUnauthenticated, object: nil)
            }
            throw error
        }
    }

    /// Logs out server-side (best effort) and wipes local tokens.
    func signOut() async {
        let refreshToken = try? keychainStore.readRefreshToken()
        clearLocalSession()
        guard let refreshToken else { return }

        var request = URLRequest(url: baseURL.appendingPathComponent("v1/auth/logout"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(RefreshRequestDTO(refreshToken: refreshToken))
        _ = try? await urlSession.data(for: request)
    }

    private func clearLocalSession() {
        accessToken = nil
        try? keychainStore.deleteRefreshToken()
    }

    // MARK: - Refresh HTTP call

    private static func performRefresh(
        keychainStore: KeychainStore,
        baseURL: URL,
        urlSession: URLSession
    ) async throws -> AuthTokensDTO {
        guard let refreshToken = try keychainStore.readRefreshToken() else {
            throw APIError.unauthorized
        }

        var request = URLRequest(url: baseURL.appendingPathComponent("v1/auth/refresh"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(RefreshRequestDTO(refreshToken: refreshToken))

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
        guard (200...299).contains(httpResponse.statusCode) else {
            if httpResponse.statusCode == 401 {
                throw APIError.unauthorized
            }
            if let envelope = try? JSONDecoder().decode(APIErrorEnvelope.self, from: data) {
                throw APIError.server(
                    code: envelope.error.code,
                    message: envelope.error.message,
                    status: httpResponse.statusCode
                )
            }
            throw APIError.httpStatus(httpResponse.statusCode)
        }
        do {
            return try JSONDecoder().decode(AuthTokensDTO.self, from: data)
        } catch {
            throw APIError.decoding
        }
    }
}
