/**
 * Renderer-neutral geometry shared by stateful chart scripts.
 *
 * Coordinates are expressed as candle indices and prices. Keeping this model
 * independent from React, lightweight-charts, and any particular script lets
 * TWC and Ultimate Support & Resistance share one overlay renderer.
 */

export type ScriptMarkerShape = 'diamond' | 'triangleUp' | 'triangleDown' | 'labelUp' | 'labelDown';

export interface ScriptMarker {
  barIndex: number;
  placement: 'aboveBar' | 'belowBar';
  shape: ScriptMarkerShape;
  color: string;
  size: 'tiny' | 'small';
  text?: string;
  textColor?: string;
}

export interface ScriptLine {
  id: string;
  values: Array<number | null>;
  color: string;
  lineWidth: number;
}

export interface ScriptAreaFill {
  id: string;
  top: Array<number | null>;
  bottom: Array<number | null>;
  colors: Array<string | null>;
}

export type ScriptSegmentStyle = 'solid' | 'dashed' | 'dotted';

export interface ScriptSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  style: ScriptSegmentStyle;
}

export interface ScriptBand {
  x1: number;
  x2: number;
  yTop: number;
  yBottom: number;
  fillColor: string;
  borderColor?: string;
  borderWidth?: number;
  borderStyle?: ScriptSegmentStyle;
}

export interface ScriptLabel {
  barIndex: number;
  price: number;
  text: string;
  textColor: string;
  bgColor?: string;
  align: 'left' | 'center' | 'right';
}

export interface ScriptBanner {
  text: string;
  color: string;
  position: string;
  size: string;
}

export interface ScriptRenderModel {
  candleColors: Array<string | null> | null;
  markers: ScriptMarker[];
  lines: ScriptLine[];
  fills: ScriptAreaFill[];
  segments: ScriptSegment[];
  bands: ScriptBand[];
  labels: ScriptLabel[];
  banner: ScriptBanner | null;
}

interface ScriptColorComponents {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

function parseScriptColor(color: string): ScriptColorComponents | null {
  const trimmed = color.trim();
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(trimmed);
  if (hex) {
    return {
      red: Number.parseInt(hex[1], 16),
      green: Number.parseInt(hex[2], 16),
      blue: Number.parseInt(hex[3], 16),
      alpha: 1,
    };
  }
  const match = /^(rgb|rgba)\(([^)]*)\)$/i.exec(trimmed);
  if (!match) return null;
  const rawParts = match[2].split(',').map((part) => part.trim());
  const expected = match[1].toLowerCase() === 'rgba' ? 4 : 3;
  if (rawParts.length !== expected || rawParts.some((part) => part.length === 0)) return null;
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  if (rawParts.some((part) => !decimal.test(part))) return null;
  const parts = rawParts.map(Number);
  if (
    !parts.every(Number.isFinite) ||
    !parts.slice(0, 3).every((part) => part >= 0 && part <= 255) ||
    (expected === 4 && (parts[3] < 0 || parts[3] > 1))
  ) {
    return null;
  }
  return { red: parts[0], green: parts[1], blue: parts[2], alpha: parts[3] ?? 1 };
}

export function isValidScriptColor(color: string): boolean {
  return parseScriptColor(color) !== null;
}

export function withScriptColorOpacity(color: string, opacity: number): string {
  const components = parseScriptColor(color);
  if (!components) return color;
  const safeOpacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
  return `rgba(${components.red}, ${components.green}, ${components.blue}, ${safeOpacity})`;
}

export function mergeScriptRenderModels(
  models: ReadonlyArray<ScriptRenderModel | null>,
): ScriptRenderModel | null {
  const active = models.filter((model): model is ScriptRenderModel => model !== null);
  if (active.length === 0) return null;
  return {
    candleColors: active.find(({ candleColors }) => candleColors !== null)?.candleColors ?? null,
    markers: active.flatMap(({ markers }) => markers),
    lines: active.flatMap(({ lines }) => lines),
    fills: active.flatMap(({ fills }) => fills),
    segments: active.flatMap(({ segments }) => segments),
    bands: active.flatMap(({ bands }) => bands),
    labels: active.flatMap(({ labels }) => labels),
    banner: active.find(({ banner }) => banner !== null)?.banner ?? null,
  };
}
