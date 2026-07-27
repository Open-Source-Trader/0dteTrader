import Foundation

/// Typed, compile-time environment selection.
///
/// The active environment is chosen by build configuration:
/// - **Debug** → `.development`
/// - **Staging** → `.staging`
/// - **Release** → `.production`
///
/// The `apiBaseURL` is loaded from the top-level `.env` file at
/// build time via `scripts/generate-env.sh` (see `project.yml`).
/// Override `API_BASE_URL` in `.env` to point at any backend.
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
        URL(string: GeneratedEnvironment.apiBaseURL)!
    }

    var streamURL: URL {
        ServerConfigStore.streamURL(for: apiBaseURL)
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
