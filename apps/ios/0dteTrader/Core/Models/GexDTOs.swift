import Foundation

/// Response of GET /v1/market/gex (mirror of the API DTOs). The per-strike
/// profile is intentionally not decoded — the overlay only needs the level
/// structure and the premium heat map.
struct GexPremiumLevelDTO: Decodable, Sendable {
    let strike: Double
    let totalPremium: Double
    let callPremium: Double
    let putPremium: Double
    let callOi: Int
    let putOi: Int
}

struct GexLevelsDTO: Decodable, Sendable {
    let symbol: String
    let expiration: String
    let isZeroDte: Bool
    let spot: Double
    let asOf: String
    /// Served from the server's last-good cache after a Tradier failure.
    let stale: Bool
    let netGex: Double
    let netDex: Double
    let gammaFlip: Double?
    let callWall: Double?
    let putWall: Double?
    let magnet: Double?
    let topPremium: [GexPremiumLevelDTO]
}
