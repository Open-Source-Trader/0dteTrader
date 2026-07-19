/**
 * Fixed colors for the TWC Heatmap V5 port — the Pine script's default
 * palette (TradingView built-ins are Material colors). No user color settings
 * in phase 1; keep in sync with TwcColors.swift.
 */

export const TWC_COLORS = {
  // Heatmap regime colors (Pine color.green / color.red / color.yellow@30)
  bull: '#4CAF50',
  bear: '#FF5252',
  chop: '#FFEB3B',

  // SuperTrend stack (Pine color.rgb(0,214,143) / color.rgb(255,82,82))
  stBull: 'rgb(0, 214, 143)',
  stBear: 'rgb(255, 82, 82)',

  // MACD alignment triangles (Pine color.blue / color.purple)
  macdBull: '#2196F3',
  macdBear: '#9C27B0',

  // SD fib palette
  amberBand: 'rgba(250, 179, 2, 0.25)', // amber50 fill (75 transparency)
  white50: 'rgba(255, 255, 255, 0.5)',
  gold50: 'rgba(239, 191, 4, 0.5)', // #EFBF04 @ 50
  red50: 'rgba(255, 82, 82, 0.5)',
  fibLabel: 'rgba(255, 255, 255, 0.75)',
  ptPill: 'rgba(33, 150, 243, 0.5)',
  ptText: '#FFFFFF',

  // Gann (Pine color.gray = #787B86)
  gannFan: '#FFFFFF',
  gannBox: 'rgba(120, 123, 134, 0.4)',

  // Bollinger
  bbBasis: 'rgba(255, 152, 0, 0.6)',
  bbSigma2: 'rgba(33, 150, 243, 0.45)',
  bbSigma2Fill: 'rgba(33, 150, 243, 0.06)',
  bbSigma3: 'rgba(156, 39, 176, 0.45)',
  bbSigma3Fill: 'rgba(156, 39, 176, 0.04)',

  // SMC order blocks (Pine defaults @ 80 transparency)
  internalBullishOB: 'rgba(49, 121, 245, 0.2)', // #3179f5
  internalBearishOB: 'rgba(247, 124, 128, 0.2)', // #f77c80
  swingBullishOB: 'rgba(24, 72, 204, 0.2)', // #1848cc
  swingBearishOB: 'rgba(178, 40, 51, 0.2)', // #b22833
  swingBullishOBBorder: 'rgba(24, 72, 204, 0.6)',
  swingBearishOBBorder: 'rgba(178, 40, 51, 0.6)',

  // Premium/discount zones (Pine RED/GRAY/GREEN @ 80 transparency fills)
  premiumZone: 'rgba(242, 54, 69, 0.2)', // #F23645
  equilibriumZone: 'rgba(135, 139, 148, 0.2)', // #878b94
  discountZone: 'rgba(8, 153, 129, 0.2)', // #089981
  premiumText: '#F23645',
  equilibriumText: '#878b94',
  discountText: '#089981',

  // VWAP rip markers (amber — the Pine alert had no visual; app-only)
  vwapRip: '#FAB302',

  // Banner text colors (Pine draws the banner with a fully transparent
  // background — colored text only)
  bannerLong: '#4CAF50',
  bannerShort: '#FF5252',
  bannerChop: '#FFEB3B',
} as const;

/** rgba() for a hex color at the given opacity (0..1). */
export function withOpacity(hex: string, opacity: number): string {
  const raw = hex.replace('#', '');
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}
