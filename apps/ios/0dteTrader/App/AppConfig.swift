import Foundation

/// Environment configuration. The backend base URL points at the Railway
/// production deployment. For local dev, swap to http://localhost:3000 or
/// your machine's LAN IP.
///
/// To enable certificate pinning, populate `pinnedPublicKeyHashes` with
/// the backend's SPKI SHA-256 hashes (base64).
enum AppConfig {
    private static let defaultAPIBaseURLString: String = {
        #if DEBUG
        "http://localhost:3000"
        #else
        "https://caring-prosperity-production.up.railway.app"
        #endif
    }()

    static let apiBaseURL: URL = makeURL(ProcessInfo.processInfo.environment["API_BASE_URL"] ?? defaultAPIBaseURLString)

    /// WebSocket stream URL derived from `apiBaseURL` (http→ws, https→wss).
    static let streamURL: URL = makeStreamURL()

    /// Base64 SHA-256 hashes of the backend's Subject Public Key Info.
    /// Empty disables pinning (default for local dev over plain HTTP).
    static let pinnedPublicKeyHashes: [String] = []

    private static func makeURL(_ string: String) -> URL {
        guard let url = URL(string: string) else {
            preconditionFailure("AppConfig: invalid URL constant \(string)")
        }
        return url
    }

    private static func makeStreamURL() -> URL {
        guard var components = URLComponents(url: apiBaseURL, resolvingAgainstBaseURL: false) else {
            preconditionFailure("AppConfig: invalid apiBaseURL")
        }
        components.scheme = apiBaseURL.scheme == "https" ? "wss" : "ws"
        components.path = "/v1/stream"
        guard let url = components.url else {
            preconditionFailure("AppConfig: invalid stream URL")
        }
        return url
    }
}
