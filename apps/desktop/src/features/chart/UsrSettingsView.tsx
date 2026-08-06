import type { ReactNode } from 'react';
import { Toggle } from '../../design/components/Toggle';
import type { UsrSettings } from './ultimateSupportResistance/usrSettings';
import { DEFAULT_USR_SETTINGS } from './ultimateSupportResistance/usrSettings';

interface Props {
  settings: UsrSettings;
  onChange: (settings: UsrSettings) => void;
}

const BOOLEAN_ROWS: ReadonlyArray<[keyof UsrSettings, string]> = [
  ['enableProximityFilter', 'Price Proximity Filter'],
  ['showLiquidityPools', 'Liquidity Pools'],
  ['showFvg', 'Fair Value Gaps'],
  ['showConfluence', 'Confluence Areas'],
  ['enableSrFlip', 'Support / Resistance Flips'],
  ['showBounceSignals', 'Bounce Signals'],
  ['showSweepSignals', 'Sweep Signals'],
  ['signalRequireQualification', 'Require Wick or Volume Qualification'],
  ['requireConfirmationCandleDirection', 'Require Confirmation Direction'],
  ['cancelOpposingSignal', 'Cancel Nearby Opposing Signals'],
  ['orderBlockUseWicks', 'Order Blocks Use Wicks'],
  ['requirePriceVoidGaps', 'Require True Price-void Gaps'],
  ['sessionAwareVolume', 'Session-aware Volume Baseline'],
  ['showFlippedOrigins', 'Show Flipped Origins'],
  ['showAllBrokenLevels', 'Show All Broken Levels'],
  ['hidePooledLines', 'Hide Lines Inside Pools'],
  ['showIfvg', 'Inverse FVGs'],
  ['showFvgCe', 'FVG Consequent Encroachment'],
  ['showFvgLabels', 'FVG Labels'],
];

const NUMBER_ROWS: ReadonlyArray<[keyof UsrSettings, string, number, number, number]> = [
  ['proximityPercent', 'Proximity %', 1, 50, 1],
  ['maxSupportLevels', 'Retained Support Levels', 1, 500, 1],
  ['maxResistanceLevels', 'Retained Resistance Levels', 1, 500, 1],
  ['maxRecentSignalsTotal', 'Recent Signal Markers', 5, 100, 1],
  ['volumeLookback', 'Volume Lookback', 10, 200, 1],
  ['minimumRelativeVolume', 'Minimum Relative Volume', 1, 5, 0.05],
  ['minimumVolumeZScore', 'Minimum Volume Z-score', 0, 5, 0.25],
  ['maxSequenceLength', 'Maximum Sequence Length', 2, 50, 1],
  ['displacementBodyPercent', 'Displacement Body %', 40, 95, 5],
  ['displacementAtrMultiplier', 'Displacement ATR Multiple', 0.2, 3, 0.05],
  ['structureLookback', 'Structure Lookback', 2, 20, 1],
  ['pivotLeftBars', 'Pivot Left Bars', 1, 10, 1],
  ['pivotRightBars', 'Pivot Right Bars', 1, 5, 1],
  ['gapAtrMultiplier', 'Gap ATR Multiple', 0.05, 3, 0.05],
  ['breakBufferTicks', 'Break Buffer (ticks)', 1, 20, 1],
  ['zoneMitigationPercent', 'Zone Mitigation Fraction', 0.5, 1, 0.05],
  ['minimumTick', 'Instrument Minimum Tick', 0.000001, 100, 0.000001],
  ['poolClusterThreshold', 'Pool Minimum Levels', 2, 10, 1],
  ['poolAtrFactor', 'Pool ATR Factor', 1, 5, 0.1],
  ['maxSupportPools', 'Maximum Support Pools', 1, 60, 1],
  ['maxResistancePools', 'Maximum Resistance Pools', 1, 60, 1],
  ['fvgFillPercent', 'FVG Fill %', 10, 100, 5],
  ['fvgLookback', 'FVG Body Lookback', 3, 50, 1],
  ['fvgBodyPercent', 'FVG Body Factor', 0.05, 3, 0.01],
  ['fvgWickPercent', 'FVG Wick Factor', 0, 2, 0.05],
  ['maxVisibleFvgs', 'Visible FVGs per Side', 1, 15, 1],
  ['fvgMaxBarsActive', 'FVG Maximum Age', 10, 500, 1],
  ['fvgMinGapAtr', 'FVG Minimum Gap ATR', 0, 1, 0.01],
  ['fvgMinBodyAtr', 'FVG Minimum Body ATR', 0, 3, 0.05],
];

const COLOR_ROWS: ReadonlyArray<[keyof UsrSettings, string]> = [
  ['fvgBullishColor', 'Bullish FVG Color'],
  ['fvgBearishColor', 'Bearish FVG Color'],
  ['fvgCeColor', 'FVG CE Color'],
  ['ifvgBullishColor', 'Bullish IFVG Color'],
  ['ifvgBearishColor', 'Bearish IFVG Color'],
];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="settings-field settings-field--row">
      <span>{label}</span>
      {children}
    </div>
  );
}

export function UsrSettingsBody({ settings, onChange }: Props) {
  const patch = (value: Partial<UsrSettings>) => onChange({ ...settings, ...value });
  return (
    <div>
      <Row label="Analysis Timeframe">
        <select
          value={settings.analysisTimeframe}
          onChange={(event) =>
            patch({ analysisTimeframe: event.target.value as UsrSettings['analysisTimeframe'] })
          }
          aria-label="Ultimate S/R analysis timeframe"
        >
          <option value="chart">Chart</option>
          <option value="auto">Auto</option>
          <option value="4h">4 hours</option>
          <option value="1d">1 day</option>
          <option value="3d">3 days</option>
          <option value="1w">1 week</option>
          <option value="2w">2 weeks</option>
          <option value="1m">1 month</option>
          <option value="custom">Custom</option>
        </select>
      </Row>
      <Row label="FVG Fill Milestone">
        <select
          value={settings.fvgFillMode}
          onChange={(event) =>
            patch({ fvgFillMode: event.target.value as UsrSettings['fvgFillMode'] })
          }
          aria-label="Ultimate S/R FVG fill mode"
        >
          <option value="touch">Touch</option>
          <option value="close">Close inside</option>
          <option value="ce">50% CE</option>
          <option value="percent">Custom percent</option>
        </select>
      </Row>
      {settings.analysisTimeframe === 'custom' ? (
        <Row label="Custom Timeframe">
          <input
            key={settings.customTimeframe}
            type="text"
            defaultValue={settings.customTimeframe}
            aria-label="Ultimate S/R custom timeframe"
            onBlur={(event) => patch({ customTimeframe: event.target.value.trim().toUpperCase() })}
          />
        </Row>
      ) : null}
      {BOOLEAN_ROWS.map(([key, label]) => (
        <Row key={key} label={label}>
          <Toggle on={settings[key] as boolean} onChange={(value) => patch({ [key]: value })} />
        </Row>
      ))}
      {NUMBER_ROWS.map(([key, label, min, max, step]) => (
        <Row key={key} label={label}>
          <input
            type="number"
            value={settings[key] as number}
            min={min}
            max={max}
            step={step}
            aria-label={`Ultimate S/R ${label}`}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value) && value >= min && value <= max) patch({ [key]: value });
            }}
          />
        </Row>
      ))}
      {COLOR_ROWS.map(([key, label]) => (
        <Row key={key} label={label}>
          <input
            key={String(settings[key])}
            type="text"
            defaultValue={settings[key] as string}
            aria-label={`Ultimate S/R ${label}`}
            onBlur={(event) => patch({ [key]: event.target.value })}
          />
        </Row>
      ))}
      <button
        className="grouped-row button-row"
        onClick={() => onChange({ ...DEFAULT_USR_SETTINGS, enabled: settings.enabled })}
      >
        Reset Ultimate S/R
      </button>
    </div>
  );
}
