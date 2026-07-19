/**
 * Renderer-agnostic output of the TWC compute pipeline. Everything is in
 * (barIndex, price) space; barIndex may exceed the last candle (forward
 * projection — the overlay maps it via the chart's logical coordinates).
 * Mirrored 1:1 by TwcRenderModel in Swift.
 */

export type TwcMarkerShape = 'diamond' | 'triangleUp' | 'triangleDown' | 'labelUp' | 'labelDown';

export interface TwcMarker {
  barIndex: number;
  placement: 'aboveBar' | 'belowBar';
  shape: TwcMarkerShape;
  color: string;
  size: 'tiny' | 'small';
  text?: string;
}

export interface TwcLine {
  id: string;
  values: (number | null)[]; // aligned to candles; null = line break
  color: string;
  lineWidth: number;
}

export interface TwcAreaFill {
  id: string;
  top: (number | null)[];
  bottom: (number | null)[];
  /** Per-bar fill color (CTF highlight flips with direction); single-color fills repeat. */
  colors: (string | null)[];
}

export type TwcSegmentStyle = 'solid' | 'dashed' | 'dotted';

export interface TwcSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  style: TwcSegmentStyle;
}

export interface TwcBand {
  x1: number;
  x2: number;
  yTop: number;
  yBottom: number;
  fillColor: string;
  /** Optional stroked outline (swing order blocks). */
  borderColor?: string;
}

export interface TwcLabel {
  barIndex: number;
  price: number;
  text: string;
  textColor: string;
  /** Pill background; undefined = bare text. */
  bgColor?: string;
  align: 'left' | 'center' | 'right';
}

export interface TwcBanner {
  text: string;
  color: string;
  position: string; // TwcBannerPosition
  size: string; // TwcBannerSize
}

export interface TwcRenderModel {
  candleColors: (string | null)[] | null;
  markers: TwcMarker[];
  lines: TwcLine[];
  fills: TwcAreaFill[];
  segments: TwcSegment[];
  bands: TwcBand[];
  labels: TwcLabel[];
  banner: TwcBanner | null;
}
