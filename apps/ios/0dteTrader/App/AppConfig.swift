import Foundation

/// Environment configuration. The backend base URL defaults to a locally
/// running API (`npm run dev` → http://localhost:3000, see docs/RUNBOOK.md).
///
/// Physical device: change `apiBaseURL` to your machine's LAN IP.
/// Production: point at the deployed HTTPS origin and populate
/// `pinnedPublicKeyHashes` with the backend's SPKI SHA-256 hashes (base64).
enum AppConfig {
    static let apiBaseURL: URL = makeURL("http://localhost:3000")

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
