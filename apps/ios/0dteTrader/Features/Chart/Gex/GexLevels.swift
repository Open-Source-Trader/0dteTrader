import Foundation

/// Domain model for the GEX/DEX overlay (gexTypes.ts analog).
struct GexPremiumLevel: Equatable, Sendable {
    let strike: Double
    let totalPremium: Double
    let callPremium: Double
    let putPremium: Double
    let callOi: Int
    let putOi: Int

    init(dto: GexPremiumLevelDTO) {
        strike = dto.strike
        totalPremium = dto.totalPremium
        callPremium = dto.callPremium
        putPremium = dto.putPremium
        callOi = dto.callOi
        putOi = dto.putOi
    }
}

struct GexLevels: Equatable, Sendable {
    let symbol: String
    let expiration: String
    let isZeroDte: Bool
    let spot: Double
    /// True when served from the server's last-good cache after a Tradier failure.
    let stale: Bool
    let netGex: Double
    let netDex: Double
    let gammaFlip: Double?
    let callWall: Double?
    let putWall: Double?
    let magnet: Double?
    let topPremium: [GexPremiumLevel]

    init(dto: GexLevelsDTO) {
        symbol = dto.symbol
        expiration = dto.expiration
        isZeroDte = dto.isZeroDte
        spot = dto.spot
        stale = dto.stale
        netGex = dto.netGex
        netDex = dto.netDex
        gammaFlip = dto.gammaFlip
        callWall = dto.callWall
        putWall = dto.putWall
        magnet = dto.magnet
        topPremium = dto.topPremium.map(GexPremiumLevel.init(dto:))
    }
}
