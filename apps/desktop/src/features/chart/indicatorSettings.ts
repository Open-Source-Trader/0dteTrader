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
