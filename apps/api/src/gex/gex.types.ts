/**
 * GEX/DEX level overlay — shared DTOs between the API controller and the
 * desktop client (kept out of packages/shared-types: this feature is
 * desktop-only for now; promote if iOS needs it).
 */

/** One option contract from the Tradier chain, normalized. */
export interface ChainOption {
  /** OCC symbol, e.g. SPY260719C00585000. */
  symbol: string;
  strike: number;
  optionType: 'call' | 'put';
  openInterest: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  /** Implied vol as a decimal (0.21 = 21%). */
  midIv: number | null;
  delta: number | null;
  gamma: number | null;
}

/** Aggregated dealer exposure at one strike. */
export interface StrikeExposure {
  strike: number;
  callOi: number;
  putOi: number;
  /** Dollar gamma: (call_gamma*call_OI - put_gamma*put_OI) * 100 * spot^2. */
  gex: number;
  /** Dollar delta: (-call_delta*call_OI - put_delta*put_OI) * 100 * spot. */
  dex: number;
  callPremium: number;
  putPremium: number;
  /** (call_OI*call_mid + put_OI*put_mid) * 100. */
  totalPremium: number;
}

export interface PremiumLevel {
  strike: number;
  totalPremium: number;
  callPremium: number;
  putPremium: number;
  callOi: number;
  putOi: number;
}

/** GET /v1/market/gex response. */
export interface GexLevels {
  symbol: string;
  expiration: string;
  isZeroDte: boolean;
  spot: number;
  /** ISO timestamp of the computation. */
  asOf: string;
  /** True when served from the last-good cache after a Tradier failure. */
  stale: boolean;
  netGex: number;
  netDex: number;
  /** Spot where net GEX crosses zero; null when no crossing in range. */
  gammaFlip: number | null;
  /** Strike with the largest positive GEX contribution. */
  callWall: number | null;
  /** Strike with the largest negative GEX contribution. */
  putWall: number | null;
  /** Highest total-OI strike (0DTE pin target); null when not 0DTE. */
  magnet: number | null;
  /** Full per-strike profile, ascending by strike. */
  strikes: StrikeExposure[];
  /** Top strikes by total premium, descending. */
  topPremium: PremiumLevel[];
}
