import { useEffect, useState, type ReactNode } from 'react';
import { Toggle } from '../../design/components/Toggle';
import { isValidScriptColor } from './scriptOverlayTypes';
import type { UsrSettings } from './ultimateSupportResistance/usrSettings';
import {
  DEFAULT_USR_SETTINGS,
  USR_NUMBER_BOUNDS,
  type UsrNumberBounds,
} from './ultimateSupportResistance/usrSettings';
import { parseUsrTimeframeValue } from './ultimateSupportResistance/usrTimeframe';

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

const NUMBER_ROWS: ReadonlyArray<[keyof UsrSettings, string, number]> = [
  ['proximityPercent', 'Proximity %', 1],
  ['maxSupportLevels', 'Retained Support Levels', 1],
  ['maxResistanceLevels', 'Retained Resistance Levels', 1],
  ['maxRecentSignalsTotal', 'Recent Signal Markers', 1],
  ['volumeLookback', 'Volume Lookback', 1],
  ['minimumRelativeVolume', 'Minimum Relative Volume', 0.05],
  ['minimumVolumeZScore', 'Minimum Volume Z-score', 0.25],
  ['maxSequenceLength', 'Maximum Sequence Length', 1],
  ['displacementBodyPercent', 'Displacement Body %', 5],
  ['displacementAtrMultiplier', 'Displacement ATR Multiple', 0.05],
  ['structureLookback', 'Structure Lookback', 1],
  ['pivotLeftBars', 'Pivot Left Bars', 1],
  ['pivotRightBars', 'Pivot Right Bars', 1],
  ['gapAtrMultiplier', 'Gap ATR Multiple', 0.05],
  ['breakBufferTicks', 'Break Buffer (ticks)', 1],
  ['zoneMitigationPercent', 'Zone Mitigation Fraction', 0.05],
  ['minimumTick', 'Instrument Minimum Tick', 0.000001],
  ['poolClusterThreshold', 'Pool Minimum Levels', 1],
  ['poolAtrFactor', 'Pool ATR Factor', 0.1],
  ['maxSupportPools', 'Maximum Support Pools', 1],
  ['maxResistancePools', 'Maximum Resistance Pools', 1],
  ['fvgFillPercent', 'FVG Fill %', 5],
  ['fvgLookback', 'FVG Body Lookback', 1],
  ['fvgBodyPercent', 'FVG Body Factor', 0.01],
  ['fvgWickPercent', 'FVG Wick Factor', 0.05],
  ['maxVisibleFvgs', 'Visible FVGs per Side', 1],
  ['fvgMaxBarsActive', 'FVG Maximum Age', 1],
  ['fvgMinGapAtr', 'FVG Minimum Gap ATR', 0.01],
  ['fvgMinBodyAtr', 'FVG Minimum Body ATR', 0.05],
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

interface ValidatedTextInputProps {
  value: string;
  label: string;
  normalize?: (value: string) => string;
  validate: (value: string) => boolean;
  onCommit: (value: string) => void;
}

/**
 * Keeps incomplete text edits local. A malformed blur is visibly rejected and
 * cannot leak into the persisted model while the last valid value stays live.
 */
function ValidatedTextInput({
  value,
  label,
  normalize = (candidate) => candidate.trim(),
  validate,
  onCommit,
}: ValidatedTextInputProps) {
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(value);
    setInvalid(false);
  }, [value]);

  const commit = () => {
    const candidate = normalize(draft);
    if (!validate(candidate)) {
      setDraft(value);
      setInvalid(true);
      return;
    }
    setDraft(candidate);
    setInvalid(false);
    onCommit(candidate);
  };

  return (
    <input
      type="text"
      value={draft}
      aria-label={label}
      aria-invalid={invalid}
      title={invalid ? 'Invalid value; the last valid setting remains active.' : undefined}
      onChange={(event) => {
        setDraft(event.target.value);
        setInvalid(false);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

interface ValidatedNumberInputProps {
  value: number;
  label: string;
  bounds: UsrNumberBounds;
  step: number;
  onCommit: (value: number) => void;
}

function ValidatedNumberInput({ value, label, bounds, step, onCommit }: ValidatedNumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(String(value));
    setInvalid(false);
  }, [value]);

  const commit = () => {
    const candidate = Number(draft);
    const valid =
      draft.trim().length > 0 &&
      Number.isFinite(candidate) &&
      candidate >= bounds.minimum &&
      candidate <= bounds.maximum &&
      (bounds.integer !== true || Number.isInteger(candidate));
    if (!valid) {
      setDraft(String(value));
      setInvalid(true);
      return;
    }
    setDraft(String(candidate));
    setInvalid(false);
    onCommit(candidate);
  };

  return (
    <input
      type="number"
      value={draft}
      min={bounds.minimum}
      max={bounds.maximum}
      step={step}
      aria-label={label}
      aria-invalid={invalid}
      title={invalid ? 'Invalid value; the last valid setting remains active.' : undefined}
      onChange={(event) => {
        setDraft(event.target.value);
        setInvalid(false);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
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
          <ValidatedTextInput
            value={settings.customTimeframe}
            label="Ultimate S/R custom timeframe"
            normalize={(value) => value.trim().toUpperCase()}
            validate={(value) => parseUsrTimeframeValue(value) !== null}
            onCommit={(customTimeframe) => patch({ customTimeframe })}
          />
        </Row>
      ) : null}
      {BOOLEAN_ROWS.map(([key, label]) => (
        <Row key={key} label={label}>
          <Toggle on={settings[key] as boolean} onChange={(value) => patch({ [key]: value })} />
        </Row>
      ))}
      {NUMBER_ROWS.map(([key, label, step]) => {
        const bounds = USR_NUMBER_BOUNDS[key];
        if (!bounds) return null;
        return (
          <Row key={key} label={label}>
            <ValidatedNumberInput
              value={settings[key] as number}
              label={`Ultimate S/R ${label}`}
              bounds={bounds}
              step={step}
              onCommit={(value) => patch({ [key]: value })}
            />
          </Row>
        );
      })}
      {COLOR_ROWS.map(([key, label]) => (
        <Row key={key} label={label}>
          <ValidatedTextInput
            value={settings[key] as string}
            label={`Ultimate S/R ${label}`}
            validate={isValidScriptColor}
            onCommit={(value) => patch({ [key]: value })}
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
