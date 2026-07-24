import Foundation

/// Typed, compile-time environment selection.
///
/// The active environment is chosen by build configuration:
/// - **Debug** → `.development` (localhost)
/// - **Staging** → `.staging` (Railway staging)
/// - **Release** → `.production` (Railway production)
///
/// Override at runtime by setting the `API_BASE_URL` environment
/// variable in the scheme's Run arguments (useful for QA).
enum AppEnvironment {
    case development, staging, production

    // MARK: - Selection

    static let current: AppEnvironment = {
        #if DEBUG
        .development
        #elseif STAGING
        .staging
        #else
        .production
        #endif
    }()

    // MARK: - Endpoints

    var apiBaseURL: URL {
        switch self {
        case .development:
            return URL(string: "http://localhost:3000")!
        case .staging:
            return URL(string: "https://caring-prosperity-staging.up.railway.app")!
        case .production:
            return URL(string: "https://caring-prosperity-production.up.railway.app")!
        }
    }

    var streamURL: URL {
        var components = URLComponents(url: apiBaseURL, resolvingAgainstBaseURL: false)!
        components.scheme = apiBaseURL.scheme == "https" ? "wss" : "ws"
        components.path = "/v1/stream"
        return components.url!
    }

    // MARK: - Security

    /// SPKI SHA-256 hashes (base64) for TLS public-key pinning.
    /// Empty disables pinning (correct for development over HTTP).
    /// Populate with the backend's SPKI hashes for staging and production.
    var pinnedPublicKeyHashes: [String] {
        switch self {
        case .development:
            return []
        case .staging:
            return []  // TODO: add staging SPKI hash
        case .production:
            return []  // TODO: add production SPKI hash
        }
    }

    // MARK: - Display

    var displayName: String {
        switch self {
        case .development:
            return "Development"
        case .staging:
            return "Staging"
        case .production:
            return "Production"
        }
    }
}
