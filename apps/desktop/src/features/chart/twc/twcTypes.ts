/**
 * Backwards-compatible TWC names for the shared stateful-script render model.
 * TWC math remains isolated in this folder while rendering is shared with
 * other complex chart scripts.
 */

export type {
  ScriptAreaFill as TwcAreaFill,
  ScriptBand as TwcBand,
  ScriptBanner as TwcBanner,
  ScriptLabel as TwcLabel,
  ScriptLine as TwcLine,
  ScriptMarker as TwcMarker,
  ScriptMarkerShape as TwcMarkerShape,
  ScriptRenderModel as TwcRenderModel,
  ScriptSegment as TwcSegment,
  ScriptSegmentStyle as TwcSegmentStyle,
} from '../scriptOverlayTypes';
