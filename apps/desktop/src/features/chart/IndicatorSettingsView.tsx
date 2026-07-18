import { NavBar } from '../../design/components/NavBar';
import { Sheet } from '../../design/components/Sheet';
import { Stepper } from '../../design/components/Stepper';
import { Toggle } from '../../design/components/Toggle';
import { Format } from '../../design/format';
import type { IndicatorSettings } from './indicatorSettings';

interface IndicatorSettingsViewProps {
  settings: IndicatorSettings;
  onChange: (settings: IndicatorSettings) => void;
  onDismiss: () => void;
}

/** Indicator toggles and parameters; changes apply and persist immediately. */
export function IndicatorSettingsView({ settings, onChange, onDismiss }: IndicatorSettingsViewProps) {
  const patch = (partial: Partial<IndicatorSettings>) => onChange({ ...settings, ...partial });

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
          title="Indicators"
          trailing={
            <button className="navbar-text-button" onClick={onDismiss}>
              Done
            </button>
          }
        />
        <div className="sheet-body grouped-list hide-scrollbar">
          <div className="grouped-section">
            <div className="section-header">Price Overlays</div>
            <div className="section-card">
              <div className="grouped-row">
                <span>SMA</span>
                <span className="row-value">
                  <Toggle on={settings.smaEnabled} onChange={(on) => patch({ smaEnabled: on })} />
                </span>
              </div>
              {settings.smaEnabled ? (
                <div className="grouped-row">
                  <span>Period: {settings.smaPeriod}</span>
                  <span className="row-value">
                    <Stepper
                      value={settings.smaPeriod}
                      min={2}
                      max={200}
                      onChange={(value) => patch({ smaPeriod: value })}
                    />
                  </span>
                </div>
              ) : null}

              <div className="grouped-row">
                <span>EMA</span>
                <span className="row-value">
                  <Toggle on={settings.emaEnabled} onChange={(on) => patch({ emaEnabled: on })} />
                </span>
              </div>
              {settings.emaEnabled ? (
                <div className="grouped-row">
                  <span>Period: {settings.emaPeriod}</span>
                  <span className="row-value">
                    <Stepper
                      value={settings.emaPeriod}
                      min={2}
                      max={200}
                      onChange={(value) => patch({ emaPeriod: value })}
                    />
                  </span>
                </div>
              ) : null}

              <div className="grouped-row">
                <span>VWAP</span>
                <span className="row-value">
                  <Toggle on={settings.vwapEnabled} onChange={(on) => patch({ vwapEnabled: on })} />
                </span>
              </div>

              <div className="grouped-row">
                <span>Volume</span>
                <span className="row-value">
                  <Toggle
                    on={settings.volumeEnabled}
                    onChange={(on) => patch({ volumeEnabled: on })}
                  />
                </span>
              </div>

              <div className="grouped-row">
                <span>Bollinger Bands</span>
                <span className="row-value">
                  <Toggle
                    on={settings.bollingerEnabled}
                    onChange={(on) => patch({ bollingerEnabled: on })}
                  />
                </span>
              </div>
              {settings.bollingerEnabled ? (
                <>
                  <div className="grouped-row">
                    <span>Period: {settings.bollingerPeriod}</span>
                    <span className="row-value">
                      <Stepper
                        value={settings.bollingerPeriod}
                        min={5}
                        max={100}
                        onChange={(value) => patch({ bollingerPeriod: value })}
                      />
                    </span>
                  </div>
                  <div className="grouped-row">
                    <span>Width: {Format.price(settings.bollingerMultiplier, 1)}σ</span>
                    <span className="row-value">
                      <Stepper
                        value={settings.bollingerMultiplier}
                        min={0.5}
                        max={4}
                        step={0.5}
                        onChange={(value) => patch({ bollingerMultiplier: value })}
                      />
                    </span>
                  </div>
                </>
              ) : null}
            </div>
          </div>

          <div className="grouped-section">
            <div className="section-header">Sub-Panes</div>
            <div className="section-card">
              <div className="grouped-row">
                <span>RSI</span>
                <span className="row-value">
                  <Toggle on={settings.rsiEnabled} onChange={(on) => patch({ rsiEnabled: on })} />
                </span>
              </div>
              {settings.rsiEnabled ? (
                <div className="grouped-row">
                  <span>Period: {settings.rsiPeriod}</span>
                  <span className="row-value">
                    <Stepper
                      value={settings.rsiPeriod}
                      min={2}
                      max={50}
                      onChange={(value) => patch({ rsiPeriod: value })}
                    />
                  </span>
                </div>
              ) : null}

              <div className="grouped-row">
                <span>MACD (12, 26, 9)</span>
                <span className="row-value">
                  <Toggle on={settings.macdEnabled} onChange={(on) => patch({ macdEnabled: on })} />
                </span>
              </div>

              <div className="grouped-row">
                <span>Stochastic</span>
                <span className="row-value">
                  <Toggle
                    on={settings.stochEnabled}
                    onChange={(on) => patch({ stochEnabled: on })}
                  />
                </span>
              </div>
              {settings.stochEnabled ? (
                <>
                  <div className="grouped-row">
                    <span>%K Period: {settings.stochKPeriod}</span>
                    <span className="row-value">
                      <Stepper
                        value={settings.stochKPeriod}
                        min={5}
                        max={50}
                        onChange={(value) => patch({ stochKPeriod: value })}
                      />
                    </span>
                  </div>
                  <div className="grouped-row">
                    <span>%K Smoothing: {settings.stochKSmooth}</span>
                    <span className="row-value">
                      <Stepper
                        value={settings.stochKSmooth}
                        min={1}
                        max={10}
                        onChange={(value) => patch({ stochKSmooth: value })}
                      />
                    </span>
                  </div>
                  <div className="grouped-row">
                    <span>%D Period: {settings.stochDPeriod}</span>
                    <span className="row-value">
                      <Stepper
                        value={settings.stochDPeriod}
                        min={1}
                        max={10}
                        onChange={(value) => patch({ stochDPeriod: value })}
                      />
                    </span>
                  </div>
                </>
              ) : null}

              <div className="grouped-row">
                <span>ATR</span>
                <span className="row-value">
                  <Toggle on={settings.atrEnabled} onChange={(on) => patch({ atrEnabled: on })} />
                </span>
              </div>
              {settings.atrEnabled ? (
                <div className="grouped-row">
                  <span>Period: {settings.atrPeriod}</span>
                  <span className="row-value">
                    <Stepper
                      value={settings.atrPeriod}
                      min={2}
                      max={50}
                      onChange={(value) => patch({ atrPeriod: value })}
                    />
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
