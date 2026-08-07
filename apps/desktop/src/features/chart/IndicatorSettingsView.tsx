import type { ChartDisplayPreferences, IndicatorSettingsState } from '@0dtetrader/shared-types';
import { DesktopSheet } from '../../design/components/DesktopSheet';
import { NavBar } from '../../design/components/NavBar';
import { Sheet } from '../../design/components/Sheet';
import { Stepper } from '../../design/components/Stepper';
import { Toggle } from '../../design/components/Toggle';
import {
  CHART_TRADING_QUANTITY_MAX,
  CHART_TRADING_QUANTITY_MIN,
  type ChartTradingSettings,
} from './chartTradingSettings';
import { IndicatorRegistrySettings } from './IndicatorRegistrySettings';
import {
  DEFAULT_OPTIONS_ANALYTICS_SETTINGS,
  type OptionsAnalyticsSettings,
} from './optionsAnalytics/optionsAnalyticsSettings';
import { TwcSettingsBody } from './TwcSettingsView';
import type { TwcHeatmapSettings } from './twc/twcSettings';
import { DEFAULT_CHART_DISPLAY, DEFAULT_INDICATOR_SETTINGS_STATE } from './indicatorRegistry';
import { UsrSettingsBody } from './UsrSettingsView';
import type { UsrSettings } from './ultimateSupportResistance/usrSettings';

export interface IndicatorSettingsViewProps {
  settings: IndicatorSettingsState;
  chartDisplay: ChartDisplayPreferences;
  onChange: (settings: IndicatorSettingsState) => void;
  onChangeChartDisplay: (preferences: ChartDisplayPreferences) => void;
  onDismiss: () => void;
  twcEnabled: boolean;
  onToggleTwc: (on: boolean) => void;
  twcSettings: TwcHeatmapSettings;
  onChangeTwcSettings: (settings: TwcHeatmapSettings) => void;
  usrSettings: UsrSettings;
  onChangeUsrSettings: (settings: UsrSettings) => void;
  optionsAnalytics: OptionsAnalyticsSettings;
  chartTrading: ChartTradingSettings;
  onChangeChartTrading: (settings: ChartTradingSettings) => void;
  onChangeOptionsAnalytics: (settings: OptionsAnalyticsSettings) => void;
  dense?: boolean;
}

export function IndicatorSettingsBody(
  props: Omit<IndicatorSettingsViewProps, 'onDismiss' | 'dense'>,
) {
  const patchOptions = (patch: Partial<OptionsAnalyticsSettings>) =>
    props.onChangeOptionsAnalytics({ ...props.optionsAnalytics, ...patch });
  const patchChartTrading = (patch: Partial<ChartTradingSettings>) =>
    props.onChangeChartTrading({ ...props.chartTrading, ...patch });
  return (
    <div className="indicator-settings-body">
      <IndicatorRegistrySettings
        settings={props.settings}
        chartDisplay={props.chartDisplay}
        onChange={props.onChange}
        onChangeChartDisplay={props.onChangeChartDisplay}
      />
      <section className="grouped-section">
        <h3>Scripts</h3>
        <div className="settings-field settings-field--row">
          <span>TradingView Concepts</span>
          <Toggle on={props.twcEnabled} onChange={props.onToggleTwc} />
        </div>
        {props.twcEnabled ? (
          <TwcSettingsBody settings={props.twcSettings} onChange={props.onChangeTwcSettings} />
        ) : null}
        <div className="settings-field settings-field--row">
          <span>Ultimate Support &amp; Resistance</span>
          <Toggle
            on={props.usrSettings.enabled}
            onChange={(enabled) => props.onChangeUsrSettings({ ...props.usrSettings, enabled })}
          />
        </div>
        {props.usrSettings.enabled ? (
          <UsrSettingsBody settings={props.usrSettings} onChange={props.onChangeUsrSettings} />
        ) : null}
      </section>
      <section className="grouped-section">
        <h3>Options Structure</h3>
        <OptionToggle
          label="Enabled"
          value={props.optionsAnalytics.enabled}
          onChange={(enabled) => patchOptions({ enabled })}
        />
        <OptionToggle
          label="Implied 68% Range"
          value={props.optionsAnalytics.showImpliedRange}
          onChange={(showImpliedRange) => patchOptions({ showImpliedRange })}
        />
        <OptionToggle
          label="Gamma Profile"
          value={props.optionsAnalytics.showGammaProfile}
          onChange={(showGammaProfile) => patchOptions({ showGammaProfile })}
        />
        <OptionToggle
          label="Marked OI Value"
          value={props.optionsAnalytics.showMarkedOi}
          onChange={(showMarkedOi) => patchOptions({ showMarkedOi })}
        />
        <OptionToggle
          label="Liquidity (Spread / Round Trip)"
          value={props.optionsAnalytics.showLiquidity}
          onChange={(showLiquidity) => patchOptions({ showLiquidity })}
        />
        <OptionToggle
          label="Dealer Gamma Flip Proxy"
          value={props.optionsAnalytics.showDealerProxy}
          onChange={(showDealerProxy) => patchOptions({ showDealerProxy })}
        />
        <div className="settings-field settings-field--row">
          <span>Profile Strikes: {props.optionsAnalytics.profileStrikeCount}</span>
          <Stepper
            value={props.optionsAnalytics.profileStrikeCount}
            min={3}
            max={20}
            ariaLabel="Profile strikes"
            onChange={(profileStrikeCount) => patchOptions({ profileStrikeCount })}
          />
        </div>
        <div className="settings-field settings-field--row">
          <span>Refresh: {props.optionsAnalytics.refreshSeconds}s</span>
          <Stepper
            value={props.optionsAnalytics.refreshSeconds}
            min={15}
            max={120}
            step={15}
            ariaLabel="Refresh interval"
            onChange={(refreshSeconds) => patchOptions({ refreshSeconds })}
          />
        </div>
        <OptionToggle
          label="Diagnostics & Quality Warnings"
          value={props.optionsAnalytics.showDiagnostics}
          onChange={(showDiagnostics) => patchOptions({ showDiagnostics })}
        />
      </section>
      <section className="grouped-section">
        <h3>Chart Trading</h3>
        <OptionToggle
          label="Enabled"
          value={props.chartTrading.enabled}
          onChange={(enabled) => patchChartTrading({ enabled })}
        />
        <OptionToggle
          label="Bracket from Entry Line"
          value={props.chartTrading.bracketDrag}
          onChange={(bracketDrag) => patchChartTrading({ bracketDrag })}
        />
        <div className="settings-field settings-field--row">
          <span>Default Quantity: {props.chartTrading.defaultQuantity}</span>
          <Stepper
            value={props.chartTrading.defaultQuantity}
            min={CHART_TRADING_QUANTITY_MIN}
            max={CHART_TRADING_QUANTITY_MAX}
            ariaLabel="Default quantity"
            onChange={(defaultQuantity) => patchChartTrading({ defaultQuantity })}
          />
        </div>
      </section>
      <section className="grouped-section">
        <button
          className="grouped-row button-row"
          onClick={() => {
            props.onChange(DEFAULT_INDICATOR_SETTINGS_STATE);
            props.onChangeChartDisplay(DEFAULT_CHART_DISPLAY);
          }}
        >
          Reset Indicators
        </button>
        <button
          className="grouped-row button-row"
          onClick={() => props.onChangeOptionsAnalytics(DEFAULT_OPTIONS_ANALYTICS_SETTINGS)}
        >
          Reset Options
        </button>
      </section>
    </div>
  );
}

function OptionToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="settings-field settings-field--row">
      <span>{label}</span>
      <Toggle on={value} onChange={onChange} />
    </div>
  );
}

export function IndicatorSettingsView({ dense = false, ...props }: IndicatorSettingsViewProps) {
  const body = (
    <div
      style={{
        background: 'var(--app-background)',
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <NavBar
        title="Indicators"
        trailing={
          <button className="navbar-text-button" onClick={props.onDismiss}>
            Done
          </button>
        }
      />
      <div className="sheet-body hide-scrollbar">
        <IndicatorSettingsBody {...props} />
      </div>
    </div>
  );
  return dense ? (
    <DesktopSheet onDismiss={props.onDismiss}>{body}</DesktopSheet>
  ) : (
    <Sheet detent="large" onDismiss={props.onDismiss}>
      {body}
    </Sheet>
  );
}
