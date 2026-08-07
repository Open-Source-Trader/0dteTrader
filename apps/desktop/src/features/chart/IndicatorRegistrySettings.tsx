import { useState } from 'react';
import type {
  ChartDisplayPreferences,
  IndicatorDescriptor,
  IndicatorSettingsState,
} from '@0dtetrader/shared-types';
import { ChevronDownIcon, ChevronUpIcon } from '../../design/icons';
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

/** Section anchors the tree pane in IndicatorSettingsDesktop scrolls to. */
export const CHART_DISPLAY_SECTION_ID = 'settings-section-chart-display';
export const PRICE_OVERLAYS_SECTION_ID = 'settings-section-price-overlays';
export const SUBPANES_SECTION_ID = 'settings-section-subpanes';

function DisclosureIcon({ open }: { open: boolean }) {
  return open ? <ChevronUpIcon size={11} /> : <ChevronDownIcon size={11} />;
}

export function IndicatorRegistrySettings({
  settings,
  chartDisplay,
  onChange,
  onChangeChartDisplay,
}: IndicatorRegistrySettingsProps) {
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
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

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderDescriptor = (descriptor: IndicatorDescriptor) => {
    const setting = settings.indicators[descriptor.id];
    const availability = indicatorAvailability(descriptor.id);
    const atPaneLimit = descriptor.pane === 'subpane' && !setting.enabled && panesAtLimit;
    const hasParameters = Object.keys(descriptor.parameters).length > 0;
    const isOpen = hasParameters && expanded.has(descriptor.id);
    return (
      <div className="indicator-row-group" key={descriptor.id} data-indicator-id={descriptor.id}>
        <div className="indicator-row">
          <button
            type="button"
            className="indicator-row-disclosure"
            aria-label={
              isOpen ? `Collapse ${descriptor.displayName}` : `Expand ${descriptor.displayName}`
            }
            aria-expanded={hasParameters ? isOpen : undefined}
            disabled={!hasParameters}
            onClick={() => toggleExpanded(descriptor.id)}
          >
            {hasParameters ? <DisclosureIcon open={isOpen} /> : null}
          </button>
          <span className="indicator-row-label">{descriptor.displayName}</span>
          {!availability.available ? (
            <span className="indicator-row-badge" role="status">
              {availability.reason}
            </span>
          ) : null}
          <Toggle
            size="compact"
            on={setting.enabled}
            disabled={!availability.available || atPaneLimit}
            ariaLabel={`${descriptor.displayName} enabled`}
            onChange={(enabled) => update(descriptor, { enabled })}
          />
        </div>
        {isOpen
          ? Object.values(descriptor.parameters).map((parameter) => (
              <label className="indicator-param-row" key={parameter.id}>
                <span className="indicator-param-label">{parameter.label}</span>
                <div className="number-field">
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
                </div>
              </label>
            ))
          : null}
      </div>
    );
  };

  const overlays = INDICATOR_REGISTRY.indicators.filter(({ pane }) => pane === 'overlay');
  const subpanes = INDICATOR_REGISTRY.indicators.filter(({ pane }) => pane === 'subpane');
  return (
    <div data-registry-version={INDICATOR_REGISTRY.version}>
      {error ? (
        <div className="settings-error" role="alert">
          {error}
        </div>
      ) : null}
      <section className="grouped-section" id={CHART_DISPLAY_SECTION_ID}>
        <h3 className="section-header">Chart display</h3>
        <div className="section-card">
          <div className="grouped-row">
            <span className="settings-field-label">Volume</span>
            <Toggle
              size="compact"
              on={chartDisplay.volumeEnabled}
              ariaLabel="Volume"
              onChange={(volumeEnabled) => onChangeChartDisplay({ ...chartDisplay, volumeEnabled })}
            />
          </div>
          <div className="grouped-row">
            <span className="settings-field-label">Volume-Weighted Width</span>
            <Toggle
              size="compact"
              on={chartDisplay.volumeWeightedCandleWidth}
              ariaLabel="Volume-Weighted Width"
              onChange={(volumeWeightedCandleWidth) =>
                onChangeChartDisplay({ ...chartDisplay, volumeWeightedCandleWidth })
              }
            />
          </div>
        </div>
      </section>
      <section className="grouped-section" id={PRICE_OVERLAYS_SECTION_ID}>
        <h3 className="section-header">Price overlays</h3>
        <div className="section-card indicator-list">{overlays.map(renderDescriptor)}</div>
      </section>
      <section className="grouped-section" id={SUBPANES_SECTION_ID}>
        <h3 className="section-header">Subpanes (max {INDICATOR_REGISTRY.maxSubPanes})</h3>
        {panesAtLimit ? (
          <div className="section-footer text-secondary" role="status">
            {INDICATOR_REGISTRY.paneLimitMessage}
          </div>
        ) : null}
        <div className="section-card indicator-list">{subpanes.map(renderDescriptor)}</div>
      </section>
    </div>
  );
}
