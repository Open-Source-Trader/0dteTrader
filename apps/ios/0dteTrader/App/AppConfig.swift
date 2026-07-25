import Foundation

/// Environment configuration.
///
/// Values are driven by the build configuration (Debug / Staging / Release)
/// via `AppEnvironment.current`. Override the base URL at runtime by setting
/// the `API_BASE_URL` environment variable in the scheme's Run arguments.
enum AppConfig {
    static let apiBaseURL: URL = AppEnvironment.current.apiBaseURL

    /// WebSocket stream URL derived from `apiBaseURL` (`http→ws`, `https→wss`).
    static let streamURL: URL = AppEnvironment.current.streamURL

    /// Base64 SHA-256 hashes of the backend's Subject Public Key Info.
    /// Empty disables pinning (default for local dev over plain HTTP).
    /// Populate for staging and production to enable TLS pinning.
    static let pinnedPublicKeyHashes: [String] = AppEnvironment.current.pinnedPublicKeyHashes
}
