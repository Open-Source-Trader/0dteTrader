/** User-configurable indicator presets (IndicatorSettings.swift). */
export interface IndicatorSettings {
  smaEnabled: boolean;
  smaPeriod: number;
  emaEnabled: boolean;
  emaPeriod: number;
  vwapEnabled: boolean;
  rsiEnabled: boolean;
  rsiPeriod: number;
  macdEnabled: boolean;
  macdFastPeriod: number;
  macdSlowPeriod: number;
  macdSignalPeriod: number;
  bollingerEnabled: boolean;
  bollingerPeriod: number;
  bollingerMultiplier: number;
  volumeEnabled: boolean;
  stochEnabled: boolean;
  stochKPeriod: number;
  stochKSmooth: number;
  stochDPeriod: number;
  atrEnabled: boolean;
  atrPeriod: number;
}

export const DEFAULT_INDICATOR_SETTINGS: IndicatorSettings = {
  smaEnabled: false,
  smaPeriod: 20,
  emaEnabled: true,
  emaPeriod: 9,
  vwapEnabled: true,
  rsiEnabled: false,
  rsiPeriod: 14,
  macdEnabled: false,
  macdFastPeriod: 12,
  macdSlowPeriod: 26,
  macdSignalPeriod: 9,
  bollingerEnabled: false,
  bollingerPeriod: 20,
  bollingerMultiplier: 2,
  volumeEnabled: true,
  stochEnabled: false,
  stochKPeriod: 14,
  stochKSmooth: 3,
  stochDPeriod: 3,
  atrEnabled: false,
  atrPeriod: 14,
};

/** Sub-pane indicators (rendered below the candle chart) in display order. */
export type SubPaneKey = 'rsiEnabled' | 'macdEnabled' | 'stochEnabled' | 'atrEnabled';
export const SUB_PANE_ORDER: SubPaneKey[] = [
  'rsiEnabled',
  'macdEnabled',
  'stochEnabled',
  'atrEnabled',
];

/** At most this many sub-panes show at once (chart real estate is bounded). */
export const MAX_SUB_PANES = 2;

/** Enabled sub-panes in display order, capped at MAX_SUB_PANES. */
export function enabledSubPanes(settings: IndicatorSettings): SubPaneKey[] {
  return SUB_PANE_ORDER.filter((key) => settings[key]).slice(0, MAX_SUB_PANES);
}

/** Turns off sub-panes beyond the cap (e.g. settings persisted before the
 *  cap existed); overlays are untouched. Identity when already within cap. */
export function capSubPanes(settings: IndicatorSettings): IndicatorSettings {
  const allowed = new Set(enabledSubPanes(settings));
  let changed = false;
  const next = { ...settings };
  for (const key of SUB_PANE_ORDER) {
    if (next[key] && !allowed.has(key)) {
      next[key] = false;
      changed = true;
    }
  }
  return changed ? next : settings;
}
