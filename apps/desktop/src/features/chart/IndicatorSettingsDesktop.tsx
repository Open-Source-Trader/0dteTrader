import type { ChartDisplayPreferences, IndicatorSettingsState } from '@0dtetrader/shared-types';
import type { ChartTradingSettings } from './chartTradingSettings';
import { IndicatorSettingsBody } from './IndicatorSettingsView';
import type { OptionsAnalyticsSettings } from './optionsAnalytics/optionsAnalyticsSettings';
import type { TwcHeatmapSettings } from './twc/twcSettings';
import type { UsrSettings } from './ultimateSupportResistance/usrSettings';

interface IndicatorSettingsDesktopProps {
  settings: IndicatorSettingsState;
  chartDisplay: ChartDisplayPreferences;
  onChange: (settings: IndicatorSettingsState) => void;
  onChangeChartDisplay: (preferences: ChartDisplayPreferences) => void;
  twcEnabled: boolean;
  onToggleTwc: (on: boolean) => void;
  twcSettings: TwcHeatmapSettings;
  onChangeTwcSettings: (settings: TwcHeatmapSettings) => void;
  usrSettings: UsrSettings;
  onChangeUsrSettings: (settings: UsrSettings) => void;
  optionsAnalytics: OptionsAnalyticsSettings;
  onChangeOptionsAnalytics: (settings: OptionsAnalyticsSettings) => void;
  chartTrading: ChartTradingSettings;
  onChangeChartTrading: (settings: ChartTradingSettings) => void;
}

/** Desktop and compact settings share the canonical descriptor-driven body;
 * only their surrounding window chrome differs. */
export function IndicatorSettingsDesktop(props: IndicatorSettingsDesktopProps) {
  return (
    <div className="indicator-settings-desktop">
      <IndicatorSettingsBody {...props} />
    </div>
  );
}
