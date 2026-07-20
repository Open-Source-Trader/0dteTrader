import Foundation

enum OptionsAnalyticsSettlementStyleDTO: String, Decodable, Equatable, Sendable {
    case am
    case pm
}

struct OptionsAnalyticsScopeDTO: Decodable, Equatable, Sendable {
    let symbol: String
    let rootSymbol: String
    let expiration: String
    let settlementStyle: OptionsAnalyticsSettlementStyleDTO
    let observedAt: String
    let settlementAt: String
    let spot: Double
    let forward: Double
}

struct OptionsAnalyticsCoverageDTO: Decodable, Equatable, Sendable {
    let contractsTotal: Int
    let contractsIncluded: Int
    let ratio: Double
}

enum OptionsAnalyticsFeedModeDTO: String, Decodable, Equatable, Sendable {
    case realtime
    case delayed
    case sandbox
    case unknown
}

enum OptionsAnalyticsStatusDTO: String, Decodable, Equatable, Sendable {
    case complete
    case partial
}

enum OptionsAnalyticsCacheStatusDTO: String, Decodable, Equatable, Sendable {
    case fresh
    case memoryCache = "memory-cache"
    case staleFallback = "stale-fallback"
}

struct OptionsAnalyticsQualityDTO: Decodable, Equatable, Sendable {
    let quoteAsOf: String?
    let greeksAsOf: String?
    let oiEffectiveDate: String?
    let feedMode: OptionsAnalyticsFeedModeDTO
    let coverage: OptionsAnalyticsCoverageDTO
    let status: OptionsAnalyticsStatusDTO
    let warnings: [String]
    let calculationVersion: String
    let cacheStatus: OptionsAnalyticsCacheStatusDTO
}

struct OptionsAnalyticsStructureDTO: Decodable, Equatable, Sendable {
    let callGammaExposure: Double?
    let putGammaExposure: Double?
    let grossGammaExposure: Double?
    let callDeltaNotional: Double?
    let putDeltaNotional: Double?
    let callWall: Double?
    let putWall: Double?
    let grossGammaConcentration: Double?
    let maxOpenInterestStrike: Double?
}

struct OptionsAnalyticsDealerProxyDTO: Decodable, Equatable, Sendable {
    let assumption: String
    let gammaExposure: Double
    let deltaNotional: Double
    let strikeGammaExposures: [OptionsAnalyticsDealerProxyStrikeDTO]
    let gammaRoots: [Double]
    let primaryGammaRoot: Double?
}

struct OptionsAnalyticsDealerProxyStrikeDTO: Decodable, Equatable, Sendable {
    let strike: Double
    let gammaExposure: Double?
}

struct OptionsAnalyticsScenariosDTO: Decodable, Equatable, Sendable {
    let callPutDealerProxy: OptionsAnalyticsDealerProxyDTO?
}

struct OptionsAnalyticsImpliedRangeDTO: Decodable, Equatable, Sendable {
    let lower: Double
    let upper: Double
    let confidence: Double
    let label: String
    let atmIv: Double
    let straddleLower: Double
    let straddleUpper: Double
}

struct OptionsAnalyticsLegDTO: Decodable, Equatable, Sendable {
    let openInterest: Int
    let volume: Int
    let impliedVolatility: Double?
    let delta: Double?
    let gamma: Double?
    let gammaExposure: Double?
    let deltaNotional: Double?
    let markedOiValue: Double?
    let relativeSpread: Double?
    let roundTripCost: Double?
    let bidSize: Int
    let askSize: Int
    let multiplier: Double
}

struct OptionsAnalyticsStrikeDTO: Decodable, Equatable, Sendable {
    let strike: Double
    let call: OptionsAnalyticsLegDTO?
    let put: OptionsAnalyticsLegDTO?
    let grossGammaExposure: Double?
    let totalOpenInterest: Int
}

struct OptionsAnalyticsSnapshotDTO: Decodable, Equatable, Sendable {
    let scope: OptionsAnalyticsScopeDTO
    let exposureUnit: String
    let quality: OptionsAnalyticsQualityDTO
    let structure: OptionsAnalyticsStructureDTO
    let scenarios: OptionsAnalyticsScenariosDTO
    let impliedRange: OptionsAnalyticsImpliedRangeDTO?
    let strikes: [OptionsAnalyticsStrikeDTO]

    private enum CodingKeys: String, CodingKey {
        case scope
        case exposureUnit
        case quality
        case structure
        case scenarios
        case impliedRange
        case strikes
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        scope = try container.decode(OptionsAnalyticsScopeDTO.self, forKey: .scope)
        exposureUnit = try container.decode(String.self, forKey: .exposureUnit)
        quality = try container.decode(OptionsAnalyticsQualityDTO.self, forKey: .quality)
        structure = try container.decode(OptionsAnalyticsStructureDTO.self, forKey: .structure)
        scenarios = try container.decode(OptionsAnalyticsScenariosDTO.self, forKey: .scenarios)
        impliedRange = try container.decodeIfPresent(OptionsAnalyticsImpliedRangeDTO.self, forKey: .impliedRange)
        strikes = try container.decode([OptionsAnalyticsStrikeDTO].self, forKey: .strikes)
        try validateContract()
    }

    func validated(
        expectedSymbol: String,
        expectedExpiration: String
    ) throws -> OptionsAnalyticsSnapshotDTO {
        try validateContract()
        guard scope.symbol == expectedSymbol.uppercased().trimmingCharacters(in: .whitespacesAndNewlines),
              scope.expiration == expectedExpiration
        else {
            throw OptionsAnalyticsContractError.invalid("response key mismatch")
        }
        return self
    }

    private func validateContract() throws {
        try validateScope()
        try validateQuality()
        try validateStructure()
        try validateScenario()
        try validateRange()
        try validateStrikes()
        guard exposureUnit == "$ delta change per 1% underlying move" else {
            throw OptionsAnalyticsContractError.invalid("unsupported exposure unit")
        }
    }

    private func validateScope() throws {
        let observedAt = DateParsing.dateTime(scope.observedAt)
        let settlementAt = DateParsing.dateTime(scope.settlementAt)
        guard !scope.symbol.isEmpty,
              scope.symbol == scope.symbol.uppercased(),
              !scope.rootSymbol.isEmpty,
              scope.rootSymbol == scope.rootSymbol.uppercased(),
              hasValidProductProvenance,
              DateParsing.day(scope.expiration) != nil,
              let observedAt,
              let settlementAt,
              observedAt < settlementAt,
              scope.spot.isFinite,
              scope.spot > 0,
              scope.forward.isFinite,
              scope.forward > 0
        else {
            throw OptionsAnalyticsContractError.invalid("invalid scope")
        }
    }

    private var hasValidProductProvenance: Bool {
        if scope.symbol == "SPX" {
            return (scope.rootSymbol == "SPX" && scope.settlementStyle == .am)
                || (scope.rootSymbol == "SPXW" && scope.settlementStyle == .pm)
        }
        return scope.rootSymbol == scope.symbol && scope.settlementStyle == .pm
    }

    private func validateQuality() throws {
        let coverage = quality.coverage
        let expectedRatio = coverage.contractsTotal == 0
            ? 0
            : Double(coverage.contractsIncluded) / Double(coverage.contractsTotal)
        guard coverage.contractsTotal >= 0,
              coverage.contractsIncluded >= 0,
              coverage.contractsIncluded <= coverage.contractsTotal,
              coverage.ratio.isFinite,
              0...1 ~= coverage.ratio,
              abs(coverage.ratio - expectedRatio) <= 1e-9,
              isValidOptionalDateTime(quality.quoteAsOf),
              isValidOptionalDateTime(quality.greeksAsOf),
              isValidOptionalDay(quality.oiEffectiveDate),
              !quality.calculationVersion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              quality.warnings.allSatisfy({
                  !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              })
        else {
            throw OptionsAnalyticsContractError.invalid("invalid quality metadata")
        }
    }

    private func validateStructure() throws {
        let modeledValues = [
            structure.callGammaExposure,
            structure.putGammaExposure,
            structure.grossGammaExposure,
            structure.callDeltaNotional,
            structure.putDeltaNotional,
        ].compactMap { $0 }
        let optionalPrices = [
            structure.callWall,
            structure.putWall,
            structure.maxOpenInterestStrike,
        ]
        let callModelIsAtomic = (structure.callGammaExposure == nil)
            == (structure.callDeltaNotional == nil)
        let putModelIsAtomic = (structure.putGammaExposure == nil)
            == (structure.putDeltaNotional == nil)
        let expectedGrossGamma = (structure.callGammaExposure ?? 0)
            + (structure.putGammaExposure ?? 0)
        let grossIsConsistent: Bool
        if structure.callGammaExposure == nil, structure.putGammaExposure == nil {
            grossIsConsistent = structure.grossGammaExposure == nil
        } else if let grossGammaExposure = structure.grossGammaExposure {
            grossIsConsistent = abs(grossGammaExposure - expectedGrossGamma)
                <= 1e-6 * max(1, abs(expectedGrossGamma))
        } else {
            grossIsConsistent = false
        }
        guard modeledValues.allSatisfy(\.isFinite),
              structure.callGammaExposure.map({ $0 >= 0 }) ?? true,
              structure.putGammaExposure.map({ $0 >= 0 }) ?? true,
              structure.grossGammaExposure.map({ $0 >= 0 }) ?? true,
              callModelIsAtomic,
              putModelIsAtomic,
              grossIsConsistent,
              optionalPrices.compactMap({ $0 }).allSatisfy({ $0.isFinite && $0 > 0 }),
              structure.grossGammaConcentration.map({ $0.isFinite && 0...1 ~= $0 }) ?? true
        else {
            throw OptionsAnalyticsContractError.invalid("invalid structure")
        }
    }

    private func validateScenario() throws {
        guard let proxy = scenarios.callPutDealerProxy else { return }
        guard !proxy.assumption.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              proxy.gammaExposure.isFinite,
              proxy.deltaNotional.isFinite,
              proxy.strikeGammaExposures.allSatisfy({
                  $0.strike.isFinite
                      && $0.strike > 0
                      && ($0.gammaExposure.map(\.isFinite) ?? true)
              }),
              zip(proxy.strikeGammaExposures, proxy.strikeGammaExposures.dropFirst())
                  .allSatisfy({ $0.0.strike < $0.1.strike }),
              proxy.strikeGammaExposures.map(\.strike) == strikes.map(\.strike),
              proxy.gammaRoots.allSatisfy({ $0.isFinite && $0 > 0 }),
              zip(proxy.gammaRoots, proxy.gammaRoots.dropFirst()).allSatisfy({ $0.0 < $0.1 }),
              proxy.primaryGammaRoot.map({ root in
                  root.isFinite && proxy.gammaRoots.contains(root)
              }) ?? true
        else {
            throw OptionsAnalyticsContractError.invalid("invalid dealer proxy scenario")
        }
    }

    private func validateRange() throws {
        guard let range = impliedRange else { return }
        guard range.label == "model-implied 68% range",
              range.confidence == 0.68,
              [range.lower, range.upper, range.atmIv, range.straddleLower, range.straddleUpper]
                .allSatisfy(\.isFinite),
              range.lower >= 0,
              range.upper > 0,
              range.lower <= range.upper,
              range.straddleLower >= 0,
              range.straddleUpper > 0,
              range.straddleLower <= range.straddleUpper,
              range.atmIv > 0
        else {
            throw OptionsAnalyticsContractError.invalid("invalid implied range")
        }
    }

    private func validateStrikes() throws {
        guard zip(strikes, strikes.dropFirst()).allSatisfy({ $0.strike < $1.strike }) else {
            throw OptionsAnalyticsContractError.invalid("strikes must be unique and sorted")
        }
        for strike in strikes {
            guard strike.strike.isFinite,
                  strike.strike > 0,
                  strike.grossGammaExposure.map({ $0.isFinite && $0 >= 0 }) ?? true,
                  strike.totalOpenInterest >= 0
            else {
                throw OptionsAnalyticsContractError.invalid("invalid strike")
            }
            if let call = strike.call { try validateLeg(call) }
            if let put = strike.put { try validateLeg(put) }
        }
    }

    private func validateLeg(_ leg: OptionsAnalyticsLegDTO) throws {
        let modelValues = [
            leg.impliedVolatility,
            leg.delta,
            leg.gamma,
            leg.gammaExposure,
            leg.deltaNotional,
        ]
        let modelIsComplete = modelValues.allSatisfy { $0 != nil }
        let modelIsUnavailable = modelValues.allSatisfy { $0 == nil }
        let finiteOptional = [leg.markedOiValue, leg.relativeSpread, leg.roundTripCost]
            .compactMap { $0 }
        guard leg.openInterest >= 0,
              leg.volume >= 0,
              leg.bidSize >= 0,
              leg.askSize >= 0,
              leg.multiplier.isFinite,
              modelValues.compactMap({ $0 }).allSatisfy(\.isFinite),
              modelIsComplete || modelIsUnavailable,
              finiteOptional.allSatisfy(\.isFinite),
              leg.impliedVolatility.map({ $0 > 0 }) ?? true,
              leg.delta.map({ -1...1 ~= $0 }) ?? true,
              leg.gamma.map({ $0 >= 0 }) ?? true,
              leg.gammaExposure.map({ $0 >= 0 }) ?? true,
              leg.multiplier > 0,
              leg.markedOiValue.map({ $0 >= 0 }) ?? true,
              leg.relativeSpread.map({ $0 >= 0 }) ?? true,
              leg.roundTripCost.map({ $0 >= 0 }) ?? true
        else {
            throw OptionsAnalyticsContractError.invalid("invalid strike leg")
        }
    }

    private func isValidOptionalDateTime(_ value: String?) -> Bool {
        value.map { DateParsing.dateTime($0) != nil } ?? true
    }

    private func isValidOptionalDay(_ value: String?) -> Bool {
        value.map { DateParsing.day($0) != nil } ?? true
    }
}

enum OptionsAnalyticsContractError: Error, Equatable {
    case invalid(String)
}
