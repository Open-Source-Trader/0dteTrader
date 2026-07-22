import { memo, type ReactNode } from 'react';
import { Menu } from '../../design/components/Menu';
import { NavBar } from '../../design/components/NavBar';
import { Sheet } from '../../design/components/Sheet';
import { Stepper } from '../../design/components/Stepper';
import { Toggle } from '../../design/components/Toggle';
import { ChevronDownIcon } from '../../design/icons';
import type {
  TwcBannerPosition,
  TwcBannerSize,
  TwcFibMethod,
  TwcFlipLevel,
  TwcFlipTrigger,
  TwcGannScaleMethod,
  TwcHeatmapSettings,
  TwcLabelPosition,
  TwcPivotSource,
  TwcRejectionEnvelope,
  TwcSource,
} from './twc/twcSettings';
import { DEFAULT_TWC_SETTINGS, TWC_MTF_TIMEFRAMES } from './twc/twcSettings';

interface TwcSettingsViewProps {
  settings: TwcHeatmapSettings;
  onChange: (settings: TwcHeatmapSettings) => void;
  onBack: () => void;
  onDismiss: () => void;
}

/**
 * Dedicated TradingView-style settings screen for the TWC Heatmap V5 script
 * indicator: every phase-1 input from the Pine script, grouped like its input
 * groups. Changes apply and persist immediately.
 */
export const TwcSettingsView = memo(function TwcSettingsView({
  settings,
  onChange,
  onBack,
  onDismiss,
}: TwcSettingsViewProps) {
  const patch = (partial: Partial<TwcHeatmapSettings>) => onChange({ ...settings, ...partial });

  const toggleRow = (label: string, key: keyof TwcHeatmapSettings): ReactNode => (
    <div className="grouped-row">
      <span>{label}</span>
      <span className="row-value">
        <Toggle on={settings[key] as boolean} onChange={(on) => patch({ [key]: on })} />
      </span>
    </div>
  );

  const stepperRow = (
    label: string,
    key: keyof TwcHeatmapSettings,
    min: number,
    max: number,
    step = 1,
    decimals = 0,
  ): ReactNode => (
    <div className="grouped-row param-row">
      <span>
        {label}: {(settings[key] as number).toFixed(decimals)}
      </span>
      <span className="row-value">
        <Stepper
          value={settings[key] as number}
          min={min}
          max={max}
          step={step}
          onChange={(value) => patch({ [key]: Number(value.toFixed(4)) })}
        />
      </span>
    </div>
  );

  const menuRow = <T extends string>(
    label: string,
    key: keyof TwcHeatmapSettings,
    options: readonly T[],
  ): ReactNode => (
    <div className="grouped-row">
      <span>{label}</span>
      <span className="row-value">
        <Menu
          trigger={
            <button
              className="row-menu-trigger"
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              {settings[key] as string}
              <ChevronDownIcon size={11} />
            </button>
          }
          items={options.map((option) => ({
            key: option,
            label: option,
            checked: settings[key] === option,
            onSelect: () => patch({ [key]: option }),
          }))}
        />
      </span>
    </div>
  );

  const textRow = (label: string, key: keyof TwcHeatmapSettings): ReactNode => (
    <div className="grouped-row param-row">
      <span style={{ flexShrink: 0, marginRight: 12 }}>{label}</span>
      <input
        className="row-text-input"
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          textAlign: 'right',
          color: 'var(--label-secondary)',
          font: 'inherit',
        }}
        value={settings[key] as string}
        onChange={(event) => patch({ [key]: event.target.value })}
      />
    </div>
  );

  const section = (title: string, children: ReactNode): ReactNode => (
    <div className="grouped-section">
      <div className="section-header">{title}</div>
      <div className="section-card">{children}</div>
    </div>
  );

  const sources: readonly TwcSource[] = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];
  const fibMethods: readonly TwcFibMethod[] = ['Simple Pivots', 'Volume Filtered'];
  const labelPositions: readonly TwcLabelPosition[] = ['Left', 'Right'];
  const pivotSources: readonly TwcPivotSource[] = ['Wick', 'Body'];
  const flipTriggers: readonly TwcFlipTrigger[] = ['Wick', 'Close'];
  const flipLevels: readonly TwcFlipLevel[] = ['0.000', '±0.618', '±1.618'];
  const gannScales: readonly TwcGannScaleMethod[] = [
    'Swing-Relative (Original)',
    'Auto (ATR-based)',
    'Manual',
  ];
  const envelopes: readonly TwcRejectionEnvelope[] = ['2 Std', '3 Std'];
  const bannerPositions: readonly TwcBannerPosition[] = [
    'Top Left',
    'Top Center',
    'Top Right',
    'Middle Left',
    'Middle Center',
    'Middle Right',
    'Bottom Left',
    'Bottom Center',
    'Bottom Right',
  ];
  const bannerSizes: readonly TwcBannerSize[] = ['Tiny', 'Small', 'Normal', 'Large'];

  return (
    <Sheet detent="large" onDismiss={onDismiss}>
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
          title="TWC Heatmap V5"
          leading={
            <button className="navbar-text-button" onClick={onBack}>
              Back
            </button>
          }
          trailing={
            <button className="navbar-text-button" onClick={onDismiss}>
              Done
            </button>
          }
        />
        <div className="sheet-body grouped-list hide-scrollbar">
          {section(
            'Core Models',
            <>
              {menuRow('Source', 'source', sources)}
              {stepperRow('Linear Regression Length', 'lenLR', 3, 200)}
              {stepperRow('Holt-Winters Alpha', 'hwAlpha', 0.01, 1, 0.01, 2)}
              {stepperRow('Holt-Winters Beta', 'hwBeta', 0.01, 1, 0.01, 2)}
              {stepperRow('Center of Gravity Length', 'lenCoG', 3, 100)}
            </>,
          )}
          {section(
            'Hidden Markov Model',
            <>
              {stepperRow('Lookback (z-norm)', 'hmmLook', 10, 200)}
              {stepperRow('Self-Persistence', 'hmmStay', 0.5, 0.99, 0.01, 2)}
            </>,
          )}
          {section(
            'VWAP Z-Score',
            <>
              {stepperRow('Lookback', 'vwapLook', 5, 200)}
              {stepperRow('Stretch Threshold |z|', 'vwapWarn', 0.5, 4, 0.1, 1)}
              {toggleRow('VWAP Rip Markers', 'showVwapRip')}
            </>,
          )}
          {section(
            'MSI / Signal Logic',
            <>
              {stepperRow('Bullish Threshold (%)', 'msiBullThr', 50, 99)}
              {stepperRow('Bearish Threshold (%)', 'msiBearThr', 1, 50)}
            </>,
          )}
          {section(
            'Visuals',
            <>
              {toggleRow('Regime Candles', 'colorBars')}
              {toggleRow('Show Signal Markers', 'showMarkers')}
              {toggleRow('Hide Regime Candles when not aligned', 'hideUnalignedCandles')}
            </>,
          )}
          {section(
            'Fibonacci Levels',
            <>
              {toggleRow('Show Fibonacci Levels', 'showFibonacci')}
              {settings.showFibonacci ? (
                <>
                  {stepperRow('Zigzag Period', 'fibPeriod', 5, 50)}
                  {menuRow('Detection Method', 'fibMethod', fibMethods)}
                  {menuRow('Level Label Position', 'fibLabelPosition', labelPositions)}
                  {toggleRow('Ratio Labels', 'showFibRatioLabels')}
                  {toggleRow('Price Labels', 'showFibPriceLabels')}
                  {menuRow('Pivot Price Source', 'fibPivotSource', pivotSources)}
                  {toggleRow('Use Standard Fibonacci Ratios', 'useStandardRatios')}
                </>
              ) : null}
            </>,
          )}
          {section(
            'Fib Flip / Reject',
            <>
              {toggleRow('Instant flip on threshold break', 'flipEnable')}
              {settings.flipEnable ? (
                <>
                  {menuRow('Trigger uses', 'flipTrigger', flipTriggers)}
                  {menuRow('Level', 'flipLevel', flipLevels)}
                </>
              ) : null}
            </>,
          )}
          {section(
            'Profit Target Zones',
            <>
              {toggleRow('Shade target bands', 'shadeBands')}
              {toggleRow('Profit target labels', 'showPTLabels')}
              {toggleRow('Extensions only (≥1.000)', 'ptExtensionsOnly')}
              {textRow('Label prefix', 'ptPrefix')}
              {toggleRow('Always show first target zone', 'ptAlwaysShowFirst')}
            </>,
          )}
          {section(
            'Gann Square',
            <>
              {toggleRow('Show Gann Square (4-corner fans)', 'showGannFan')}
              {toggleRow('Show Gann Box Frame', 'showGannBox')}
              {settings.showGannFan ? (
                <>
                  {menuRow('Scale Method', 'gannScaleMethod', gannScales)}
                  {settings.gannScaleMethod === 'Manual'
                    ? stepperRow('Price Units per Bar', 'gannManualScale', 0.1, 100, 0.1, 1)
                    : null}
                  {settings.gannScaleMethod === 'Auto (ATR-based)'
                    ? stepperRow('ATR Multiplier', 'gannATRMultiplier', 0.01, 1, 0.01, 2)
                    : null}
                  {toggleRow('1x1 (45°)', 'gann1x1')}
                  {toggleRow('2x1 (63.4°)', 'gann2x1')}
                  {toggleRow('1x2 (26.6°)', 'gann1x2')}
                  {toggleRow('3x1 (71.6°)', 'gann3x1')}
                  {toggleRow('1x3 (18.4°)', 'gann1x3')}
                  {toggleRow('4x1 (76°)', 'gann4x1')}
                  {toggleRow('1x4 (14°)', 'gann1x4')}
                  {toggleRow('8x1 (82.9°)', 'gann8x1')}
                  {toggleRow('1x8 (7.1°)', 'gann1x8')}
                </>
              ) : null}
            </>,
          )}
          {section(
            'CTF SuperTrend',
            <>
              {stepperRow('ATR Length', 'ctfAtrLength', 1, 50)}
              {stepperRow('Multiplier', 'ctfMultiplier', 0.1, 10, 0.1, 1)}
              {toggleRow('Show CTF Line', 'showCTFLine')}
              {toggleRow('Show CTF Buy/Sell Labels', 'showBuySellSignals')}
            </>,
          )}
          {section(
            'Highlight',
            <>
              {toggleRow('Show Transparent Highlight', 'showTransparentHighlight')}
              {settings.showTransparentHighlight
                ? stepperRow('Highlight Transparency', 'highlightTransparency', 0, 100, 1)
                : null}
            </>,
          )}
          {section(
            'HTF Stack (6x timeframe)',
            <>
              {toggleRow('Show HTF x3', 'showHTF3')}
              {toggleRow('Show HTF x4', 'showHTF4')}
              {toggleRow('Use Custom HTF ATR Length', 'useCustomHTFAtrLength')}
              {settings.useCustomHTFAtrLength
                ? stepperRow('HTF ATR Length', 'htfAtrLength', 1, 50)
                : null}
            </>,
          )}
          {section(
            'Bollinger Bands',
            <>
              {toggleRow('Show 2 Std Bands', 'showBB2')}
              {toggleRow('Show 3 Std Bands', 'showBB3')}
              {toggleRow('Envelope Rejection Triangles', 'showEnvelopeRejection')}
              {settings.showEnvelopeRejection
                ? menuRow('Rejection Envelope', 'rejectionEnvelope', envelopes)
                : null}
            </>,
          )}
          {section(
            'SuperTrend Gate / MACD Alignment',
            <>
              {toggleRow('MACD + SuperTrend Signals', 'showMacdAlign')}
              {settings.showMacdAlign ? (
                <>
                  {stepperRow('MACD Fast', 'macdFast', 1, 50)}
                  {stepperRow('MACD Slow', 'macdSlow', 1, 200)}
                  {stepperRow('MACD Signal', 'macdSignal', 1, 50)}
                </>
              ) : null}
            </>,
          )}
          {section(
            'Order Blocks',
            <>
              {toggleRow('Swing Order Blocks', 'showSwingOrderBlocks')}
              {settings.showSwingOrderBlocks
                ? stepperRow('Swing Blocks Shown', 'swingOrderBlocksSize', 1, 20)
                : null}
              {toggleRow('Internal Order Blocks', 'showInternalOrderBlocks')}
              {settings.showInternalOrderBlocks
                ? stepperRow('Internal Blocks Shown', 'internalOrderBlocksSize', 1, 20)
                : null}
              {menuRow('Filter', 'orderBlockFilter', ['Atr', 'Cumulative Mean Range'] as const)}
              {menuRow('Mitigation', 'orderBlockMitigation', ['Close', 'High/Low'] as const)}
              {stepperRow('Swing Length', 'swingsLength', 10, 100)}
            </>,
          )}
          {section('Premium & Discount Zones', toggleRow('Show Zones', 'showPremiumDiscountZones'))}
          {section(
            'Unified Confluence Engine',
            <>
              {toggleRow('Show Confluence Markers (CL/CS)', 'showConfMarkers')}
              {toggleRow('Gate signals by score', 'useConfluenceGate')}
              {stepperRow('Bullish Score Threshold', 'confBullThr', 50, 100)}
              {stepperRow('Bearish Score Threshold', 'confBearThr', 0, 50)}
              {menuRow('Timeframe 1', 'mtfTf1', TWC_MTF_TIMEFRAMES)}
              {menuRow('Timeframe 2', 'mtfTf2', TWC_MTF_TIMEFRAMES)}
              {menuRow('Timeframe 3', 'mtfTf3', TWC_MTF_TIMEFRAMES)}
              {menuRow('Timeframe 4', 'mtfTf4', TWC_MTF_TIMEFRAMES)}
              {menuRow('Timeframe 5', 'mtfTf5', TWC_MTF_TIMEFRAMES)}
              {menuRow('Timeframe 6', 'mtfTf6', TWC_MTF_TIMEFRAMES)}
            </>,
          )}
          {section(
            'Bias Banner',
            <>
              {toggleRow('Show Bias Banner', 'showBiasBanner')}
              {settings.showBiasBanner ? (
                <>
                  {menuRow('Position', 'biasBannerPosition', bannerPositions)}
                  {menuRow('Text Size', 'biasBannerSize', bannerSizes)}
                  {textRow('Long Text', 'biasLongText')}
                  {textRow('Short Text', 'biasShortText')}
                  {textRow('Chop Text', 'biasChopText')}
                </>
              ) : null}
            </>,
          )}
          <div className="grouped-section">
            <div className="section-card">
              <button
                className="grouped-row button-row"
                onClick={() => onChange({ ...DEFAULT_TWC_SETTINGS, enabled: settings.enabled })}
              >
                Reset to Defaults
              </button>
            </div>
          </div>
        </div>
      </div>
    </Sheet>
  );
});
