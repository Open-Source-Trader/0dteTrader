import Foundation

/// Runtime server selection: a `UserDefaults` override of the build-time API
/// base URL, so self-hosters can point the app at their own backend (#59).
/// Mirrors `apps/desktop/src/core/api/ServerConfigStore.ts`.
final class ServerConfigStore: ObservableObject {
    static let storageKey = "serverBaseURL"

    /// The active base URL: the stored override if valid, else the build-time default.
    @Published private(set) var baseURL: URL

    private let defaults: UserDefaults
    private let defaultBaseURL: URL

    init(
        defaults: UserDefaults = .standard,
        defaultBaseURL: URL = AppEnvironment.current.apiBaseURL
    ) {
        self.defaults = defaults
        self.defaultBaseURL = defaultBaseURL
        self.baseURL = Self.storedBaseURL(in: defaults) ?? defaultBaseURL
    }

    /// The stored override if valid, else the build-time default.
    func load() -> URL {
        Self.storedBaseURL(in: defaults) ?? defaultBaseURL
    }

    /// Normalizes, validates, and persists a new base URL. Throws on invalid input.
    @discardableResult
    func save(_ input: String) throws -> URL {
        let url = try Self.normalize(input)
        defaults.set(url.absoluteString, forKey: Self.storageKey)
        baseURL = url
        return url
    }

    /// Clears the override, reverting to the build-time default.
    func reset() {
        defaults.removeObject(forKey: Self.storageKey)
        baseURL = defaultBaseURL
    }

    // MARK: - Normalization

    /// Trims, strips trailing `/` and a pasted `/v1` (or `/v1/health`) suffix,
    /// and validates a bare http(s) origin. Anything else — a leftover path,
    /// query, fragment, or embedded credentials — is rejected, because the
    /// stream derivation replaces the path with `/v1/stream` and would
    /// silently drop it. The result is rebuilt from scheme+host+port only.
    static func normalize(_ input: String) throws -> URL {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil
        else {
            throw ServerConfigError.invalidURL
        }

        var path = components.path
        while path.hasSuffix("/") { path.removeLast() }
        if path.hasSuffix("/v1/health") {
            path.removeLast("/v1/health".count)
        } else if path.hasSuffix("/v1") {
            path.removeLast("/v1".count)
        }
        guard path.isEmpty else {
            throw ServerConfigError.invalidURL
        }

        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = components.port
        guard let url = origin.url else {
            throw ServerConfigError.invalidURL
        }
        return url
    }

    /// WebSocket stream URL for any API base: `http → ws`, `https → wss`,
    /// path `/v1/stream`.
    static func streamURL(for baseURL: URL) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        components.path = "/v1/stream"
        return components.url!
    }

    // MARK: - Health check

    struct HealthCheckResult: Equatable {
        let ok: Bool
        let message: String
    }

    /// Probes `<baseURL>/v1/health` so the user can verify a server before saving.
    static func checkHealth(
        of input: String,
        timeout: TimeInterval = 4,
        urlSession: URLSession = .shared
    ) async -> HealthCheckResult {
        let url: URL
        do {
            url = try normalize(input).appendingPathComponent("v1/health")
        } catch {
            return HealthCheckResult(ok: false, message: error.localizedDescription)
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        do {
            let (_, response) = try await urlSession.data(for: request)
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                return HealthCheckResult(ok: false, message: "Server responded with HTTP \(http.statusCode)")
            }
            return HealthCheckResult(ok: true, message: "Server reachable, API ok")
        } catch let error as URLError where error.code == .timedOut {
            return HealthCheckResult(ok: false, message: "Timed out after \(Int(timeout))s")
        } catch {
            return HealthCheckResult(ok: false, message: "Server unreachable — check the URL")
        }
    }

    // MARK: - Private

    private static func storedBaseURL(in defaults: UserDefaults) -> URL? {
        defaults.string(forKey: storageKey).flatMap { try? normalize($0) }
    }
}

enum ServerConfigError: LocalizedError {
    case invalidURL

    var errorDescription: String? {
        "Enter a valid http(s) URL, e.g. https://your-api.up.railway.app"
    }
}
