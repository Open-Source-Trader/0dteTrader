/** Response shape of GET /v1/market/gex (mirror of the API DTOs). */

export interface GexPremiumLevel {
  strike: number;
  totalPremium: number;
  callPremium: number;
  putPremium: number;
  callOi: number;
  putOi: number;
}

export interface GexLevels {
  symbol: string;
  expiration: string;
  isZeroDte: boolean;
  spot: number;
  asOf: string;
  /** Served from the last-good cache after a Tradier failure. */
  stale: boolean;
  netGex: number;
  netDex: number;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  magnet: number | null;
  topPremium: GexPremiumLevel[];
}
