import { useMemo, useState } from 'react';
import { NumberField } from '../../design/components/NumberField';
import { Toggle } from '../../design/components/Toggle';
import { ChevronDownIcon, MagnifierIcon } from '../../design/icons';
import type { IndicatorSettings } from './indicatorSettings';
import { DEFAULT_INDICATOR_SETTINGS, enabledSubPanes, MAX_SUB_PANES } from './indicatorSettings';
import type { OptionsAnalyticsSettings } from './optionsAnalytics/optionsAnalyticsSettings';
import { DEFAULT_OPTIONS_ANALYTICS_SETTINGS } from './optionsAnalytics/optionsAnalyticsSettings';
import { buildTwcSections } from './twcSections';
import { DEFAULT_TWC_SETTINGS } from './twc/twcSettings';
import type { TwcHeatmapSettings } from './twc/twcSettings';

interface IndicatorSettingsDesktopProps {
  settings: IndicatorSettings;
  onChange: (settings: IndicatorSettings) => void;
  twcEnabled: boolean;
  onToggleTwc: (on: boolean) => void;
  twcSettings: TwcHeatmapSettings;
  onChangeTwcSettings: (settings: TwcHeatmapSettings) => void;
  optionsAnalytics: OptionsAnalyticsSettings;
  onChangeOptionsAnalytics: (settings: OptionsAnalyticsSettings) => void;
}

/** A single form row: label above the control (VS Code / macOS System
 *  Settings convention), not label-left/control-right — the label can wrap
 *  and the control isn't squeezed into a fixed-width right column. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="settings-field">
      <span className="settings-field-label">{label}</span>
      {children}
    </label>
  );
}

function ToggleField({
  label,
  on,
  onChange,
  disabled = false,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="settings-field settings-field--row">
      <span className="settings-field-label">{label}</span>
      <Toggle on={on} onChange={onChange} disabled={disabled} />
    </div>
  );
}

interface TreeNode {
  id: string;
  label: string;
  render: () => React.ReactNode;
  children?: TreeNode[];
  /** Field labels rendered inside this node (e.g. "VWAP Rip Markers" inside
   *  the "VWAP Z-Score" group) — searched in addition to the node's own
   *  label, so search finds a setting even though the tree only shows its
   *  parent group name. */
  searchTerms?: string[];
}

/** Indicator settings reimagined as a desktop application preferences pane:
 *  a searchable category tree on the left (VS Code Settings convention)
 *  instead of one long scrolling list, and bordered fieldsets of real form
 *  controls (typeable numbers, native-feeling dropdowns) on the right
 *  instead of iOS-style label-left/value-right rows. Desktop grid only —
 *  compact/phone layout keeps IndicatorSettingsView/IndicatorSettingsBody
 *  unchanged. */
export function IndicatorSettingsDesktop({
  settings,
  onChange,
  twcEnabled,
  onToggleTwc,
  twcSettings,
  onChangeTwcSettings,
  optionsAnalytics,
  onChangeOptionsAnalytics,
}: IndicatorSettingsDesktopProps) {
  const patch = (partial: Partial<IndicatorSettings>) => onChange({ ...settings, ...partial });
  const patchOptionsAnalytics = (partial: Partial<OptionsAnalyticsSettings>) =>
    onChangeOptionsAnalytics({ ...optionsAnalytics, ...partial });

  const paneCapReached = enabledSubPanes(settings).length >= MAX_SUB_PANES;
  const paneToggleDisabled = (enabled: boolean) => !enabled && paneCapReached;

  const twcSections = useMemo(
    () => buildTwcSections(twcSettings, onChangeTwcSettings),
    [twcSettings, onChangeTwcSettings],
  );

  const tree: TreeNode[] = useMemo(
    () => [
      {
        id: 'price-overlays',
        label: 'Price Overlays',
        searchTerms: [
          'SMA',
          'SMA Period',
          'EMA',
          'EMA Period',
          'VWAP',
          'Volume',
          'Bollinger Bands',
          'Bollinger Period',
          'Bollinger Width',
        ],
        render: () => (
          <div className="settings-fieldset">
            <div className="settings-fieldset-legend">Price Overlays</div>
            <ToggleField
              label="SMA"
              on={settings.smaEnabled}
              onChange={(on) => patch({ smaEnabled: on })}
            />
            {settings.smaEnabled ? (
              <Field label="SMA Period">
                <NumberField
                  value={settings.smaPeriod}
                  min={2}
                  max={200}
                  onChange={(value) => patch({ smaPeriod: value })}
                />
              </Field>
            ) : null}
            <ToggleField
              label="EMA"
              on={settings.emaEnabled}
              onChange={(on) => patch({ emaEnabled: on })}
            />
            {settings.emaEnabled ? (
              <Field label="EMA Period">
                <NumberField
                  value={settings.emaPeriod}
                  min={2}
                  max={200}
                  onChange={(value) => patch({ emaPeriod: value })}
                />
              </Field>
            ) : null}
            <ToggleField
              label="VWAP"
              on={settings.vwapEnabled}
              onChange={(on) => patch({ vwapEnabled: on })}
            />
            <ToggleField
              label="Volume"
              on={settings.volumeEnabled}
              onChange={(on) => patch({ volumeEnabled: on })}
            />
            <ToggleField
              label="Bollinger Bands"
              on={settings.bollingerEnabled}
              onChange={(on) => patch({ bollingerEnabled: on })}
            />
            {settings.bollingerEnabled ? (
              <>
                <Field label="Bollinger Period">
                  <NumberField
                    value={settings.bollingerPeriod}
                    min={5}
                    max={100}
                    onChange={(value) => patch({ bollingerPeriod: value })}
                  />
                </Field>
                <Field label="Bollinger Width (σ)">
                  <NumberField
                    value={settings.bollingerMultiplier}
                    min={0.5}
                    max={4}
                    step={0.5}
                    decimals={1}
                    onChange={(value) => patch({ bollingerMultiplier: value })}
                  />
                </Field>
              </>
            ) : null}
            <button
              className="settings-reset-button"
              onClick={() => onChange(DEFAULT_INDICATOR_SETTINGS)}
            >
              Reset Overlays &amp; Sub-Panes to Defaults
            </button>
          </div>
        ),
      },
      {
        id: 'sub-panes',
        label: `Sub-Panes (max ${MAX_SUB_PANES})`,
        searchTerms: [
          'RSI',
          'RSI Period',
          'MACD',
          'MACD Fast Period',
          'MACD Slow Period',
          'MACD Signal Period',
          'Stochastic',
          '%K Period',
          '%K Smoothing',
          '%D Period',
          'ATR',
          'ATR Period',
        ],
        render: () => (
          <div className="settings-fieldset">
            <div className="settings-fieldset-legend">Sub-Panes (max {MAX_SUB_PANES})</div>
            <ToggleField
              label="RSI"
              on={settings.rsiEnabled}
              onChange={(on) => patch({ rsiEnabled: on })}
              disabled={paneToggleDisabled(settings.rsiEnabled)}
            />
            {settings.rsiEnabled ? (
              <Field label="RSI Period">
                <NumberField
                  value={settings.rsiPeriod}
                  min={2}
                  max={50}
                  onChange={(value) => patch({ rsiPeriod: value })}
                />
              </Field>
            ) : null}
            <ToggleField
              label="MACD"
              on={settings.macdEnabled}
              onChange={(on) => patch({ macdEnabled: on })}
              disabled={paneToggleDisabled(settings.macdEnabled)}
            />
            {settings.macdEnabled ? (
              <>
                <Field label="MACD Fast Period">
                  <NumberField
                    value={settings.macdFastPeriod}
                    min={2}
                    max={50}
                    onChange={(value) => patch({ macdFastPeriod: value })}
                  />
                </Field>
                <Field label="MACD Slow Period">
                  <NumberField
                    value={settings.macdSlowPeriod}
                    min={2}
                    max={200}
                    onChange={(value) => patch({ macdSlowPeriod: value })}
                  />
                </Field>
                <Field label="MACD Signal Period">
                  <NumberField
                    value={settings.macdSignalPeriod}
                    min={2}
                    max={50}
                    onChange={(value) => patch({ macdSignalPeriod: value })}
                  />
                </Field>
              </>
            ) : null}
            <ToggleField
              label="Stochastic"
              on={settings.stochEnabled}
              onChange={(on) => patch({ stochEnabled: on })}
              disabled={paneToggleDisabled(settings.stochEnabled)}
            />
            {settings.stochEnabled ? (
              <>
                <Field label="%K Period">
                  <NumberField
                    value={settings.stochKPeriod}
                    min={5}
                    max={50}
                    onChange={(value) => patch({ stochKPeriod: value })}
                  />
                </Field>
                <Field label="%K Smoothing">
                  <NumberField
                    value={settings.stochKSmooth}
                    min={1}
                    max={10}
                    onChange={(value) => patch({ stochKSmooth: value })}
                  />
                </Field>
                <Field label="%D Period">
                  <NumberField
                    value={settings.stochDPeriod}
                    min={1}
                    max={10}
                    onChange={(value) => patch({ stochDPeriod: value })}
                  />
                </Field>
              </>
            ) : null}
            <ToggleField
              label="ATR"
              on={settings.atrEnabled}
              onChange={(on) => patch({ atrEnabled: on })}
              disabled={paneToggleDisabled(settings.atrEnabled)}
            />
            {settings.atrEnabled ? (
              <Field label="ATR Period">
                <NumberField
                  value={settings.atrPeriod}
                  min={2}
                  max={50}
                  onChange={(value) => patch({ atrPeriod: value })}
                />
              </Field>
            ) : null}
            {paneCapReached ? (
              <p className="settings-fieldset-hint">
                Two sub-panes max — turn one off to enable another.
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'twc-heatmap',
        label: 'TWC Heatmap V5',
        render: () => (
          <div className="settings-fieldset">
            <div className="settings-fieldset-legend">
              <span>TWC Heatmap V5</span>
              <Toggle on={twcEnabled} onChange={onToggleTwc} />
            </div>
            <p className="settings-fieldset-hint">Pick a group on the left to edit its inputs.</p>
          </div>
        ),
        children: twcSections
          .filter((s) => s.id !== 'reset')
          .map((s) => ({
            id: `twc-${s.id}`,
            label: s.label,
            searchTerms: s.searchTerms,
            render: () => s.content,
          }))
          .concat([
            {
              id: 'twc-reset',
              label: 'Reset to Defaults',
              searchTerms: ['Reset to Defaults'],
              render: () => (
                <div className="settings-fieldset">
                  <button
                    className="settings-reset-button"
                    onClick={() =>
                      onChangeTwcSettings({ ...DEFAULT_TWC_SETTINGS, enabled: twcSettings.enabled })
                    }
                  >
                    Reset TWC Heatmap V5 to Defaults
                  </button>
                </div>
              ),
            },
          ]),
      },
      {
        id: 'options-structure',
        label: 'Options Structure',
        searchTerms: [
          'Implied 68% Range',
          'Gamma Profile',
          'Marked OI Value',
          'Liquidity',
          'Spread',
          'Round Trip',
          'Dealer Gamma Flip Proxy',
          'Profile Strikes',
          'Refresh',
          'Diagnostics',
          'Quality Warnings',
        ],
        render: () => (
          <div className="settings-fieldset">
            <div className="settings-fieldset-legend">
              <span>Options Structure</span>
              <Toggle
                on={optionsAnalytics.enabled}
                onChange={(on) => patchOptionsAnalytics({ enabled: on })}
              />
            </div>
            {optionsAnalytics.enabled ? (
              <>
                <ToggleField
                  label="Implied 68% Range"
                  on={optionsAnalytics.showImpliedRange}
                  onChange={(on) => patchOptionsAnalytics({ showImpliedRange: on })}
                />
                <ToggleField
                  label="Gamma Profile"
                  on={optionsAnalytics.showGammaProfile}
                  onChange={(on) => patchOptionsAnalytics({ showGammaProfile: on })}
                />
                <ToggleField
                  label="Marked OI Value"
                  on={optionsAnalytics.showMarkedOi}
                  onChange={(on) => patchOptionsAnalytics({ showMarkedOi: on })}
                />
                <ToggleField
                  label="Liquidity (Spread / Round Trip)"
                  on={optionsAnalytics.showLiquidity}
                  onChange={(on) => patchOptionsAnalytics({ showLiquidity: on })}
                />
                <ToggleField
                  label="Dealer Gamma Flip Proxy"
                  on={optionsAnalytics.showDealerProxy}
                  onChange={(on) => patchOptionsAnalytics({ showDealerProxy: on })}
                />
                <Field label="Profile Strikes">
                  <NumberField
                    value={optionsAnalytics.profileStrikeCount}
                    min={3}
                    max={20}
                    onChange={(value) => patchOptionsAnalytics({ profileStrikeCount: value })}
                  />
                </Field>
                <Field label="Refresh (seconds)">
                  <NumberField
                    value={optionsAnalytics.refreshSeconds}
                    min={15}
                    max={120}
                    step={15}
                    onChange={(value) => patchOptionsAnalytics({ refreshSeconds: value })}
                  />
                </Field>
                <ToggleField
                  label="Diagnostics & Quality Warnings"
                  on={optionsAnalytics.showDiagnostics}
                  onChange={(on) => patchOptionsAnalytics({ showDiagnostics: on })}
                />
              </>
            ) : null}
            <button
              className="settings-reset-button"
              onClick={() => onChangeOptionsAnalytics(DEFAULT_OPTIONS_ANALYTICS_SETTINGS)}
            >
              Reset Options Structure to Defaults
            </button>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings, optionsAnalytics, twcEnabled, twcSections, paneCapReached],
  );

  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ 'twc-heatmap': true });
  const [selectedId, setSelectedId] = useState('price-overlays');

  const normalizedQuery = query.trim().toLowerCase();
  // A node matches on its own label or any of its field labels — so
  // searching "VWAP Rip Markers" finds the "VWAP Z-Score" group even though
  // the tree only ever shows the group name, not each field inside it.
  const nodeMatches = (node: TreeNode) =>
    node.label.toLowerCase().includes(normalizedQuery) ||
    (node.searchTerms?.some((term) => term.toLowerCase().includes(normalizedQuery)) ?? false);

  // A parent matches if it matches directly or any child does; a filtered
  // tree with a query auto-expands parents so matches are always visible.
  const visibleTree = useMemo(() => {
    if (!normalizedQuery) return tree;
    const result: TreeNode[] = [];
    for (const node of tree) {
      const children = node.children?.filter((child) => nodeMatches(child));
      const selfMatches = nodeMatches(node);
      if (!selfMatches && (!children || children.length === 0)) continue;
      result.push(selfMatches ? node : { ...node, children });
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, normalizedQuery]);

  const flatNodes = useMemo(() => {
    const flat: TreeNode[] = [];
    for (const node of visibleTree) {
      flat.push(node);
      if (node.children && (expanded[node.id] || normalizedQuery)) flat.push(...node.children);
    }
    return flat;
  }, [visibleTree, expanded, normalizedQuery]);

  const selected = flatNodes.find((n) => n.id === selectedId) ?? flatNodes[0];

  return (
    <div className="indicator-settings-desktop">
      <div className="indicator-settings-tree-pane">
        <div className="indicator-settings-search">
          <MagnifierIcon size={13} style={{ color: 'var(--label-secondary)' }} />
          <input
            className="indicator-settings-search-input"
            placeholder="Search settings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search indicator settings"
          />
        </div>
        <div className="indicator-settings-tree" role="tree">
          {visibleTree.map((node) => (
            <div key={node.id}>
              <button
                type="button"
                role="treeitem"
                aria-selected={selected?.id === node.id}
                aria-expanded={
                  node.children ? Boolean(expanded[node.id] || normalizedQuery) : undefined
                }
                className={`indicator-tree-row${selected?.id === node.id ? ' active' : ''}`}
                onClick={() => {
                  setSelectedId(node.id);
                  if (node.children) setExpanded((e) => ({ ...e, [node.id]: true }));
                }}
              >
                {node.children ? (
                  <span
                    className="indicator-tree-disclosure"
                    role="button"
                    aria-label={expanded[node.id] ? 'Collapse' : 'Expand'}
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpanded((e) => ({ ...e, [node.id]: !e[node.id] }));
                    }}
                    style={{
                      transform:
                        expanded[node.id] || normalizedQuery ? 'rotate(0deg)' : 'rotate(-90deg)',
                    }}
                  >
                    <ChevronDownIcon size={11} />
                  </span>
                ) : (
                  <span className="indicator-tree-disclosure" aria-hidden="true" />
                )}
                {node.label}
              </button>
              {node.children && (expanded[node.id] || normalizedQuery)
                ? node.children.map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      role="treeitem"
                      aria-selected={selected?.id === child.id}
                      className={`indicator-tree-row indicator-tree-row--child${
                        selected?.id === child.id ? ' active' : ''
                      }`}
                      onClick={() => setSelectedId(child.id)}
                    >
                      {child.label}
                    </button>
                  ))
                : null}
            </div>
          ))}
          {visibleTree.length === 0 ? (
            <p className="settings-fieldset-hint" style={{ padding: 'var(--space-3)' }}>
              No settings match &quot;{query}&quot;.
            </p>
          ) : null}
        </div>
      </div>
      <div className="indicator-settings-detail hide-scrollbar">
        {selected ? selected.render() : null}
      </div>
    </div>
  );
}
