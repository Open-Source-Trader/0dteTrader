import type { ScriptRenderModel } from '../scriptOverlayTypes';

export interface UsrCandle {
  /** Epoch seconds, matching ChartCandle.time. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface UsrAnalysisCandle extends UsrCandle {
  chartStartIndex: number;
  chartEndIndex: number;
  /** Chart close where this fully closed analysis candle first becomes knowable. */
  eventChartIndex: number;
  /** Close time of the chart candle where this analysis event is committed. */
  eventTime: number;
  closeTime: number;
  regularSession: boolean;
  atr: number | null;
  volumeMean: number | null;
  volumeStd: number | null;
}

export type UsrZoneState = 'fresh' | 'tested' | 'mitigated';

export interface UsrZone {
  id: number;
  sourceId: number;
  analysisBirth: number;
  top: number;
  bottom: number;
  startBar: number;
  sourceTime: number;
  detectedTime: number;
  activeTime: number;
  invalidatedTime: number | null;
  activationBar: number;
  endBar: number;
  isSupport: boolean;
  isActive: boolean;
  volumeRatio: number;
  state: UsrZoneState;
  touchCount: number;
  maxPenetration: number;
  isFlipped: boolean;
  isLine: boolean;
  lastTouchAnalysisBar: number | null;
  wasInsideLastBar: boolean;
  originStartBar: number;
  originZoneId: number;
  originIsSupport: boolean;
  hasActiveFlippedChild: boolean;
  inPool: boolean;
  poolId: string;
  bounceSignalCount: number;
  sweepSignalCount: number;
  lastBounceSignalBar: number;
  lastSweepSignalBar: number;
}

export interface UsrConfluence {
  top: number;
  bottom: number;
  startBar: number;
  isMixed: boolean;
  memberIds: number[];
  strength: number;
}

export type UsrPoolState = 'anticipated' | 'validated' | 'swept';

export interface UsrPool {
  id: string;
  top: number;
  bottom: number;
  strength: number;
  startBar: number;
  isSupport: boolean;
  state: UsrPoolState;
  memberIds: number[];
  analysisBirth: number;
  bounceSignalCount: number;
  sweepSignalCount: number;
  lastBounceSignalAnalysisBar: number;
  lastSweepSignalAnalysisBar: number;
}

export type UsrFvgDirection = 'bullish' | 'bearish';
export type UsrFvgLifecycle =
  'untouched' | 'partial' | 'ce' | 'wick-filled' | 'inverted' | 'invalidated' | 'expired';

export interface UsrFvg {
  id: string;
  /** Mirrors whether Pine retained this record's sole FVG/IFVG box. */
  visualVisible: boolean;
  top: number;
  bottom: number;
  ce: number;
  startBar: number;
  analysisBirth: number;
  ifvgAnalysisBirth: number;
  endBar: number;
  ifvgEndBar: number;
  direction: UsrFvgDirection;
  isActive: boolean;
  lifecycle: UsrFvgLifecycle;
  milestoneReached: boolean;
  ifvgActive: boolean;
  bounceSignalCount: number;
  sweepSignalCount: number;
  lastBounceSignalAnalysisBar: number;
  lastSweepSignalAnalysisBar: number;
}

export type UsrSignalKind = 'bounce' | 'sweep';
export type UsrSignalSource = 'zone' | 'pool' | 'fvg' | 'ifvg';

export interface UsrSignal {
  bullish: boolean;
  kind: UsrSignalKind;
  source: UsrSignalSource;
  chartBarIndex: number;
  analysisBarId: number;
  price: number;
  stop: number;
  score: number;
  sourceKey: string;
}

export interface UsrDiagnostics {
  analysisTimeframeSeconds: number | null;
  analysisTimeframeTag: string;
  usedChartTimeframe: boolean;
  confirmedChartBars: number;
  analysisBars: number;
  warnings: string[];
}

export interface UsrComputation {
  renderModel: ScriptRenderModel;
  supportZones: UsrZone[];
  resistanceZones: UsrZone[];
  supportPools: UsrPool[];
  resistancePools: UsrPool[];
  bullishFvgs: UsrFvg[];
  bearishFvgs: UsrFvg[];
  supportConfluences: UsrConfluence[];
  resistanceConfluences: UsrConfluence[];
  mixedConfluences: UsrConfluence[];
  signals: UsrSignal[];
  diagnostics: UsrDiagnostics;
}

export interface UsrComputeContext {
  chartIntervalSeconds: number | null;
  /** True for 24/7 instruments whose exchange session has no RTH/ETH split. */
  continuousSession?: boolean;
  /** Epoch seconds. Used only to decide whether the newest chart/HTF bar is closed. */
  now: number;
  /** Override interval-based inference (tick candles in the app are already closed). */
  lastCandleIsOpen?: boolean;
}
