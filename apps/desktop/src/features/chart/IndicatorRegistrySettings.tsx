import { useState } from 'react';
import type {
  ChartDisplayPreferences,
  IndicatorDescriptor,
  IndicatorSettingsState,
} from '@0dtetrader/shared-types';
import { Toggle } from '../../design/components/Toggle';
import {
  INDICATOR_REGISTRY,
  applyIndicatorSetting,
  enabledSubPaneIds,
  indicatorAvailability,
} from './indicatorRegistry';

interface IndicatorRegistrySettingsProps {
  settings: IndicatorSettingsState;
  chartDisplay: ChartDisplayPreferences;
  onChange: (settings: IndicatorSettingsState) => void;
  onChangeChartDisplay: (preferences: ChartDisplayPreferences) => void;
}

export function IndicatorRegistrySettings({
  settings,
  chartDisplay,
  onChange,
  onChangeChartDisplay,
}: IndicatorRegistrySettingsProps) {
  const [error, setError] = useState<string | null>(null);
  const panesAtLimit = enabledSubPaneIds(settings).length >= INDICATOR_REGISTRY.maxSubPanes;

  const update = (
    descriptor: IndicatorDescriptor,
    patch: { enabled?: boolean; parameters?: Record<string, number> },
  ) => {
    const result = applyIndicatorSetting(settings, descriptor.id, patch);
    if (!result.ok) {
      setError(result.error ?? 'Indicator settings are invalid.');
      return;
    }
    setError(null);
    onChange(result.value);
  };

  const renderDescriptor = (descriptor: IndicatorDescriptor) => {
    const setting = settings.indicators[descriptor.id];
    const availability = indicatorAvailability(descriptor.id);
    const atPaneLimit = descriptor.pane === 'subpane' && !setting.enabled && panesAtLimit;
    return (
      <fieldset className="settings-fieldset" key={descriptor.id} data-indicator-id={descriptor.id}>
        <legend className="settings-fieldset-legend">{descriptor.displayName}</legend>
        <div className="settings-field settings-field--row">
          <span className="settings-field-label">Enabled</span>
          <Toggle
            on={setting.enabled}
            disabled={!availability.available || atPaneLimit}
            ariaLabel={`${descriptor.displayName} enabled`}
            onChange={(enabled) => update(descriptor, { enabled })}
          />
        </div>
        {!availability.available ? (
          <div className="text-secondary" role="status">
            {availability.reason}
          </div>
        ) : null}
        {Object.values(descriptor.parameters).map((parameter) => (
          <label className="settings-field" key={parameter.id}>
            <span className="settings-field-label">{parameter.label}</span>
            <input
              className="number-field-input"
              type="number"
              inputMode="decimal"
              min={parameter.minimum}
              max={parameter.maximum}
              step={parameter.kind === 'number' ? 'any' : 1}
              disabled={!availability.available || !setting.enabled}
              value={setting.parameters[parameter.id]}
              onChange={(event) =>
                update(descriptor, {
                  parameters: {
                    ...setting.parameters,
                    [parameter.id]: Number(event.currentTarget.value),
                  },
                })
              }
            />
          </label>
        ))}
      </fieldset>
    );
  };

  const overlays = INDICATOR_REGISTRY.indicators.filter(({ pane }) => pane === 'overlay');
  const subpanes = INDICATOR_REGISTRY.indicators.filter(({ pane }) => pane === 'subpane');
  return (
    <div className="grouped-list hide-scrollbar" data-registry-version={INDICATOR_REGISTRY.version}>
      {error ? <div role="alert">{error}</div> : null}
      <section>
        <h3>Chart display</h3>
        <div className="settings-field settings-field--row">
          <span className="settings-field-label">Volume</span>
          <Toggle
            on={chartDisplay.volumeEnabled}
            ariaLabel="Volume"
            onChange={(volumeEnabled) => onChangeChartDisplay({ volumeEnabled })}
          />
        </div>
      </section>
      <section>
        <h3>Price overlays</h3>
        {overlays.map(renderDescriptor)}
      </section>
      <section>
        <h3>Subpanes (max {INDICATOR_REGISTRY.maxSubPanes})</h3>
        {panesAtLimit ? (
          <div className="text-secondary" role="status">
            {INDICATOR_REGISTRY.paneLimitMessage}
          </div>
        ) : null}
        {subpanes.map(renderDescriptor)}
      </section>
    </div>
  );
}
