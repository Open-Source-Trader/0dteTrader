import Foundation

enum GexDataQualityDTO: String, Decodable, Equatable, Sendable {
    case complete
    case missingGamma
    case missingOpenInterest
    case missingSpot
    case stale
    case partial
}

struct GexHeatmapCellDTO: Decodable, Equatable, Sendable {
    let timestamp: String
    let strike: Double
    let callGex: Double?
    let putGex: Double?
    let netGex: Double?
    let dataQuality: GexDataQualityDTO
}

/// Strike x timestamp: one expiration over its capture history.
/// `GET /v1/market/options-analytics/gex-heatmap`.
struct GexHeatmapSnapshotDTO: Decodable, Equatable, Sendable {
    let underlyingSymbol: String
    let expiration: String
    let spotSeries: [Double]
    let timestamps: [String]
    let strikes: [Double]
    let cells: [GexHeatmapCellDTO]
}

struct GexTermStructureCellDTO: Decodable, Equatable, Sendable {
    let timestamp: String
    let strike: Double
    let callGex: Double?
    let putGex: Double?
    let netGex: Double?
    let dataQuality: GexDataQualityDTO
    let expiration: String
}

/// Strike x expiration: each expiration's own latest capture.
/// `GET /v1/market/options-analytics/gex-term-structure`.
struct GexTermStructureSnapshotDTO: Decodable, Equatable, Sendable {
    let underlyingSymbol: String
    let expirations: [String]
    let strikes: [Double]
    let cells: [GexTermStructureCellDTO]
}
