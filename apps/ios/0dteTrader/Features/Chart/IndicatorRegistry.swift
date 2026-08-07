import Foundation

enum IndicatorPane: String, Codable, Sendable {
    case overlay
    case subpane
}

enum IndicatorParameterKind: String, Codable, Sendable {
    case integer
    case number
    case timestamp
}

enum IndicatorGeometryKind: String, Codable, CaseIterable, Sendable {
    case line
    case multiLine = "multi_line"
    case band
    case cloud
    case histogram
    case segmentedLine = "segmented_line"
    case priceProfile = "price_profile"
}

struct IndicatorParameterDescriptor: Codable, Equatable, Sendable {
    let id: String
    let label: String
    let kind: IndicatorParameterKind
    let minimum: Double
    let maximum: Double
    let `default`: Double
    let zeroMeansSessionAnchor: Bool?
}

struct IndicatorConstraint: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
        case lessThan = "less_than"
    }

    let kind: Kind
    let left: String
    let right: String
    let message: String
}

struct IndicatorSeriesDescriptor: Codable, Equatable, Sendable {
    let id: String
    let label: String
    let styleToken: String
    let renderAs: String?
}

struct IndicatorGeometryDescriptor: Codable, Equatable, Sendable {
    let kind: IndicatorGeometryKind
    let series: [IndicatorSeriesDescriptor]
    let sessionWindow: Bool?
    let fixedWindowSeconds: Int?
}

struct IndicatorSetting: Codable, Equatable, Sendable {
    var enabled: Bool
    var parameters: [String: Double]
}

struct IndicatorDescriptor: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let displayName: String
    let pane: IndicatorPane
    let requiresL2: Bool
    let parameters: [String: IndicatorParameterDescriptor]
    let constraints: [IndicatorConstraint]?
    let defaultSettings: IndicatorSetting
    let styleTokens: [String: String]?
    let geometry: IndicatorGeometryDescriptor
}

enum IndicatorRegistryError: LocalizedError, Equatable {
    case resourceMissing
    case unsupportedVersion(Int)
    case invalid(String)

    var errorDescription: String? {
        switch self {
        case .resourceMissing:
            return "The indicator registry is unavailable."
        case .unsupportedVersion(let version):
            return "Unsupported indicator registry version \(version)."
        case .invalid(let message):
            return message
        }
    }
}

struct IndicatorRegistry: Codable, Equatable, Sendable {
    let version: Int
    let maxSubPanes: Int
    let paneLimitMessage: String
    let indicators: [IndicatorDescriptor]

    static func bundled(bundle: Bundle = .main) throws -> IndicatorRegistry {
        guard let url = bundle.url(forResource: "indicator-registry", withExtension: "json") else {
            throw IndicatorRegistryError.resourceMissing
        }
        let registry = try JSONDecoder().decode(IndicatorRegistry.self, from: Data(contentsOf: url))
        try registry.validate()
        return registry
    }

    func descriptor(id: String) -> IndicatorDescriptor? {
        indicators.first { $0.id == id }
    }

    func validate() throws {
        guard version == 1 else { throw IndicatorRegistryError.unsupportedVersion(version) }
        guard maxSubPanes > 0, !paneLimitMessage.isEmpty else {
            throw IndicatorRegistryError.invalid("Indicator pane policy is invalid.")
        }
        guard Set(indicators.map(\.id)).count == indicators.count else {
            throw IndicatorRegistryError.invalid("Indicator identifiers must be unique.")
        }
        for descriptor in indicators {
            guard !descriptor.id.isEmpty, !descriptor.displayName.isEmpty else {
                throw IndicatorRegistryError.invalid("Indicator identity is invalid.")
            }
            guard Set(descriptor.geometry.series.map(\.id)).count == descriptor.geometry.series.count else {
                throw IndicatorRegistryError.invalid("\(descriptor.id) has duplicate geometry series.")
            }
            guard Set(descriptor.defaultSettings.parameters.keys) == Set(descriptor.parameters.keys) else {
                throw IndicatorRegistryError.invalid("\(descriptor.id) defaults do not match its parameters.")
            }
            for (id, parameter) in descriptor.parameters {
                guard id == parameter.id,
                      parameter.minimum.isFinite,
                      parameter.maximum.isFinite,
                      parameter.default.isFinite,
                      parameter.minimum <= parameter.default,
                      parameter.default <= parameter.maximum,
                      parameter.minimum <= parameter.maximum
                else {
                    throw IndicatorRegistryError.invalid("\(descriptor.id).\(id) is invalid.")
                }
                if parameter.kind == .integer || parameter.kind == .timestamp,
                   parameter.default.rounded() != parameter.default {
                    throw IndicatorRegistryError.invalid("\(descriptor.id).\(id) must use an integer default.")
                }
            }
        }
        _ = try IndicatorSettingsState.defaults(for: self)
    }
}

struct IndicatorSettingsState: Codable, Equatable, Sendable {
    let registryVersion: Int
    var indicators: [String: IndicatorSetting]

    static func defaults(for registry: IndicatorRegistry) throws -> IndicatorSettingsState {
        let state = IndicatorSettingsState(
            registryVersion: registry.version,
            indicators: Dictionary(uniqueKeysWithValues: registry.indicators.map { descriptor in
                (descriptor.id, descriptor.defaultSettings)
            })
        )
        try IndicatorSettingsValidator.validate(state, registry: registry)
        return state
    }

}

struct ChartDisplayPreferences: Codable, Equatable, Sendable {
    var volumeEnabled: Bool
    /// TradingView-style volume-weighted candle body width; wick stays fixed.
    var volumeWeightedCandleWidth: Bool

    static let `default` = ChartDisplayPreferences(volumeEnabled: true, volumeWeightedCandleWidth: false)

    init(volumeEnabled: Bool, volumeWeightedCandleWidth: Bool) {
        self.volumeEnabled = volumeEnabled
        self.volumeWeightedCandleWidth = volumeWeightedCandleWidth
    }

    /// A record persisted before `volumeWeightedCandleWidth` existed decodes
    /// with the field defaulted to `false`, rather than failing with
    /// `keyNotFound` and falling back to `.default` — which would also
    /// silently reset `volumeEnabled` for anyone who had turned it off.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        volumeEnabled = try container.decode(Bool.self, forKey: .volumeEnabled)
        volumeWeightedCandleWidth =
            try container.decodeIfPresent(Bool.self, forKey: .volumeWeightedCandleWidth) ?? false
    }
}

enum IndicatorSettingsValidationError: LocalizedError, Equatable {
    case invalid(String)
    case paneLimit(String)

    var errorDescription: String? {
        switch self {
        case .invalid(let message), .paneLimit(let message): return message
        }
    }
}

enum IndicatorSettingsValidator {
    static func validate(_ state: IndicatorSettingsState, registry: IndicatorRegistry) throws {
        guard state.registryVersion == registry.version else {
            throw IndicatorSettingsValidationError.invalid("Indicator settings version is unsupported.")
        }
        let descriptors = Dictionary(uniqueKeysWithValues: registry.indicators.map { ($0.id, $0) })
        guard Set(state.indicators.keys) == Set(descriptors.keys) else {
            throw IndicatorSettingsValidationError.invalid("Indicator settings contain unknown or missing identifiers.")
        }

        var subPaneCount = 0
        for (id, setting) in state.indicators {
            guard let descriptor = descriptors[id] else {
                throw IndicatorSettingsValidationError.invalid("Unknown indicator \(id).")
            }
            guard Set(setting.parameters.keys) == Set(descriptor.parameters.keys) else {
                throw IndicatorSettingsValidationError.invalid("\(id) contains unknown or missing parameters.")
            }
            for (parameterId, value) in setting.parameters {
                guard let parameter = descriptor.parameters[parameterId],
                      value.isFinite,
                      value >= parameter.minimum,
                      value <= parameter.maximum
                else {
                    throw IndicatorSettingsValidationError.invalid("\(id).\(parameterId) is out of range.")
                }
                if parameter.kind == .integer || parameter.kind == .timestamp,
                   value.rounded() != value {
                    throw IndicatorSettingsValidationError.invalid("\(id).\(parameterId) must be an integer.")
                }
            }
            for constraint in descriptor.constraints ?? [] {
                guard let left = setting.parameters[constraint.left],
                      let right = setting.parameters[constraint.right]
                else {
                    throw IndicatorSettingsValidationError.invalid(constraint.message)
                }
                if constraint.kind == .lessThan, left >= right {
                    throw IndicatorSettingsValidationError.invalid(constraint.message)
                }
            }
            if setting.enabled, descriptor.pane == .subpane { subPaneCount += 1 }
        }
        guard subPaneCount <= registry.maxSubPanes else {
            throw IndicatorSettingsValidationError.paneLimit(registry.paneLimitMessage)
        }
    }
}
