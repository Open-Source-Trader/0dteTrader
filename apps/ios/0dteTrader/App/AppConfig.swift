import Foundation

/// Environment configuration.
///
/// The build-time default base URL is driven by the build configuration
/// (Debug / Staging / Release) via `AppEnvironment.current`. Self-hosters can
/// override it at runtime through `ServerConfigStore` (#59); the container is
/// built from whichever base URL is active.
enum AppConfig {
    /// The build-time default API base URL. Runtime code should use the base
    /// URL the `AppContainer` was built with, not this constant.
    static let defaultAPIBaseURL: URL = AppEnvironment.current.apiBaseURL

    /// Base64 SHA-256 SPKI hashes for TLS pinning, applicable to `baseURL`.
    /// Pins only ever apply to the built-in default host — a user-supplied
    /// (self-hosted) server is never evaluated against our pins, so adding
    /// production pins later cannot break self-hosters.
    static func pinnedPublicKeyHashes(for baseURL: URL) -> [String] {
        pinnedPublicKeyHashes(
            for: baseURL,
            defaultHost: defaultAPIBaseURL.host,
            pins: AppEnvironment.current.pinnedPublicKeyHashes
        )
    }

    /// Testable core of the pinning rule: pins apply iff the host is the
    /// built-in default host.
    static func pinnedPublicKeyHashes(for baseURL: URL, defaultHost: String?, pins: [String]) -> [String] {
        baseURL.host == defaultHost ? pins : []
    }
}
