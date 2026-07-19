/** GEX/DEX overlay settings, persisted under settings.gexSettings. */
export interface GexSettings {
  enabled: boolean;
  /** Gamma flip / call wall / put wall / magnet lines + regime zone. */
  showLevels: boolean;
  /** Premium heat map bands. */
  showPremium: boolean;
  /** Poll interval for fresh Greeks (OI stays cached server-side). */
  refreshSeconds: number;
  /** How many premium strikes to render as bands. */
  maxPremiumStrikes: number;
  /** Alpha ceiling for the heaviest premium band (0.2–0.8). */
  opacityCap: number;
}

export const DEFAULT_GEX_SETTINGS: GexSettings = {
  enabled: false,
  showLevels: true,
  showPremium: true,
  refreshSeconds: 45,
  maxPremiumStrikes: 8,
  opacityCap: 0.55,
};
