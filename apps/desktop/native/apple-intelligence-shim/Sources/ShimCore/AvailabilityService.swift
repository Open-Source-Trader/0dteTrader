import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

public enum ModelAvailability: Sendable, Equatable {
    case ready
    case unavailable(reason: String)
}

/// Isolates the one call site that reaches into FoundationModels for
/// availability, so the rest of ShimCore stays testable on platforms/CI
/// where the framework doesn't exist. Canonical spec:
/// docs/apple-intelligence/packaging-and-signing.md ("Unsupported macOS
/// versions return an unavailable provider state").
public enum AvailabilityService {
    public static func current() -> ModelAvailability {
        #if canImport(FoundationModels)
        if #available(macOS 26, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return .ready
            case .unavailable(let reason):
                return .unavailable(reason: String(describing: reason))
            @unknown default:
                return .unavailable(reason: "unknown")
            }
        } else {
            return .unavailable(reason: "os-version-unsupported")
        }
        #else
        return .unavailable(reason: "foundation-models-unavailable")
        #endif
    }
}
