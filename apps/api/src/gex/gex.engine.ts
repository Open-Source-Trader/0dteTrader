import type { ChainOption, GexLevels, PremiumLevel, StrikeExposure } from './gex.types';

/**
 * Pure GEX/DEX computation engine. No I/O — feed it a normalized chain and
 * a spot price, get the full level structure back.
 *
 * Dealer positioning convention (SpotGamma-style, per spec):
 *   calls = dealer short  -> dealer gamma +, dealer delta -
 *   puts  = dealer long   -> dealer gamma -, dealer delta +
 *   net GEX = (call_gamma*call_OI - put_gamma*put_OI) * 100 * spot^2
 *   net DEX = (-call_delta*call_OI - put_delta*put_OI) * 100 * spot
 */

const RISK_FREE_RATE = 0.05; // ~1M T-bill; good enough for 0DTE-scalping levels
const SQRT_2PI = Math.sqrt(2 * Math.PI);

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

function normCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26 — |err| < 1.5e-7.
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - normPdf(x) * poly;
  return sign > 0 ? cdf : 1 - cdf;
}

function d1(spot: number, strike: number, t: number, sigma: number, r: number): number {
  return (Math.log(spot / strike) + (r + 0.5 * sigma * sigma) * t) / (sigma * Math.sqrt(t));
}

/** Black-Scholes gamma (same for calls and puts). */
export function bsGamma(spot: number, strike: number, t: number, sigma: number, r = RISK_FREE_RATE): number {
  if (t <= 0 || sigma <= 0 || spot <= 0 || strike <= 0) return 0;
  return normPdf(d1(spot, strike, t, sigma, r)) / (spot * sigma * Math.sqrt(t));
}

/** Black-Scholes delta, signed by option type. */
export function bsDelta(
  optionType: 'call' | 'put',
  spot: number,
  strike: number,
  t: number,
  sigma: number,
  r = RISK_FREE_RATE,
): number {
  if (t <= 0 || sigma <= 0 || spot <= 0 || strike <= 0) {
    // At expiry: ITM calls +1, ITM puts -1, OTM 0.
    if (optionType === 'call') return spot > strike ? 1 : 0;
    return spot < strike ? -1 : 0;
  }
  const callDelta = normCdf(d1(spot, strike, t, sigma, r));
  return optionType === 'call' ? callDelta : callDelta - 1;
}

function midPrice(option: ChainOption): number | null {
  const { bid, ask, last } = option;
  if (bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid) {
    return (bid + ask) / 2;
  }
  if (last !== null && last > 0) return last;
  return null;
}

/** Years to expiration from an ISO date (ACT/365, floor at ~2 minutes). */
export function yearsToExpiration(expiration: string, now = new Date()): number {
  // Expirations settle at 16:00 ET ≈ 20:00/21:00 UTC; 21:00 covers EDT.
  const expiryMs = Date.parse(`${expiration}T21:00:00Z`);
  if (!Number.isFinite(expiryMs)) {
    // Untrusted external input (the expiration comes from the data
    // provider): fail loudly instead of propagating NaN through every level.
    throw new Error(`Malformed expiration date: ${expiration}`);
  }
  const ms = Math.max(expiryMs - now.getTime(), 120_000);
  return ms / (365 * 24 * 3600 * 1000);
}

/**
 * Net dealer GEX across the whole chain evaluated at an arbitrary spot,
 * recomputing per-strike gamma with that strike's IV (gamma moves with
 * spot — holding it fixed misplaces the flip on wide ranges).
 */
export function netGexAt(
  options: ChainOption[],
  candidateSpot: number,
  t: number,
): number {
  let sum = 0;
  for (const option of options) {
    if (option.openInterest <= 0) continue;
    const iv = option.midIv ?? 0.2;
    const gamma = bsGamma(candidateSpot, option.strike, t, iv);
    const signed = option.optionType === 'call' ? gamma : -gamma;
    sum += signed * option.openInterest * 100 * candidateSpot * candidateSpot;
  }
  return sum;
}

/** Zero crossing of net GEX, interpolated between adjacent strikes. */
export function findGammaFlip(
  options: ChainOption[],
  strikes: number[],
  t: number,
): number | null {
  let prevSpot: number | null = null;
  let prevGex = 0;
  for (const strike of strikes) {
    const gex = netGexAt(options, strike, t);
    if (prevSpot !== null && ((prevGex < 0 && gex > 0) || (prevGex > 0 && gex < 0))) {
      // Linear interpolation between the bracketing strikes.
      return prevSpot + ((strike - prevSpot) * -prevGex) / (gex - prevGex);
    }
    prevSpot = strike;
    prevGex = gex;
  }
  return null;
}

/** Per-strike GEX/DEX/premium profile at the current spot. */
export function computeStrikeExposures(
  options: ChainOption[],
  spot: number,
  t: number,
): StrikeExposure[] {
  const byStrike = new Map<number, StrikeExposure>();
  for (const option of options) {
    let row = byStrike.get(option.strike);
    if (!row) {
      row = {
        strike: option.strike,
        callOi: 0,
        putOi: 0,
        gex: 0,
        dex: 0,
        callPremium: 0,
        putPremium: 0,
        totalPremium: 0,
      };
      byStrike.set(option.strike, row);
    }

    const iv = option.midIv ?? 0.2;
    const gamma =
      option.gamma ?? (option.openInterest > 0 ? bsGamma(spot, option.strike, t, iv) : 0);
    const delta =
      option.delta ??
      (option.openInterest > 0 ? bsDelta(option.optionType, spot, option.strike, t, iv) : 0);
    const mid = midPrice(option) ?? 0;
    const premium = option.openInterest * mid * 100;

    if (option.optionType === 'call') {
      row.callOi += option.openInterest;
      row.gex += gamma * option.openInterest * 100 * spot * spot;
      row.dex += -delta * option.openInterest * 100 * spot;
      row.callPremium += premium;
    } else {
      row.putOi += option.openInterest;
      row.gex += -gamma * option.openInterest * 100 * spot * spot;
      row.dex += -delta * option.openInterest * 100 * spot; // put delta is negative
      row.putPremium += premium;
    }
    row.totalPremium += premium;
  }
  return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
}

export interface ComputeGexOptions {
  symbol: string;
  expiration: string;
  isZeroDte: boolean;
  spot: number;
  /** Max strikes in the premium heat map. */
  topPremiumCount?: number;
  now?: Date;
}

/** Full level structure for the overlay. */
export function computeGexLevels(
  options: ChainOption[],
  opts: ComputeGexOptions,
): Omit<GexLevels, 'asOf' | 'stale'> {
  const t = yearsToExpiration(opts.expiration, opts.now);
  const exposures = computeStrikeExposures(options, opts.spot, t);
  const active = exposures.filter((row) => row.callOi + row.putOi > 0);

  const netGex = exposures.reduce((sum, row) => sum + row.gex, 0);
  const netDex = exposures.reduce((sum, row) => sum + row.dex, 0);

  let callWall: number | null = null;
  let callWallGex = 0;
  let putWall: number | null = null;
  let putWallGex = 0;
  let magnet: number | null = null;
  let magnetOi = 0;
  for (const row of active) {
    if (row.gex > callWallGex) {
      callWallGex = row.gex;
      callWall = row.strike;
    }
    if (row.gex < putWallGex) {
      putWallGex = row.gex;
      putWall = row.strike;
    }
    const oi = row.callOi + row.putOi;
    if (oi > magnetOi) {
      magnetOi = oi;
      magnet = row.strike;
    }
  }

  const gammaFlip = findGammaFlip(
    options,
    active.map((row) => row.strike),
    t,
  );

  const topPremium: PremiumLevel[] = active
    .filter((row) => row.totalPremium > 0)
    .sort((a, b) => b.totalPremium - a.totalPremium)
    .slice(0, opts.topPremiumCount ?? 10)
    .map((row) => ({
      strike: row.strike,
      totalPremium: row.totalPremium,
      callPremium: row.callPremium,
      putPremium: row.putPremium,
      callOi: row.callOi,
      putOi: row.putOi,
    }));

  return {
    symbol: opts.symbol,
    expiration: opts.expiration,
    isZeroDte: opts.isZeroDte,
    spot: opts.spot,
    netGex,
    netDex,
    gammaFlip,
    callWall,
    putWall,
    magnet,
    strikes: exposures,
    topPremium,
  };
}
