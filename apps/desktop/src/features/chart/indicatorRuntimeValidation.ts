import type { IndicatorSettingsState } from '@0dtetrader/shared-types';
import type { TimedCandleInput } from './indicatorEngine';
import { computeIndicatorGeometry } from './indicatorEngine';
import { INDICATOR_REGISTRY } from './indicatorRegistry';

export type IndicatorGeometryValidationResult = { ok: true } | { ok: false; error: string };

export function validateEnabledIndicatorGeometries(
  settings: IndicatorSettingsState,
  candles: TimedCandleInput[],
): IndicatorGeometryValidationResult {
  try {
    for (const descriptor of INDICATOR_REGISTRY.indicators) {
      const setting = settings.indicators[descriptor.id];
      if (!setting.enabled || descriptor.requiresL2) continue;
      computeIndicatorGeometry(descriptor, candles, setting.parameters);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Indicator geometry is invalid.',
    };
  }
}
