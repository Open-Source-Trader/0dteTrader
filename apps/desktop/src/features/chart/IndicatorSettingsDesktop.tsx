import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChartDisplayPreferences, IndicatorSettingsState } from '@0dtetrader/shared-types';
import { MagnifierIcon } from '../../design/icons';
import type { ChartTradingSettings } from './chartTradingSettings';
import {
  CHART_TRADING_SECTION_ID,
  IndicatorSettingsBody,
  OPTIONS_STRUCTURE_SECTION_ID,
  SCRIPTS_SECTION_ID,
} from './IndicatorSettingsView';
import {
  CHART_DISPLAY_SECTION_ID,
  PRICE_OVERLAYS_SECTION_ID,
  SUBPANES_SECTION_ID,
} from './IndicatorRegistrySettings';
import { INDICATOR_REGISTRY } from './indicatorRegistry';
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

interface CategoryEntry {
  id: string;
  label: string;
}

const CATEGORIES: CategoryEntry[] = [
  { id: CHART_DISPLAY_SECTION_ID, label: 'Chart Display' },
  { id: PRICE_OVERLAYS_SECTION_ID, label: 'Price Overlays' },
  { id: SUBPANES_SECTION_ID, label: 'Subpanes' },
  { id: SCRIPTS_SECTION_ID, label: 'Scripts' },
  { id: OPTIONS_STRUCTURE_SECTION_ID, label: 'Options Structure' },
  { id: CHART_TRADING_SECTION_ID, label: 'Chart Trading' },
];

/** Desktop and compact settings share the canonical descriptor-driven body;
 * the desktop surface additionally frames it with a searchable category
 * tree (VS Code / macOS System Settings convention) that scrolls the shared
 * body to the selected section instead of swapping panes — indicators stay
 * reachable by scroll or search without losing the rest of the settings. */
export function IndicatorSettingsDesktop(props: IndicatorSettingsDesktopProps) {
  const [query, setQuery] = useState('');
  const [activeCategoryId, setActiveCategoryId] = useState(CATEGORIES[0].id);
  const detailRef = useRef<HTMLDivElement>(null);

  const filteredCategories = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return CATEGORIES;
    const hasMatchingOverlay = INDICATOR_REGISTRY.indicators.some(
      (descriptor) =>
        descriptor.pane === 'overlay' && descriptor.displayName.toLowerCase().includes(trimmed),
    );
    const hasMatchingSubpane = INDICATOR_REGISTRY.indicators.some(
      (descriptor) =>
        descriptor.pane === 'subpane' && descriptor.displayName.toLowerCase().includes(trimmed),
    );
    return CATEGORIES.filter((category) => {
      if (category.label.toLowerCase().includes(trimmed)) return true;
      if (category.id === PRICE_OVERLAYS_SECTION_ID) return hasMatchingOverlay;
      if (category.id === SUBPANES_SECTION_ID) return hasMatchingSubpane;
      return false;
    });
  }, [query]);

  const goToCategory = (id: string) => {
    setActiveCategoryId(id);
    detailRef.current?.querySelector(`#${id}`)?.scrollIntoView({ block: 'start' });
  };

  // Jump to the first surviving match as the user types, so searching for an
  // indicator by name (not just a category label) scrolls straight to it.
  useEffect(() => {
    if (!query.trim()) return;
    const first = filteredCategories[0];
    if (first && first.id !== activeCategoryId) goToCategory(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the query narrows the list
  }, [filteredCategories]);

  return (
    <div className="indicator-settings-desktop">
      <div className="indicator-settings-tree-pane">
        <div className="indicator-settings-search">
          <MagnifierIcon size={12} style={{ color: 'var(--label-secondary)', flexShrink: 0 }} />
          <input
            className="indicator-settings-search-input"
            type="text"
            placeholder="Search settings"
            aria-label="Search indicator settings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="indicator-settings-tree" role="tree" aria-label="Settings categories">
          {filteredCategories.length === 0 ? (
            <div className="indicator-tree-empty">No matching settings</div>
          ) : (
            filteredCategories.map((category) => (
              <button
                key={category.id}
                type="button"
                role="treeitem"
                aria-selected={category.id === activeCategoryId}
                className={
                  category.id === activeCategoryId
                    ? 'indicator-tree-row active'
                    : 'indicator-tree-row'
                }
                onClick={() => goToCategory(category.id)}
              >
                {category.label}
              </button>
            ))
          )}
        </div>
      </div>
      <div className="indicator-settings-detail" ref={detailRef}>
        <IndicatorSettingsBody {...props} />
      </div>
    </div>
  );
}
