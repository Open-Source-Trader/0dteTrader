import {
  bsDelta,
  bsGamma,
  computeGexLevels,
  computeStrikeExposures,
  findGammaFlip,
  netGexAt,
  yearsToExpiration,
} from './gex.engine';
import type { ChainOption } from './gex.types';

function option(partial: Partial<ChainOption> & Pick<ChainOption, 'strike' | 'optionType'>): ChainOption {
  return {
    symbol: 'TEST',
    openInterest: 0,
    bid: null,
    ask: null,
    last: null,
    midIv: 0.2,
    delta: null,
    gamma: null,
    ...partial,
  };
}

const EXPIRY = '2026-07-24';
const NOW = new Date('2026-07-20T14:00:00Z');

describe('gex.engine', () => {
  describe('Black-Scholes fallback', () => {
    it('ATM call delta is near 0.5, put delta near -0.5', () => {
      const t = 5 / 365;
      expect(bsDelta('call', 100, 100, t, 0.2)).toBeGreaterThan(0.5);
      expect(bsDelta('call', 100, 100, t, 0.2)).toBeLessThan(0.6);
      expect(bsDelta('put', 100, 100, t, 0.2)).toBeLessThan(-0.4);
      expect(bsDelta('put', 100, 100, t, 0.2)).toBeGreaterThan(-0.5);
    });

    it('gamma is positive and peaks at the money', () => {
      const t = 5 / 365;
      const atm = bsGamma(100, 100, t, 0.2);
      expect(atm).toBeGreaterThan(0);
      expect(bsGamma(100, 120, t, 0.2)).toBeLessThan(atm);
      expect(bsGamma(100, 80, t, 0.2)).toBeLessThan(atm);
    });

    it('handles expiry edge without NaN', () => {
      expect(bsGamma(100, 100, 0, 0.2)).toBe(0);
      expect(bsDelta('call', 105, 100, 0, 0.2)).toBe(1);
      expect(bsDelta('put', 105, 100, 0, 0.2)).toBe(0);
    });
  });

  describe('yearsToExpiration', () => {
    it('is positive and small for near expirations', () => {
      const t = yearsToExpiration(EXPIRY, NOW);
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(6 / 365);
    });

    it('floors at ~2 minutes for past dates', () => {
      const t = yearsToExpiration('2020-01-01', NOW);
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(1 / 100000);
    });
  });

  describe('computeStrikeExposures', () => {
    it('calls add positive GEX, puts negative (dealer convention)', () => {
      const chain = [
        option({ strike: 100, optionType: 'call', openInterest: 1000, gamma: 0.05, delta: 0.5, bid: 2, ask: 2.2 }),
        option({ strike: 100, optionType: 'put', openInterest: 500, gamma: 0.05, delta: -0.5, bid: 1.8, ask: 2 }),
      ];
      const [row] = computeStrikeExposures(chain, 100, 0.01);
      // GEX = (0.05*1000 - 0.05*500) * 100 * 100^2
      expect(row.gex).toBeCloseTo(25_000_000);
      // DEX = (-0.5*1000 - (-0.5)*500) * 100 * 100 = -2_500_000
      expect(row.dex).toBeCloseTo(-2_500_000);
      // Premium = 1000*2.1*100 + 500*1.9*100
      expect(row.callPremium).toBeCloseTo(210_000);
      expect(row.putPremium).toBeCloseTo(95_000);
      expect(row.totalPremium).toBeCloseTo(305_000);
    });

    it('falls back to BS greeks when Tradier greeks are missing', () => {
      const chain = [option({ strike: 100, optionType: 'call', openInterest: 100, midIv: 0.25 })];
      const [row] = computeStrikeExposures(chain, 100, 0.02);
      expect(row.gex).toBeGreaterThan(0);
      expect(row.dex).toBeLessThan(0);
    });

    it('uses last price when bid/ask are missing', () => {
      const chain = [
        option({ strike: 100, optionType: 'call', openInterest: 100, gamma: 0.01, delta: 0.5, last: 3 }),
      ];
      const [row] = computeStrikeExposures(chain, 100, 0.01);
      expect(row.callPremium).toBeCloseTo(30_000);
    });
  });

  describe('computeGexLevels', () => {
    // Symmetric chain: heavy calls above spot, heavy puts below -> flip between.
    const chain: ChainOption[] = [
      option({ strike: 95, optionType: 'put', openInterest: 5000, midIv: 0.22, bid: 0.4, ask: 0.5 }),
      option({ strike: 100, optionType: 'put', openInterest: 2000, midIv: 0.2, bid: 1.2, ask: 1.4 }),
      option({ strike: 100, optionType: 'call', openInterest: 1000, midIv: 0.2, bid: 1.9, ask: 2.1 }),
      option({ strike: 105, optionType: 'call', openInterest: 6000, midIv: 0.22, bid: 0.3, ask: 0.4 }),
    ];

    const levels = computeGexLevels(chain, {
      symbol: 'TEST',
      expiration: EXPIRY,
      isZeroDte: false,
      spot: 100,
      now: NOW,
    });

    it('identifies call and put walls', () => {
      expect(levels.callWall).toBe(105);
      expect(levels.putWall).toBe(95);
    });

    it('hides the magnet when not 0DTE, shows it on 0DTE', () => {
      expect(levels.magnet).toBeNull();
      const zeroDte = computeGexLevels(chain, {
        symbol: 'TEST',
        expiration: '2026-07-20',
        isZeroDte: true,
        spot: 100,
        now: NOW,
      });
      expect(zeroDte.magnet).toBe(105); // highest total OI strike
    });

    it('returns top premium strikes sorted descending', () => {
      expect(levels.topPremium.length).toBeGreaterThan(0);
      for (let i = 1; i < levels.topPremium.length; i++) {
        expect(levels.topPremium[i - 1].totalPremium).toBeGreaterThanOrEqual(
          levels.topPremium[i].totalPremium,
        );
      }
    });

    it('netGexAt changes sign across the chain and the flip lands in range', () => {
      const t = yearsToExpiration(EXPIRY, NOW);
      const below = netGexAt(chain, 95, t);
      const above = netGexAt(chain, 105, t);
      expect(below).toBeLessThan(0);
      expect(above).toBeGreaterThan(0);
      const flip = findGammaFlip(chain, [95, 100, 105], t);
      expect(flip).not.toBeNull();
      expect(flip as number).toBeGreaterThan(95);
      expect(flip as number).toBeLessThan(105);
      expect(levels.gammaFlip).toBe(flip);
    });
  });
});
