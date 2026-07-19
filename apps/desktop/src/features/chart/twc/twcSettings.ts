/**
 * Settings for the "TWC Heatmap V5" script indicator (Pine port).
 * Flat struct (like IndicatorSettings) so the SettingsStore defaults-merge
 * stays forward compatible; the settings screen groups fields into sections
 * matching the Pine input groups. Defaults mirror TWC_Heat_Map_Indicator.pine.
 */

export type TwcSource = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4';
export type TwcFibMethod = 'Simple Pivots' | 'Volume Filtered';
export type TwcLabelPosition = 'Left' | 'Right';
export type TwcPivotSource = 'Wick' | 'Body';
export type TwcFlipTrigger = 'Wick' | 'Close';
export type TwcFlipLevel = '0.000' | '±0.618' | '±1.618';
export type TwcGannScaleMethod = 'Swing-Relative (Original)' | 'Auto (ATR-based)' | 'Manual';
export type TwcRejectionEnvelope = '2 Std' | '3 Std';
export type TwcBannerPosition =
  | 'Top Left'
  | 'Top Center'
  | 'Top Right'
  | 'Middle Left'
  | 'Middle Center'
  | 'Middle Right'
  | 'Bottom Left'
  | 'Bottom Center'
  | 'Bottom Right';
export type TwcBannerSize = 'Tiny' | 'Small' | 'Normal' | 'Large';
export type TwcOrderBlockFilter = 'Atr' | 'Cumulative Mean Range';
export type TwcOrderBlockMitigation = 'Close' | 'High/Low';

/** Pine timeframe strings supported by the MTF vote resampler. */
export const TWC_MTF_TIMEFRAMES = ['1', '5', '15', '30', '60', '240', 'D', 'W'] as const;

export interface TwcHeatmapSettings {
  /** Master toggle shown in the indicator list. */
  enabled: boolean;

  // Core Models
  source: TwcSource;
  lenLR: number;
  hwAlpha: number;
  hwBeta: number;
  lenCoG: number;

  // Hidden Markov Model
  hmmLook: number;
  hmmStay: number;

  // VWAP Z-Score
  vwapLook: number;
  vwapWarn: number;
  showVwapRip: boolean;

  // MSI / Signal Logic
  msiBullThr: number;
  msiBearThr: number;

  // Visuals
  colorBars: boolean;
  showMarkers: boolean;
  hideUnalignedCandles: boolean;

  // SD: Fibonacci Levels
  showFibonacci: boolean;
  fibPeriod: number;
  fibMethod: TwcFibMethod;
  fibLabelPosition: TwcLabelPosition;
  showFibRatioLabels: boolean;
  showFibPriceLabels: boolean;
  fibPivotSource: TwcPivotSource;
  useStandardRatios: boolean;

  // SD: Fib Flip / Reject
  flipEnable: boolean;
  flipTrigger: TwcFlipTrigger;
  flipLevel: TwcFlipLevel;

  // SD: Profit Target Zones
  shadeBands: boolean;
  showPTLabels: boolean;
  ptExtensionsOnly: boolean;
  ptPrefix: string;
  ptAlwaysShowFirst: boolean;

  // SD: Gann
  showGannFan: boolean;
  showGannBox: boolean;
  gannScaleMethod: TwcGannScaleMethod;
  gannManualScale: number;
  gannATRMultiplier: number;
  gann1x1: boolean;
  gann2x1: boolean;
  gann1x2: boolean;
  gann3x1: boolean;
  gann1x3: boolean;
  gann4x1: boolean;
  gann1x4: boolean;
  gann8x1: boolean;
  gann1x8: boolean;

  // CTF Core
  ctfAtrLength: number;
  ctfMultiplier: number;
  showCTFLine: boolean;
  showBuySellSignals: boolean;

  // Highlight
  showTransparentHighlight: boolean;
  highlightTransparency: number;

  // HTF Stack (6x chart timeframe)
  showHTF3: boolean;
  showHTF4: boolean;
  useCustomHTFAtrLength: boolean;
  htfAtrLength: number;

  // Bollinger Bands (length fixed at 20, like the Pine script)
  showBB2: boolean;
  showBB3: boolean;
  showEnvelopeRejection: boolean;
  rejectionEnvelope: TwcRejectionEnvelope;

  // SuperTrend Gate / MACD Alignment
  showMacdAlign: boolean;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;

  // Order Blocks (SMC)
  showSwingOrderBlocks: boolean;
  swingOrderBlocksSize: number;
  showInternalOrderBlocks: boolean;
  internalOrderBlocksSize: number;
  orderBlockFilter: TwcOrderBlockFilter;
  orderBlockMitigation: TwcOrderBlockMitigation;
  swingsLength: number;

  // Premium & Discount Zones (SMC)
  showPremiumDiscountZones: boolean;

  // Unified Confluence Engine
  useConfluenceGate: boolean;
  confBullThr: number;
  confBearThr: number;
  showConfMarkers: boolean;
  mtfTf1: string;
  mtfTf2: string;
  mtfTf3: string;
  mtfTf4: string;
  mtfTf5: string;
  mtfTf6: string;

  // Bias Banner
  showBiasBanner: boolean;
  biasBannerPosition: TwcBannerPosition;
  biasBannerSize: TwcBannerSize;
  biasLongText: string;
  biasShortText: string;
  biasChopText: string;
}

export const DEFAULT_TWC_SETTINGS: TwcHeatmapSettings = {
  enabled: false,

  source: 'close',
  lenLR: 20,
  hwAlpha: 0.2,
  hwBeta: 0.1,
  lenCoG: 10,

  hmmLook: 50,
  hmmStay: 0.88,

  vwapLook: 34,
  vwapWarn: 1.5,
  showVwapRip: true,

  msiBullThr: 75,
  msiBearThr: 25,

  colorBars: false,
  showMarkers: true,
  hideUnalignedCandles: false,

  showFibonacci: true,
  fibPeriod: 10,
  fibMethod: 'Simple Pivots',
  fibLabelPosition: 'Right',
  showFibRatioLabels: false,
  showFibPriceLabels: false,
  fibPivotSource: 'Body',
  useStandardRatios: true,

  flipEnable: true,
  flipTrigger: 'Close',
  flipLevel: '0.000',

  shadeBands: true,
  showPTLabels: true,
  ptExtensionsOnly: true,
  ptPrefix: 'Profit Target #',
  ptAlwaysShowFirst: true,

  showGannFan: false,
  showGannBox: false,
  gannScaleMethod: 'Swing-Relative (Original)',
  gannManualScale: 1.0,
  gannATRMultiplier: 0.1,
  gann1x1: false,
  gann2x1: false,
  gann1x2: false,
  gann3x1: false,
  gann1x3: false,
  gann4x1: false,
  gann1x4: false,
  gann8x1: false,
  gann1x8: false,

  ctfAtrLength: 14,
  ctfMultiplier: 3.5,
  showCTFLine: true,
  showBuySellSignals: false,

  showTransparentHighlight: true,
  highlightTransparency: 92,

  showHTF3: true,
  showHTF4: false,
  useCustomHTFAtrLength: true,
  htfAtrLength: 7,

  showBB2: false,
  showBB3: false,
  showEnvelopeRejection: false,
  rejectionEnvelope: '2 Std',

  showMacdAlign: true,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  showSwingOrderBlocks: true,
  swingOrderBlocksSize: 4,
  showInternalOrderBlocks: false,
  internalOrderBlocksSize: 3,
  orderBlockFilter: 'Atr',
  orderBlockMitigation: 'High/Low',
  swingsLength: 34,

  showPremiumDiscountZones: true,

  useConfluenceGate: false,
  confBullThr: 65,
  confBearThr: 35,
  showConfMarkers: false,
  mtfTf1: '5',
  mtfTf2: '15',
  mtfTf3: '60',
  mtfTf4: '240',
  mtfTf5: 'D',
  mtfTf6: 'W',

  showBiasBanner: true,
  biasBannerPosition: 'Bottom Center',
  biasBannerSize: 'Tiny',
  biasLongText: 'Long Bias — Look for a Bullish Trade 🍀',
  biasShortText: 'Shorts Bias — Look for a Bearish Trade 🩸',
  biasChopText: 'Chop Bias ⚠️ — Avoid Trading or Size down',
};
